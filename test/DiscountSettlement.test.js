// test/DiscountSettlement.test.js
// What a discount funder owes is taken from what the show pays that funder: from a
// guarantee when it is paid, and from its share of the final sweep. Everyone else is
// paid exactly what they would have been paid without any discount.
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { ONE_DAY, PayoutKind, tier, deploySystem, showConfig, createShow } = require("./helpers/show");

const $ = (n) => ethers.parseUnits(String(n), 6);
const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;
const GA = 0;
const TAX = 800, FEE = 200, GAS = $(1);
const TICKET_REVENUE = 1, GUARANTEE = 0, OTHER = 5;                 // earnings streams
const mask = (...t) => t.reduce((m, x) => m | (1n << BigInt(x)), 0n);
const NONE = { availableMask: 0, grantedMasks: [], commitment: ZERO_BYTES32 };

describe("Settling discount debts", function () {
  let sys, usdc, membership, signers;
  let promoter, artist, treasury, fan, bandA, bandB, stranger;
  let t0, showEnd;

  const memberCfg = (o = {}) => ({
    membership: membership.target, minTierPriority: 0, isPercent: false, amount: $(2), priority: 1,
    allowedTypeMask: mask(GA), budget: 0, redemptionCap: 0, effectiveFrom: 0, effectiveTo: 0, ...o,
  });

  // [promoter, artist, bandA, bandB] in basis points
  const sweepOf = (bps) => ({ recipients: [promoter.address, artist.address, bandA.address, bandB.address], bps, notBefore: showEnd });

  async function newShow(name, { discounts = true, program, sweep = [3000, 4000, 2000, 1000], payoutRules, tickets } = {}) {
    const b = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
      anchors: { termsHash: ethers.id(name) }, funding: [],
      tiers: [tier({ quantity: 100, priceUSDC: $(20) })],
      tickets: { discountsEnabled: discounts, salesTaxBPS: TAX, taxReceiver: promoter.address, ...tickets },
      sweep: sweepOf(sweep),
      ...(payoutRules ? { payoutRules } : { payoutRules: [] }),
    }));
    if (discounts && program) {
      await b.discounts.connect(promoter).configureMembershipProgram(program);
      await b.discounts.connect(promoter).proposeFunder(1, bandA.address, 0);
      await b.discounts.connect(bandA).authorizeFunding(1, $(1_000));
    }
    await b.show.connect(promoter).signTerms();
    await b.show.connect(artist).signTerms();
    return b;
  }

  async function buyAs(b, who, discounted) {
    if (discounted) {
      const price = (await b.ticket.tiers(GA)).priceUSDC;
      const [q, h] = await b.discounts.quote(who.address, [GA], [price], TAX, FEE, GAS, NONE);
      await usdc.mint(who.address, q.checkoutTotal);
      await usdc.connect(who).approve(b.ticket.target, q.checkoutTotal);
      return b.ticket.connect(who).buyTickets([GA], NONE, h, q.checkoutTotal);
    }
    const price = (await b.ticket.tiers(GA)).priceUSDC;
    await usdc.mint(who.address, price);
    await usdc.connect(who).approve(b.ticket.target, price);
    return b.ticket.connect(who).buyTicket(GA);
  }
  const earned = (b, who, stream = TICKET_REVENUE) => b.escrow.earnedBy(who.address, stream);

  beforeEach(async function () {
    signers = await ethers.getSigners();
    [, promoter, artist, treasury, fan, , , bandA, bandB, stranger] = signers;
    sys = await deploySystem();
    usdc = sys.usdc;
    t0 = await time.latest();
    showEnd = t0 + 30 * ONE_DAY + 7_200;

    const mImpl = await (await ethers.getContractFactory("FanMembership")).deploy();
    const mFactory = await (await ethers.getContractFactory("FanMembershipFactory")).deploy(mImpl.target);
    const r = await (await mFactory.connect(promoter).createProgram({
      issuer: promoter.address, scopeType: 0, scopeRef: artist.address, name: "Fans", symbol: "F", baseURI: "",
      renewable: true, maxSupply: 0, paymentToken: ZERO_ADDRESS, paymentReceiver: ZERO_ADDRESS, saleStart: 0, saleEnd: 0,
    })).wait();
    membership = await ethers.getContractAt("FanMembership", mFactory.interface.parseLog(r.logs.find((l) => l.address === mFactory.target)).args.program);
    await membership.connect(promoter).createTier("Member", "", 1, 365 * ONE_DAY, 0, 0, 0, false);
    for (const w of [fan, ...signers.slice(10, 20)]) await membership.connect(promoter).grantMembership(1, w.address, ZERO_BYTES32, ZERO_BYTES32);
  });

  // ─── A GUARANTEE THAT CARRIES A DEBT ────────────────────────────────────
  describe("a guarantee", function () {
    const guarantee = (value) => [{ to: bandA.address, kind: PayoutKind.FixedAmount, value, notBefore: 0, isGuarantee: true }];

    it("is paid less what the band owes, and the guarantee itself stays $10", async function () {
      const b = await newShow("g1", { program: memberCfg(), payoutRules: guarantee($(10)).map((r) => ({ ...r, notBefore: t0 + 15 * ONE_DAY })) });
      await buyAs(b, fan, true);                                                   // $2 discount, funded by bandA
      expect(await b.discounts.funderDebit(bandA.address)).to.equal($(2));
      await time.increaseTo(t0 + 15 * ONE_DAY);

      const before = await usdc.balanceOf(bandA.address);
      await expect(b.escrow.connect(stranger).executeAvailablePayouts())
        .to.emit(b.escrow, "DebtApplied").withArgs(bandA.address, $(2))
        .and.to.emit(b.escrow, "PayoutExecuted").withArgs(0, bandA.address, $(8));
      expect(await usdc.balanceOf(bandA.address)).to.equal(before + $(8));         // $500-style: $10 less $2
      expect((await b.escrow.getPayoutRules())[0].value).to.equal($(10));          // the signed guarantee is untouched
      expect(await b.escrow.debtApplied(bandA.address)).to.equal($(2));
      expect(await b.escrow.debtOutstanding(bandA.address)).to.equal(0);
      expect(await earned(b, bandA, GUARANTEE)).to.equal($(8));
    });

    it("is skipped until the cash it needs is there: the net, not the guarantee, has to be covered", async function () {
      const b = await newShow("g2", { program: memberCfg(), payoutRules: guarantee($(20)).map((r) => ({ ...r, notBefore: t0 + 15 * ONE_DAY })) });
      await buyAs(b, fan, true);                                                   // the show holds $15
      await time.increaseTo(t0 + 15 * ONE_DAY);
      await expect(b.escrow.connect(stranger).executeAvailablePayouts())
        .to.emit(b.escrow, "PayoutSkipped").withArgs(0, $(18), $(15));              // $20 less the $2 debt
      expect(await b.escrow.debtApplied(bandA.address)).to.equal(0);                // nothing is taken for a payout that did not happen

      await usdc.mint(promoter.address, $(3));
      await usdc.connect(promoter).approve(b.escrow.target, $(3));
      await b.escrow.connect(promoter).deposit($(3));
      await expect(b.escrow.connect(stranger).executeAvailablePayouts()).to.emit(b.escrow, "PayoutExecuted").withArgs(0, bandA.address, $(18));
    });

    it("is taken once, however often payouts are run", async function () {
      const b = await newShow("g3", { program: memberCfg(), payoutRules: guarantee($(10)).map((r) => ({ ...r, notBefore: t0 + 15 * ONE_DAY })) });
      await buyAs(b, fan, true);
      await time.increaseTo(t0 + 15 * ONE_DAY);
      await b.escrow.connect(stranger).executeAvailablePayouts();
      await b.escrow.connect(stranger).executeAvailablePayouts();
      expect(await b.escrow.debtApplied(bandA.address)).to.equal($(2));
    });

    it("never takes more than the guarantee: a bigger debt carries on to the sweep", async function () {
      const b = await newShow("g4", { program: memberCfg({ amount: $(5) }), payoutRules: guarantee($(3)).map((r) => ({ ...r, notBefore: t0 + 15 * ONE_DAY })) });
      await buyAs(b, fan, true);                                                   // bandA owes $5
      await time.increaseTo(t0 + 15 * ONE_DAY);
      await expect(b.escrow.connect(stranger).executeAvailablePayouts()).to.emit(b.escrow, "PayoutExecuted").withArgs(0, bandA.address, 0);
      expect(await b.escrow.debtApplied(bandA.address)).to.equal($(3));
      expect(await b.escrow.debtOutstanding(bandA.address)).to.equal($(2));
      await time.increaseTo(showEnd);
      await b.escrow.connect(stranger).executeFinalSweep();                         // bandA has a share of the sweep too
      expect(await b.escrow.debtOutstanding(bandA.address)).to.equal(0);
    });

    it("debts that arise after a guarantee was paid are collected from the sweep", async function () {
      const b = await newShow("g5", { program: memberCfg(), payoutRules: guarantee($(10)).map((r) => ({ ...r, notBefore: t0 + 15 * ONE_DAY })) });
      await time.increaseTo(t0 + 15 * ONE_DAY);
      await usdc.mint(promoter.address, $(10));
      await usdc.connect(promoter).approve(b.escrow.target, $(10));
      await b.escrow.connect(promoter).deposit($(10));
      await b.escrow.connect(stranger).executeAvailablePayouts();                   // paid in full: no debt yet
      expect(await earned(b, bandA, GUARANTEE)).to.equal($(10));

      await buyAs(b, fan, true);                                                    // the debt only starts now
      await time.increaseTo(showEnd);
      await expect(b.escrow.connect(stranger).executeFinalSweep()).to.emit(b.escrow, "DebtApplied").withArgs(bandA.address, $(2));
    });
  });

  // ─── THE FINAL SWEEP ────────────────────────────────────────────────────
  describe("the final sweep", function () {
    it("takes a funder's debt from its own share, and leaves everyone else exactly what they would have had without discounts", async function () {
      const withDiscounts = await newShow("s-discount", { program: memberCfg() });
      const plainShow = await newShow("s-plain", { discounts: false });
      const members = signers.slice(10, 15);                                          // five members, $2 each
      for (const w of members) await buyAs(withDiscounts, w, true);
      for (const w of members) await buyAs(plainShow, w, false);

      expect(await withDiscounts.discounts.funderDebit(bandA.address)).to.equal($(10));
      await time.increaseTo(showEnd);
      await withDiscounts.escrow.connect(stranger).executeFinalSweep();
      await plainShow.escrow.connect(stranger).executeFinalSweep();

      for (const who of [promoter, artist, bandB]) {
        expect(await earned(withDiscounts, who), who.address).to.equal(await earned(plainShow, who));
      }
      expect(await earned(withDiscounts, bandA)).to.equal((await earned(plainShow, bandA)) - $(10));
      expect(await withDiscounts.escrow.debtApplied(bandA.address)).to.equal($(10));
      expect(await withDiscounts.escrow.debtOutstanding(bandA.address)).to.equal(0);
      expect(await usdc.balanceOf(withDiscounts.escrow.target)).to.equal(0);          // every unit was paid out
    });

    it("a show where nobody owes anything shares the sweep exactly as before", async function () {
      const b = await newShow("s-nodebt", { program: memberCfg() });
      for (const w of signers.slice(16, 18)) await buyAs(b, w, false);               // two buyers who are not members
      await time.increaseTo(showEnd);
      await expect(b.escrow.connect(stranger).executeFinalSweep()).to.not.emit(b.escrow, "DebtApplied");
      expect(await earned(b, promoter)).to.equal($(10.2));                            // its 30% of the $34 the two tickets left
      expect(await earned(b, bandA)).to.equal($(6.8));                                // 20%, nothing taken off
      expect(await usdc.balanceOf(b.escrow.target)).to.equal(0);
    });

    it("a debt bigger than its funder's share is taken in full from that share, the rest is carried, and the escrow is never overdrawn", async function () {
      const b = await newShow("s-clamp", { program: memberCfg(), sweep: [3000, 5000, 1000, 1000] });
      for (const w of signers.slice(10, 20)) await buyAs(b, w, true);                // ten members: bandA owes $20
      expect(await b.discounts.funderDebit(bandA.address)).to.equal($(20));
      expect(await b.escrow.distributable()).to.equal($(150));
      await time.increaseTo(showEnd);

      await expect(b.escrow.connect(stranger).executeFinalSweep()).to.emit(b.escrow, "DebtApplied").withArgs(bandA.address, $(17));
      expect(await earned(b, bandA)).to.equal(0);                                    // its whole share went to the debt
      expect(await b.escrow.debtOutstanding(bandA.address)).to.equal($(3));          // $3 is still owed, and recorded as such
      expect(await usdc.balanceOf(b.escrow.target)).to.equal(0);                     // nothing is left over and nothing was short
      // The pot was $170 (what the tickets would have brought), shared 30/50/10/10 and then bandA's whole
      // share went to its debt, which leaves $153 to hand out of $150. The others are scaled down together:
      // a funder whose debt is bigger than its share cannot be made up by the escrow's own money.
      expect(await earned(b, promoter)).to.equal($(50));                             // $51 scaled by 150/153
      expect(await earned(b, artist)).to.equal(83_333_333n);                         // $85 scaled by 150/153
      expect(await earned(b, bandB)).to.equal(16_666_667n);                          // the last takes the rest
      expect((await earned(b, promoter)) + (await earned(b, artist)) + (await earned(b, bandB))).to.equal($(150));
    });

    it("a funder that is listed twice in the sweep is charged once", async function () {
      const b = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("twice") }, funding: [], payoutRules: [],
        tiers: [tier({ quantity: 100, priceUSDC: $(20) })],
        tickets: { discountsEnabled: true, salesTaxBPS: TAX, taxReceiver: promoter.address },
        sweep: { recipients: [promoter.address, artist.address, bandA.address, bandA.address], bps: [3000, 4000, 1500, 1500], notBefore: showEnd },
      }));
      await b.discounts.connect(promoter).configureMembershipProgram(memberCfg());
      await b.discounts.connect(promoter).proposeFunder(1, bandA.address, 0);
      await b.discounts.connect(bandA).authorizeFunding(1, $(1_000));
      await b.show.connect(promoter).signTerms();
      await b.show.connect(artist).signTerms();
      for (const w of signers.slice(10, 13)) await buyAs(b, w, true);                // bandA owes $6
      await time.increaseTo(showEnd);
      await b.escrow.connect(stranger).executeFinalSweep();
      expect(await b.escrow.debtApplied(bandA.address)).to.equal($(6));
      expect(await usdc.balanceOf(b.escrow.target)).to.equal(0);
    });

    it("money that arrives after the show is shared by the plain split: debts are not collected from it", async function () {
      const b = await newShow("s-late", { program: memberCfg(), sweep: [3000, 5000, 1000, 1000] });
      for (const w of signers.slice(10, 20)) await buyAs(b, w, true);
      await time.increaseTo(showEnd);
      await b.escrow.connect(stranger).executeFinalSweep();
      expect(await b.escrow.debtOutstanding(bandA.address)).to.equal($(3));

      const before = await earned(b, bandA, OTHER);
      await usdc.mint(b.escrow.target, $(100));                                      // a resale royalty, say
      await b.escrow.connect(stranger).distributeLateFunds();
      expect((await earned(b, bandA, OTHER)) - before).to.equal($(10));              // its 10%, with nothing taken off
      expect(await b.escrow.debtOutstanding(bandA.address)).to.equal($(3));
    });
  });

  // ─── CANCELLATION ───────────────────────────────────────────────────────
  describe("a cancelled show", function () {
    it("collects nothing: nobody pays for a discount on tickets that were refunded", async function () {
      const b = await newShow("c1", { program: memberCfg(), payoutRules: [{ to: bandA.address, kind: PayoutKind.FixedAmount, value: $(10), notBefore: t0 + 15 * ONE_DAY, isGuarantee: true }] });
      await buyAs(b, fan, true);
      await buyAs(b, signers[10], false);
      expect(await b.discounts.funderDebit(bandA.address)).to.equal($(2));
      expect(await b.escrow.debtOutstanding(bandA.address)).to.equal($(2));

      await b.escrow.connect(artist).cancel();
      expect(await b.escrow.debtOutstanding(bandA.address)).to.equal(0);              // void from the moment of cancellation
      await b.escrow.connect(stranger).continueRefunds(5);
      await b.escrow.connect(stranger).finalizeCancellationPayout();
      expect(await b.escrow.debtApplied(bandA.address)).to.equal(0);
      expect(await usdc.balanceOf(b.escrow.target)).to.equal(0);
    });
  });

  // ─── CAN THE SHOW COLLECT FROM A FUNDER? ────────────────────────────────
  describe("who may fund a discount", function () {
    let b;
    beforeEach(async function () {
      // bandA is only paid a fixed $10; bandB only a percentage; the sweep pays the promoter and the artist.
      b = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("route") }, funding: [],
        tiers: [tier({ quantity: 10, priceUSDC: $(20) })],
        tickets: { discountsEnabled: true, salesTaxBPS: TAX, taxReceiver: promoter.address },
        payoutRules: [
          { to: bandA.address, kind: PayoutKind.FixedAmount, value: $(10), notBefore: t0 + ONE_DAY, isGuarantee: true },
          { to: bandB.address, kind: PayoutKind.PercentageOfCurrentBalance, value: 1_000, notBefore: t0 + ONE_DAY, isGuarantee: false },
        ],
        sweep: { recipients: [promoter.address, artist.address], bps: [4000, 6000], notBefore: showEnd },
      }));
      await b.discounts.connect(promoter).configureMembershipProgram(memberCfg());
      await b.discounts.connect(promoter).configureMembershipProgram(memberCfg({ priority: 2 }));
      for (const [pid, f] of [[1, bandA], [1, bandB], [1, stranger], [2, bandA]]) await b.discounts.connect(promoter).proposeFunder(pid, f.address, 0);
    });

    it("reports what the show is sure to pay a funder, and whether it has a share of the sweep", async function () {
      expect(await b.escrow.debtRoute(bandA.address)).to.deep.equal([$(10), false]);
      expect(await b.escrow.debtRoute(bandB.address)).to.deep.equal([0n, false]);        // a percentage is not certain
      expect(await b.escrow.debtRoute(artist.address)).to.deep.equal([0n, true]);
      expect(await b.escrow.debtRoute(stranger.address)).to.deep.equal([0n, false]);
    });

    it("a funder the show does not pay, or pays only a percentage, cannot be a funder", async function () {
      await expect(b.discounts.connect(bandB).authorizeFunding(1, $(1))).to.be.revertedWithCustomError(b.discounts, "FunderNotPaidByShow");
      await expect(b.discounts.connect(stranger).authorizeFunding(1, $(1))).to.be.revertedWithCustomError(b.discounts, "FunderNotPaidByShow");
    });

    it("a funder paid a fixed amount cannot promise more than that amount, over all its programs together", async function () {
      await expect(b.discounts.connect(bandA).authorizeFunding(1, $(10) + 1n)).to.be.revertedWithCustomError(b.discounts, "CapAboveGuarantee");
      await b.discounts.connect(bandA).authorizeFunding(1, $(6));
      await expect(b.discounts.connect(bandA).authorizeFunding(2, $(5))).to.be.revertedWithCustomError(b.discounts, "CapAboveGuarantee");   // 6 + 5 > 10
      await b.discounts.connect(bandA).authorizeFunding(2, $(4));
      await b.discounts.connect(bandA).authorizeFunding(1, $(2));                                                                         // lowering a cap frees room
      expect(await b.discounts.authorizedTotal(bandA.address)).to.equal($(6));
      await b.discounts.connect(bandA).authorizeFunding(2, $(8));
    });

    it("a funder with a share of the sweep may promise what it likes: its debts come out of that share", async function () {
      const c = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("route-sweep") }, funding: [], payoutRules: [],
        tiers: [tier({ quantity: 10, priceUSDC: $(20) })],
        tickets: { discountsEnabled: true, salesTaxBPS: TAX, taxReceiver: promoter.address },
        sweep: sweepOf([3000, 4000, 2000, 1000]),
      }));
      await c.discounts.connect(promoter).configureMembershipProgram(memberCfg());
      await c.discounts.connect(promoter).proposeFunder(1, bandA.address, 0);
      await c.discounts.connect(bandA).authorizeFunding(1, $(1_000_000));
      expect((await c.discounts.getFunderAuth(1, bandA.address)).maxDebit).to.equal($(1_000_000));
    });
  });

  // ─── WIRING ─────────────────────────────────────────────────────────────
  describe("wiring", function () {
    it("the escrow of a show with discounts knows the coordinator, and one without does not", async function () {
      const withIt = await newShow("w1", { program: memberCfg() });
      const without = await newShow("w2", { discounts: false });
      expect(await withIt.escrow.discountLedger()).to.equal(withIt.discounts.target);
      expect(await without.escrow.discountLedger()).to.equal(ZERO_ADDRESS);
      expect(await without.escrow.debtOutstanding(bandA.address)).to.equal(0);
    });

    it("only the factory can set the ledger, and only once", async function () {
      const b = await newShow("w3", { program: memberCfg() });
      await expect(b.escrow.connect(stranger).setDiscountLedger(stranger.address)).to.be.revertedWithCustomError(b.escrow, "NotFactory");
      await impersonateAccount(sys.factory.target);
      await setBalance(sys.factory.target, ethers.parseEther("1"));
      const asFactory = await ethers.getSigner(sys.factory.target);
      await expect(b.escrow.connect(asFactory).setDiscountLedger(stranger.address)).to.be.revertedWithCustomError(b.escrow, "LedgerAlreadySet");
      const other = await newShow("w4", { discounts: false });
      await expect(other.escrow.connect(asFactory).setDiscountLedger(ZERO_ADDRESS)).to.be.revertedWithCustomError(other.escrow, "ZeroAddress");
    });
  });
});
