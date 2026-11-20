// test/DiscountPurchase.test.js
// Buying tickets with discounts: the factory builds the coordinator, the ticket sells an
// order, every ticket records what was actually paid for it, and the escrow, refunds and
// the final payout stay correct.
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { ONE_DAY, tier, deploySystem, showConfig, createShow, edgeIdOf } = require("./helpers/show");

const $ = (n) => ethers.parseUnits(String(n), 6);
const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;
const GA = 0, VIP = 1;
const TAX = 800, FEE = 200, GAS = $(1);
const mask = (...t) => t.reduce((m, x) => m | (1n << BigInt(x)), 0n);
const NONE = { availableMask: 0, grantedMasks: [], commitment: ZERO_BYTES32 };
const consent = (granted, available = 0b1, commitment = ethers.id("consent")) => ({ availableMask: available, grantedMasks: granted, commitment });

describe("Buying tickets with discounts", function () {
  let sys, usdc, membership;
  let promoter, artist, treasury, fan, fan2, fan3, bandA, bandB, stranger;
  let t0, showEnd;

  async function memberOf() {
    const mImpl = await (await ethers.getContractFactory("FanMembership")).deploy();
    const mFactory = await (await ethers.getContractFactory("FanMembershipFactory")).deploy(mImpl.target);
    const r = await (await mFactory.connect(promoter).createProgram({
      issuer: promoter.address, scopeType: 0, scopeRef: artist.address, name: "Fans", symbol: "F", baseURI: "",
      renewable: true, maxSupply: 0, paymentToken: ZERO_ADDRESS, paymentReceiver: ZERO_ADDRESS, saleStart: 0, saleEnd: 0,
    })).wait();
    const m = await ethers.getContractAt("FanMembership", mFactory.interface.parseLog(r.logs.find((l) => l.address === mFactory.target)).args.program);
    await m.connect(promoter).createTier("Member", "", 1, 365 * ONE_DAY, 0, 0, 0, false);
    for (const w of [fan, fan3]) await m.connect(promoter).grantMembership(1, w.address, ZERO_BYTES32, ZERO_BYTES32);
    return m;
  }

  const memberCfg = (o = {}) => ({
    membership: membership.target, minTierPriority: 0, isPercent: false, amount: $(2), priority: 1,
    allowedTypeMask: mask(GA, VIP), budget: 0, redemptionCap: 0, effectiveFrom: 0, effectiveTo: 0, ...o,
  });
  const dataCfg = (o = {}) => ({ maxDiscount: $(1), categoryCount: 1, allowedTypeMask: mask(GA, VIP), budget: 0, redemptionCap: 0, effectiveFrom: 0, effectiveTo: 0, ...o });

  // A show with discounts, its programs (each: [config, funder, cap]) set up and the show signed.
  async function newShow(name, programs = [], overrides = {}) {
    const { tickets, tiers, ...rest } = overrides;
    const b = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
      anchors: { termsHash: ethers.id(name) }, funding: [],
      tiers: tiers ?? [tier({ quantity: 100, priceUSDC: $(20) }), tier({ quantity: 100, priceUSDC: $(50), ticketType: 3 })],
      tickets: { discountsEnabled: true, salesTaxBPS: TAX, taxReceiver: promoter.address, ...tickets },
      sweep: { recipients: [promoter.address, artist.address, bandA.address, bandB.address], bps: [3000, 5000, 1000, 1000], notBefore: showEnd },
      ...rest,
    }));
    let id = 0;
    for (const [kind, cfg, funders] of programs) {
      if (kind === "data") await b.discounts.connect(promoter).configureDataProgram(cfg);
      else await b.discounts.connect(promoter).configureMembershipProgram(cfg);
      id++;
      for (const [funder, cap] of funders) {
        await b.discounts.connect(promoter).proposeFunder(id, funder.address, 0b11);
        await b.discounts.connect(funder).authorizeFunding(id, cap ?? $(1_000));
      }
    }
    await b.show.connect(promoter).signTerms();
    await b.show.connect(artist).signTerms();
    return b;
  }

  async function prices(b, tierIds) {
    return Promise.all(tierIds.map(async (i) => (await b.ticket.tiers(i)).priceUSDC));
  }
  async function quote(b, who, tierIds, c = NONE) {
    return b.discounts.quote(who.address, tierIds, await prices(b, tierIds), TAX, FEE, GAS, c);
  }
  async function order(b, who, tierIds, c = NONE) {
    const [q, h] = await quote(b, who, tierIds, c);
    await usdc.mint(who.address, q.checkoutTotal);
    await usdc.connect(who).approve(b.ticket.target, q.checkoutTotal);
    return { q, tx: b.ticket.connect(who).buyTickets(tierIds, c, h, q.checkoutTotal) };
  }
  const buy = async (b, who, tierIds, c = NONE) => { const { tx } = await order(b, who, tierIds, c); return tx; };
  async function plain(b, who, tierId) {
    const price = (await b.ticket.tiers(tierId)).priceUSDC;
    await usdc.mint(who.address, price);
    await usdc.connect(who).approve(b.ticket.target, price);
    return b.ticket.connect(who).buyTicket(tierId);
  }

  beforeEach(async function () {
    [, promoter, artist, treasury, fan, fan2, fan3, bandA, bandB, stranger] = await ethers.getSigners();
    sys = await deploySystem();
    usdc = sys.usdc;
    membership = await memberOf();
    t0 = await time.latest();
    showEnd = t0 + 30 * ONE_DAY + 7_200;
  });

  // ─── THE FACTORY ────────────────────────────────────────────────────────
  describe("the factory", function () {
    it("builds a discount coordinator for a show that asks for one, and wires it to the ticket", async function () {
      const b = await newShow("wired");
      expect(b.discounts).to.not.equal(null);
      expect(await b.ticket.discountCoordinator()).to.equal(b.discounts.target);
      expect(await b.discounts.ticketContract()).to.equal(b.ticket.target);
      expect(await b.discounts.show()).to.equal(b.show.target);
      await expect(b.discounts.initialize(b.show.target, b.ticket.target)).to.be.revertedWithCustomError(b.discounts, "AlreadyInitialized");
      expect(await sys.registry.edgeStatus(edgeIdOf(b.show.target, b.discounts.target, 0))).to.equal(2);     // HAS_MODULE, active
      expect((await sys.factory.predictBundle(b.showId)).discountCoordinator).to.equal(b.discounts.target);
    });

    it("builds nothing for a show without discounts, and such a show cannot sell an order", async function () {
      const b = await newShow("plain", [], { tickets: { discountsEnabled: false } });
      expect(b.discounts).to.equal(null);
      expect(await b.ticket.discountCoordinator()).to.equal(ZERO_ADDRESS);
      await expect(b.ticket.connect(fan).buyTickets([GA], NONE, ZERO_BYTES32, $(100))).to.be.revertedWithCustomError(b.ticket, "NoDiscountProgram");
    });

    it("refuses discounts without tickets, or before the owner has named an implementation", async function () {
      await expect(createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("no-tickets") }, funding: [], tickets: { ticketsEnabled: false, discountsEnabled: true },
      }))).to.be.revertedWithCustomError(sys.factory, "DiscountsNeedTickets");

      const [owner] = await ethers.getSigners();
      const bare = await (await ethers.getContractFactory("ShowFactory")).deploy(
        owner.address, sys.registry.target, usdc.target, treasury.address,
        sys.showImpl.target, sys.escrowImpl.target, sys.ticketImpl.target, sys.validatorImpl.target
      );
      await expect(createShow(bare, promoter, showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("no-impl") }, funding: [], tickets: { discountsEnabled: true },
      }))).to.be.revertedWithCustomError(bare, "DiscountsNotAvailable");
    });

    it("only the owner names the implementation, and not the zero address", async function () {
      await expect(sys.factory.connect(stranger).setDiscountCoordinatorImplementation(stranger.address)).to.be.reverted;
      await expect(sys.factory.setDiscountCoordinatorImplementation(ZERO_ADDRESS)).to.be.revertedWithCustomError(sys.factory, "ZeroAddress");
    });
  });

  // ─── ONE TICKET, ONE DISCOUNT ───────────────────────────────────────────
  describe("a member buys one ticket", function () {
    let b;
    beforeEach(async function () {
      b = await newShow("one", [["member", memberCfg({ amount: $(2) }), [[bandA]]]]);
    });

    it("pays $18 for a $20 ticket (the client's example), and the escrow gets what a $20 ticket would, less the discount", async function () {
      const tBefore = await usdc.balanceOf(treasury.address);
      const { q, tx } = await order(b, fan, [GA]);
      expect(q.checkoutTotal).to.equal($(18));
      await expect(tx)
        .to.emit(b.ticket, "TicketSold").withArgs(1, GA, fan.address, $(18))
        .and.to.emit(b.ticket, "TicketDiscounted").withArgs(1, $(20), $(2))
        .and.to.emit(b.ticket, "TicketOrder").withArgs(fan.address, 1, 1, $(2));

      expect(await usdc.balanceOf(fan.address)).to.equal(0);
      expect(await usdc.balanceOf(treasury.address)).to.equal(tBefore + $(1));                // the gas, as always
      expect(await usdc.balanceOf(b.escrow.target)).to.equal($(17));                          // fee 0.40 + tax 1.60 + net 15
      expect(await b.escrow.taxAccrued()).to.equal($(1.6));
      expect(await b.escrow.protocolFeeAccrued()).to.equal($(0.4));                           // Xao's fee is not discounted
      expect(await b.escrow.totalFunded()).to.equal($(15));
    });

    it("records what was paid, what the price was and how much a discount took off", async function () {
      await buy(b, fan, [GA]);
      const d = await b.ticket.ticketData(1);
      expect([d.pricePaid, d.listPrice, d.discount]).to.deep.equal([$(18), $(20), $(2)]);
      expect(await b.ticket.getPricePaid(1)).to.equal($(18));
      expect(await b.ticket.getRefundBasis(1)).to.deep.equal([$(17), $(0.4), $(1.6)]);
      expect(await b.ticket.ownerOf(1)).to.equal(fan.address);
      expect(await b.ticket.tokenToTier(1)).to.equal(GA);
    });

    it("leaves a debt with the funder that offered it", async function () {
      await buy(b, fan, [GA]);
      expect(await b.discounts.funderDebit(bandA.address)).to.equal($(2));
      expect(await b.discounts.redeemed(1, fan.address)).to.equal(true);
    });

    it("a ticket bought the old way gets no discount, even for a member", async function () {
      await plain(b, fan, GA);
      const d = await b.ticket.ticketData(1);
      expect([d.pricePaid, d.listPrice, d.discount]).to.deep.equal([$(20), $(20), 0n]);
      expect(await b.discounts.funderDebit(bandA.address)).to.equal(0);
      expect(await b.discounts.redeemed(1, fan.address)).to.equal(false);
    });

    it("a buyer who is not a member can still buy an order, at full price", async function () {
      const { q, tx } = await order(b, fan2, [GA, VIP]);
      expect(q.checkoutTotal).to.equal($(70));
      await tx;
      expect((await b.ticket.ticketData(2)).discount).to.equal(0);
    });

    it("the ticket exposes the numbers an app needs to ask the coordinator for a quote", async function () {
      expect(await b.ticket.salesTaxBPS()).to.equal(TAX);
      expect(await b.ticket.XAO_FEE_BPS()).to.equal(FEE);
      expect(await b.ticket.GAS_ALLOTMENT()).to.equal(GAS);
    });
  });

  // ─── SEVERAL TICKETS ────────────────────────────────────────────────────
  describe("an order with several tickets", function () {
    it("$50 VIP + $20 GA, Band A $5 on VIP and Band B $2 on GA: $45 and $18 (the spec's example)", async function () {
      const b = await newShow("two-types", [
        ["member", memberCfg({ priority: 1, amount: $(5), allowedTypeMask: mask(VIP) }), [[bandA]]],
        ["member", memberCfg({ priority: 2, amount: $(2), allowedTypeMask: mask(GA) }), [[bandB]]],
      ]);
      const { q, tx } = await order(b, fan, [VIP, GA]);
      expect(q.checkoutTotal).to.equal($(63));
      await tx;
      const vip = await b.ticket.ticketData(1), ga = await b.ticket.ticketData(2);
      expect([vip.pricePaid, vip.discount]).to.deep.equal([$(45), $(5)]);
      expect([ga.pricePaid, ga.discount]).to.deep.equal([$(18), $(2)]);
      expect(await b.ticket.tokenToTier(1)).to.equal(VIP);
      expect(await b.ticket.tokenToTier(2)).to.equal(GA);
      // The escrow got each ticket's own parts: $50 -> 49 in (fee 1, tax 4); $20 -> 17 in (fee 0.40, tax 1.60).
      expect(await usdc.balanceOf(b.escrow.target)).to.equal($(44) + $(17));
      expect(await b.escrow.taxAccrued()).to.equal($(4) + $(1.6));
      expect(await b.escrow.protocolFeeAccrued()).to.equal($(1) + $(0.4));
      expect(await b.escrow.totalFunded()).to.equal($(39) + $(15));
      expect(await b.discounts.funderDebit(bandA.address)).to.equal($(5));
      expect(await b.discounts.funderDebit(bandB.address)).to.equal($(2));
    });

    it("five $20 tickets and $3 of discounts: one ticket costs $17, the other four $20, the order $97", async function () {
      const b = await newShow("five", [
        ["data", dataCfg({ maxDiscount: $(1) }), [[bandA]]],
        ["member", memberCfg({ amount: $(2) }), [[bandB]]],
      ]);
      const { q, tx } = await order(b, fan, [GA, GA, GA, GA, GA], consent([0b1]));
      expect(q.checkoutTotal).to.equal($(97));
      await tx;
      const paid = [];
      for (let i = 1; i <= 5; i++) paid.push((await b.ticket.ticketData(i)).pricePaid);
      expect(paid).to.deep.equal([$(17), $(20), $(20), $(20), $(20)]);
      expect(await b.discounts.dataClaimed(fan.address)).to.equal(true);
      expect(await b.discounts.funderDebit(bandA.address)).to.equal($(1));
      expect(await b.discounts.funderDebit(bandB.address)).to.equal($(2));
    });

    it("a discount that takes the whole net still leaves tax, gas and Xao's fee: $3 on a $20 ticket", async function () {
      const b = await newShow("free", [["member", memberCfg({ amount: $(20) }), [[bandA]]]]);
      const { q, tx } = await order(b, fan, [GA]);
      expect(q.checkoutTotal).to.equal($(3));
      await tx;
      expect(await b.ticket.getRefundBasis(1)).to.deep.equal([$(2), $(0.4), $(1.6)]);
      expect(await b.escrow.totalFunded()).to.equal(0);
      expect(await usdc.balanceOf(b.escrow.target)).to.equal($(2));
    });

    it("what funders owe always equals what the tickets were discounted by", async function () {
      const b = await newShow("conservation", [
        ["data", dataCfg({ maxDiscount: $(1.01) }), [[bandA], [bandB]]],
        ["member", memberCfg({ amount: $(3.33) }), [[bandA]]],
      ]);
      let sum = 0n;
      const orders = [[fan, [GA, VIP, GA], consent([0b1, 0b1])], [fan3, [VIP], consent([0b1, 0])], [fan2, [GA], NONE]];
      for (const [who, ids, c] of orders) await buy(b, who, ids, c);
      const total = Number(await b.ticket.totalSold());
      for (let i = 1; i <= total; i++) sum += (await b.ticket.ticketData(i)).discount;
      expect(sum).to.be.gt(0);
      expect(await b.discounts.totalDebit()).to.equal(sum);
      expect((await b.discounts.funderDebit(bandA.address)) + (await b.discounts.funderDebit(bandB.address))).to.equal(sum);
    });
  });

  // ─── PROTECTING THE BUYER ───────────────────────────────────────────────
  describe("protecting the buyer", function () {
    let b;
    beforeEach(async function () {
      b = await newShow("protect", [["member", memberCfg({ amount: $(2) }), [[bandA]]]]);
    });

    it("refuses an order that costs more than the buyer said", async function () {
      const [q, h] = await quote(b, fan, [GA]);
      await usdc.mint(fan.address, $(100));
      await usdc.connect(fan).approve(b.ticket.target, $(100));
      await expect(b.ticket.connect(fan).buyTickets([GA], NONE, h, q.checkoutTotal - 1n)).to.be.revertedWithCustomError(b.ticket, "PriceAboveMax");
    });

    it("refuses an order whose price changed since the quote, instead of charging more", async function () {
      const [, h] = await quote(b, fan, [GA]);                                       // quoted with the discount
      await b.discounts.connect(promoter).stopProgram(1);                            // ... which is then stopped
      await usdc.mint(fan.address, $(100));
      await usdc.connect(fan).approve(b.ticket.target, $(100));
      await expect(b.ticket.connect(fan).buyTickets([GA], NONE, h, $(100))).to.be.revertedWithCustomError(b.discounts, "QuoteChanged");
      expect(await b.ticket.totalSold()).to.equal(0);
    });

    it("a quote cannot be reused for other tickets or by someone else", async function () {
      const [, h] = await quote(b, fan, [GA]);
      for (const who of [fan, fan3]) {
        await usdc.mint(who.address, $(100));
        await usdc.connect(who).approve(b.ticket.target, $(100));
      }
      await expect(b.ticket.connect(fan).buyTickets([VIP], NONE, h, $(100))).to.be.revertedWithCustomError(b.discounts, "QuoteChanged");
      await expect(b.ticket.connect(fan3).buyTickets([GA], NONE, h, $(100))).to.be.revertedWithCustomError(b.discounts, "QuoteChanged");
    });

    it("a benefit used up by an earlier order cannot be used again", async function () {
      await buy(b, fan, [GA]);
      const [q] = await quote(b, fan, [GA]);
      expect(q.checkoutTotal).to.equal($(20));
    });

    it("an order that is empty, too long, for an unknown tier, or before the show is signed is refused", async function () {
      await expect(b.ticket.connect(fan).buyTickets([], NONE, ZERO_BYTES32, $(100))).to.be.revertedWithCustomError(b.ticket, "InvalidOrder");
      await expect(b.ticket.connect(fan).buyTickets(Array(11).fill(GA), NONE, ZERO_BYTES32, $(10_000))).to.be.revertedWithCustomError(b.ticket, "InvalidOrder");
      await expect(b.ticket.connect(fan).buyTickets([9], NONE, ZERO_BYTES32, $(100))).to.be.revertedWithCustomError(b.ticket, "InvalidTier");

      const unsigned = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("unsigned") }, funding: [], tiers: [tier({ quantity: 5 })], tickets: { discountsEnabled: true },
      }));
      await expect(unsigned.ticket.connect(fan).buyTickets([0], NONE, ZERO_BYTES32, $(100))).to.be.revertedWithCustomError(unsigned.ticket, "ShowNotSigned");
    });

    it("an order bigger than what is left of a tier fails whole, leaving nothing behind", async function () {
      const small = await newShow("small", [["member", memberCfg(), [[bandA]]]], { tiers: [tier({ quantity: 2, priceUSDC: $(20) })] });
      await usdc.mint(fan.address, $(100));
      await usdc.connect(fan).approve(small.ticket.target, $(100));
      await expect(small.ticket.connect(fan).buyTickets([0, 0, 0], NONE, ZERO_BYTES32, $(100))).to.be.revertedWithCustomError(small.ticket, "SoldOut");
      expect(await small.ticket.totalSold()).to.equal(0);
      expect(await small.discounts.totalDebit()).to.equal(0);
    });

    it("tiers with a gate stay gated in an order", async function () {
      const pImpl = await (await ethers.getContractFactory("PerkModule")).deploy();
      const pFactory = await (await ethers.getContractFactory("PerkModuleFactory")).deploy(pImpl.target);
      const made = await (await pFactory.connect(promoter).createModule({ issuer: promoter.address, scopeType: 2, scopeRef: promoter.address, metadataURI: "" })).wait();
      const perks = await ethers.getContractAt("PerkModule", pFactory.interface.parseLog(made.logs.find((l) => l.address === pFactory.target)).args.module);
      await perks.connect(promoter).createPerk({
        perkType: 1, eligibilityType: 0, eligibilityRef: membership.target, minTierPriority: 0, windowFrom: 0, windowTo: 0,
        benefitValue: 0, isPercent: false, benefitTarget: ZERO_BYTES32, startTime: 0, endTime: 0, mode: 0, maxUsesGlobal: 0, metadataURI: "",
      });
      const gated = await newShow("gated", [], {
        tiers: [tier({ quantity: 10, priceUSDC: $(20), gateMode: 2, gateModule: perks.target, gateId: 1 })],
      });
      await usdc.mint(fan2.address, $(100));
      await usdc.connect(fan2).approve(gated.ticket.target, $(100));
      await expect(gated.ticket.connect(fan2).buyTickets([0], NONE, ZERO_BYTES32, $(100))).to.be.revertedWithCustomError(gated.ticket, "NotEligibleForTier");
    });
  });

  // ─── CANCELLATION AND COMPLETION ────────────────────────────────────────
  describe("when the show ends", function () {
    let b;
    beforeEach(async function () {
      b = await newShow("ends", [["member", memberCfg({ amount: $(2) }), [[bandA]]]]);
    });

    it("a cancelled show refunds exactly what each ticket cost, less the gas: $17 for the discounted one, $19 for a plain $20 one", async function () {
      await buy(b, fan, [GA]);
      await plain(b, fan2, GA);
      const f1 = await usdc.balanceOf(fan.address), f2 = await usdc.balanceOf(fan2.address);
      const tBefore = await usdc.balanceOf(treasury.address);

      await b.escrow.connect(artist).cancel();
      await b.escrow.connect(stranger).continueRefunds(5);
      expect(await usdc.balanceOf(fan.address)).to.equal(f1 + $(17));                    // paid $18, gas $1 is not refunded
      expect(await usdc.balanceOf(fan2.address)).to.equal(f2 + $(19));                   // paid $20
      expect(await b.escrow.taxAccrued()).to.equal(0);
      expect(await b.escrow.protocolFeeAccrued()).to.equal(0);

      await b.escrow.connect(stranger).finalizeCancellationPayout();
      expect(await usdc.balanceOf(b.escrow.target)).to.equal(0);                         // nothing is left over or short
      expect(await usdc.balanceOf(treasury.address)).to.equal(tBefore);
    });

    it("a completed show pays the tax and Xao's fee in full, and the discount only reduces what the show receives", async function () {
      await buy(b, fan, [GA]);
      const pBefore = await usdc.balanceOf(promoter.address);
      const tBefore = await usdc.balanceOf(treasury.address);
      await time.increaseTo(showEnd);
      await expect(b.escrow.connect(stranger).executeFinalSweep())
        .to.emit(b.escrow, "TaxPaid").withArgs(promoter.address, $(1.6))
        .and.to.emit(b.escrow, "ProtocolFeePaid").withArgs($(0.4))
        .and.to.emit(b.escrow, "FinalSweepExecuted").withArgs($(15));                    // $17 net less the $2 discount
      expect(await usdc.balanceOf(treasury.address)).to.equal(tBefore + $(0.4));
    });
  });
});
