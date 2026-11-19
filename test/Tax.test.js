// test/Tax.test.js
// Sales tax. It is a share of the ticket's list price, held in the escrow like Xao's
// fee, paid to the venue or promoter the show names when the show is completed, and
// handed back with the ticket if the show is cancelled.
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  USDC, ONE_DAY, PayoutKind, Resolution, TICKET_PRICE,
  tier, deploySystem, showConfig, createShow,
} = require("./helpers/show");

const TAX_BPS = 800;                       // 8%
const TAX_ON_TICKET = USDC(4);             // 8% of $50
const FEE_ON_TICKET = USDC(1);             // 2% of $50
const GAS = USDC(1);

describe("Sales tax", function () {
  let sys, usdc, promoter, artist, treasury, fan, fan2, stranger;
  let t0, showEnd;

  async function newShow(name, overrides = {}) {
    const { tickets, ...rest } = overrides;
    const b = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
      anchors: { termsHash: ethers.id(name) },
      funding: [],
      tiers: [tier({ quantity: 100 })],
      payoutRules: [{ to: artist.address, kind: PayoutKind.FixedAmount, value: USDC(10), notBefore: showEnd, isGuarantee: false }],
      sweep: { recipients: [artist.address], bps: [10_000], notBefore: showEnd },
      tickets: { salesTaxBPS: TAX_BPS, taxReceiver: promoter.address, ...tickets },
      ...rest,
    }));
    await b.show.connect(promoter).signTerms();
    await b.show.connect(artist).signTerms();
    return b;
  }

  async function buy(b, who, count = 1, tierId = 0) {
    const price = (await b.ticket.tiers(tierId)).priceUSDC;
    await usdc.mint(who.address, price * BigInt(count));
    await usdc.connect(who).approve(b.ticket.target, price * BigInt(count));
    for (let i = 0; i < count; i++) await b.ticket.connect(who).buyTicket(tierId);
  }

  beforeEach(async function () {
    [, promoter, artist, treasury, fan, fan2, stranger] = await ethers.getSigners();
    sys = await deploySystem();
    usdc = sys.usdc;
    t0 = await time.latest();
    showEnd = t0 + 30 * ONE_DAY + 7_200;
  });

  // ─── WHILE TICKETS ARE SELLING ──────────────────────────────────────────
  describe("while tickets sell", function () {
    it("sets the tax aside on every ticket, apart from the money for the show", async function () {
      const b = await newShow("hold");
      const before = await usdc.balanceOf(treasury.address);
      await expect(b.ticket.connect(fan).buyTicket(0)).to.be.reverted;      // no allowance yet
      await buy(b, fan, 2);

      expect(await usdc.balanceOf(treasury.address)).to.equal(before + 2n * GAS);
      expect(await usdc.balanceOf(b.escrow.target)).to.equal(2n * (TICKET_PRICE - GAS));     // $98
      expect(await b.escrow.taxAccrued()).to.equal(2n * TAX_ON_TICKET);
      expect(await b.escrow.protocolFeeAccrued()).to.equal(2n * FEE_ON_TICKET);
      expect(await b.escrow.totalFunded()).to.equal(2n * (TICKET_PRICE - GAS - FEE_ON_TICKET - TAX_ON_TICKET));  // $88 for the show
      expect(await b.escrow.distributable()).to.equal(USDC(88));
      expect(await b.escrow.taxReceiver()).to.equal(promoter.address);
    });

    it("announces the tax it holds, and records it with the ticket as part of what a refund returns", async function () {
      const b = await newShow("record");
      await usdc.mint(fan.address, TICKET_PRICE);
      await usdc.connect(fan).approve(b.ticket.target, TICKET_PRICE);
      await expect(b.ticket.connect(fan).buyTicket(0)).to.emit(b.escrow, "TaxHeld").withArgs(TAX_ON_TICKET);
      expect(await b.ticket.getRefundBasis(1)).to.deep.equal([TICKET_PRICE - GAS, FEE_ON_TICKET, TAX_ON_TICKET]);
      expect(await b.ticket.getPricePaid(1)).to.equal(TICKET_PRICE);
      expect(await b.ticket.salesTaxBPS()).to.equal(TAX_BPS);
    });

    it("can never be spent on a payout: the tax is not part of what the show can pay out", async function () {
      const rule = (value) => [{ to: artist.address, kind: PayoutKind.FixedAmount, value, notBefore: t0 + 15 * ONE_DAY, isGuarantee: true }];
      const taxed   = await newShow("taxed",   { payoutRules: rule(USDC(90)) });
      const untaxed = await newShow("untaxed", { payoutRules: rule(USDC(90)), tickets: { salesTaxBPS: 0, taxReceiver: ethers.ZeroAddress } });
      for (const b of [taxed, untaxed]) await buy(b, fan, 2);

      await time.increaseTo(t0 + 15 * ONE_DAY);
      // $98 in the escrow: with no tax $96 is free ($98 less Xao's $2), with tax only $88.
      await expect(untaxed.escrow.connect(stranger).executeAvailablePayouts()).to.emit(untaxed.escrow, "PayoutExecuted");
      await expect(taxed.escrow.connect(stranger).executeAvailablePayouts()).to.emit(taxed.escrow, "PayoutSkipped").withArgs(0, USDC(90), USDC(88));
      expect(await taxed.escrow.taxAccrued()).to.equal(2n * TAX_ON_TICKET);
    });

    it("takes the tax from the list price in the same way as the library: cheap tickets give it up last", async function () {
      const lib = await (await ethers.getContractFactory("MockDiscountMath")).deploy();
      const prices = [USDC(0.5), USDC(1), USDC(1.5), USDC(2.5), USDC(20), USDC(49.99)];
      const b = await newShow("prices", {
        tiers: prices.map((p) => tier({ priceUSDC: p, quantity: 10 })),
      });
      let expectedTax = 0n;
      for (let i = 0; i < prices.length; i++) {
        await buy(b, fan, 1, i);
        const parts = await lib.breakdown(prices[i], TAX_BPS, 200, GAS);
        expect(await b.ticket.getRefundBasis(i + 1), `price ${prices[i]}`).to.deep.equal([prices[i] - parts.gas, parts.fee, parts.tax]);
        expectedTax += parts.tax;
      }
      expect(await b.escrow.taxAccrued()).to.equal(expectedTax);
      expect(expectedTax).to.be.gt(0);
    });
  });

  // ─── WHEN THE SHOW IS COMPLETED ─────────────────────────────────────────
  describe("when the show is completed", function () {
    it("pays the tax to the receiver, Xao's fee to the treasury, and the rest to the show's payouts", async function () {
      const b = await newShow("complete");
      await buy(b, fan, 2);
      const tBefore = await usdc.balanceOf(treasury.address);
      const pBefore = await usdc.balanceOf(promoter.address);
      const aBefore = await usdc.balanceOf(artist.address);

      await time.increaseTo(showEnd);
      await expect(b.escrow.connect(stranger).executeFinalSweep())
        .to.emit(b.escrow, "TaxPaid").withArgs(promoter.address, USDC(8))
        .and.to.emit(b.escrow, "ProtocolFeePaid").withArgs(USDC(2));

      expect(await usdc.balanceOf(promoter.address)).to.equal(pBefore + USDC(8));
      expect(await usdc.balanceOf(treasury.address)).to.equal(tBefore + USDC(2));
      expect(await usdc.balanceOf(artist.address)).to.equal(aBefore + USDC(88));       // $10 payout + $78 sweep
      expect(await b.escrow.taxAccrued()).to.equal(0);
      expect(await usdc.balanceOf(b.escrow.target)).to.equal(0);
    });

    it("is not an earning: the receiver's earnings ledger shows none of it", async function () {
      const b = await newShow("ledger");
      await buy(b, fan, 2);
      await time.increaseTo(showEnd);
      await b.escrow.connect(stranger).executeFinalSweep();
      for (let s = 0; s < 6; s++) expect(await b.escrow.earnedBy(promoter.address, s)).to.equal(0);
    });

    it("pays the tax out when a dispute is settled, and the winner gets only what is left", async function () {
      const b = await newShow("dispute");
      await buy(b, fan, 2);
      const pBefore = await usdc.balanceOf(promoter.address);
      const aBefore = await usdc.balanceOf(artist.address);
      await b.escrow.connect(artist).raiseDispute();
      await b.escrow.connect(artist).resolveDispute(Resolution.ReleaseToPartyB);
      await expect(b.escrow.connect(promoter).resolveDispute(Resolution.ReleaseToPartyB))
        .to.emit(b.escrow, "TaxPaid").withArgs(promoter.address, USDC(8));
      expect(await usdc.balanceOf(promoter.address)).to.equal(pBefore + USDC(8));
      expect(await usdc.balanceOf(artist.address)).to.equal(aBefore + USDC(88));
    });

    it("the receiver can be partyB as well", async function () {
      const b = await newShow("partyB", { tickets: { taxReceiver: artist.address } });
      await buy(b, fan, 1);
      expect(await b.escrow.taxReceiver()).to.equal(artist.address);
      await time.increaseTo(showEnd);
      await expect(b.escrow.connect(stranger).executeFinalSweep()).to.emit(b.escrow, "TaxPaid").withArgs(artist.address, TAX_ON_TICKET);
    });
  });

  // ─── WHEN THE SHOW IS CANCELLED ─────────────────────────────────────────
  describe("when the show is cancelled", function () {
    it("gives the tax back with the ticket: the buyer loses only the gas, the receiver gets nothing", async function () {
      const b = await newShow("cancel-full");
      await buy(b, fan, 2);
      const fanBefore = await usdc.balanceOf(fan.address);
      const pBefore = await usdc.balanceOf(promoter.address);
      const tBefore = await usdc.balanceOf(treasury.address);

      await b.escrow.connect(artist).cancel();
      await b.escrow.connect(stranger).continueRefunds(5);
      expect(await usdc.balanceOf(fan.address)).to.equal(fanBefore + 2n * (TICKET_PRICE - GAS));       // $49 each, tax and fee included
      expect(await b.escrow.taxAccrued()).to.equal(0);
      expect(await b.escrow.protocolFeeAccrued()).to.equal(0);

      await b.escrow.connect(stranger).finalizeCancellationPayout();
      expect(await usdc.balanceOf(promoter.address)).to.equal(pBefore);
      expect(await usdc.balanceOf(treasury.address)).to.equal(tBefore);
    });

    it("keeps the tax of any part that is not refunded, and pays it to the receiver", async function () {
      const b = await newShow("cancel-half", { defaultCancelRefundBps: 5_000 });
      await buy(b, fan, 2);
      await b.escrow.connect(artist).cancel();
      await b.escrow.connect(stranger).continueRefunds(5);
      // Half of each ticket's tax and fee came back with the refund; half stays.
      expect(await b.escrow.taxAccrued()).to.equal(USDC(4));
      expect(await b.escrow.protocolFeeAccrued()).to.equal(USDC(1));
      await expect(b.escrow.connect(stranger).finalizeCancellationPayout())
        .to.emit(b.escrow, "TaxPaid").withArgs(promoter.address, USDC(4))
        .and.to.emit(b.escrow, "ProtocolFeePaid").withArgs(USDC(1));
    });
  });

  // ─── SETTING IT UP ──────────────────────────────────────────────────────
  describe("setting the tax up", function () {
    const make = (tickets) => createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
      anchors: { termsHash: ethers.id("setup-" + Math.random()) }, funding: [], tiers: [tier({ quantity: 10 })], tickets,
    }));

    it("needs a receiver, and the receiver must be partyA or partyB", async function () {
      await expect(make({ salesTaxBPS: TAX_BPS, taxReceiver: ethers.ZeroAddress })).to.be.revertedWithCustomError(sys.factory, "InvalidTaxReceiver");
      await expect(make({ salesTaxBPS: TAX_BPS, taxReceiver: stranger.address })).to.be.revertedWithCustomError(sys.factory, "InvalidTaxReceiver");
      await make({ salesTaxBPS: TAX_BPS, taxReceiver: promoter.address });
      await make({ salesTaxBPS: TAX_BPS, taxReceiver: artist.address });
    });

    it("a show with only one party cannot name the empty partyB as receiver", async function () {
      const cfg = showConfig(promoter, null, t0, {
        anchors: { termsHash: ethers.id("solo") }, funding: [], tiers: [tier({ quantity: 10 })],
        tickets: { salesTaxBPS: TAX_BPS, taxReceiver: ethers.ZeroAddress },
        payoutRules: [{ to: promoter.address, kind: PayoutKind.FixedAmount, value: USDC(1), notBefore: t0 + ONE_DAY, isGuarantee: false }],
      });
      await expect(createShow(sys.factory, promoter, cfg)).to.be.revertedWithCustomError(sys.factory, "InvalidTaxReceiver");
    });

    it("no tax needs no receiver; a tax above 100% is refused", async function () {
      await make({ salesTaxBPS: 0, taxReceiver: ethers.ZeroAddress });
      await expect(make({ salesTaxBPS: 10_001, taxReceiver: promoter.address })).to.be.revertedWithCustomError(sys.factory, "InvalidSalesTax");
    });

    it("a show without tickets ignores the tax settings", async function () {
      await make({ ticketsEnabled: false, salesTaxBPS: TAX_BPS, taxReceiver: ethers.ZeroAddress });
    });

    it("the tax rate and receiver are stored with the show's ticket terms", async function () {
      const b = await newShow("stored");
      const terms = await b.show.ticketTerms();
      expect(terms.salesTaxBPS).to.equal(TAX_BPS);
      expect(terms.taxReceiver).to.equal(promoter.address);
    });
  });
});
