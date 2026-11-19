// test/TicketGate.test.js
// Presale and members-only ticket tiers: the ticket asks a perk module whether the
// buyer qualifies.
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { ONE_DAY, TICKET_PRICE, tier, deploySystem, showConfig, createShow } = require("./helpers/show");

const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;
const PerkType = { PRESALE_ACCESS: 0, EVENT_ACCESS: 1, POS_DISCOUNT: 2 };
const Eligibility = { MEMBERSHIP: 0, TICKET_WINDOW: 1, DIRECT_GRANT: 2 };
const Gate = { NONE: 0, PRESALE: 1, MEMBERS_ONLY: 2 };

describe("Ticket gates", function () {
  let sys, usdc, membership, perks;
  let promoter, artist, member, direct, stranger;
  let t0, presaleFrom, generalSale;
  const ids = {};

  function perkInput(o = {}) {
    return {
      perkType: PerkType.PRESALE_ACCESS, eligibilityType: Eligibility.MEMBERSHIP, eligibilityRef: membership.target,
      minTierPriority: 0, windowFrom: 0, windowTo: 0, benefitValue: 0, isPercent: false, benefitTarget: ZERO_BYTES32,
      startTime: 0, endTime: 0, mode: 0, maxUsesGlobal: 0, metadataURI: "", ...o,
    };
  }

  async function addPerk(o) {
    await perks.connect(promoter).createPerk(perkInput(o));
    return perks.perkCount();
  }

  async function newShow(name, tiers) {
    const b = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
      anchors: { termsHash: ethers.id(name) }, funding: [], tiers,
    }));
    await b.show.connect(promoter).signTerms();
    await b.show.connect(artist).signTerms();
    return b;
  }

  const open      = () => tier({ quantity: 100 });
  const presale   = (o = {}) => tier({ quantity: 100, onSaleTimestamp: generalSale, gateMode: Gate.PRESALE, gateModule: perks.target, gateId: ids.presale, presaleFrom, ...o });
  const membersOnly = (o = {}) => tier({ quantity: 100, gateMode: Gate.MEMBERS_ONLY, gateModule: perks.target, gateId: ids.access, ...o });

  async function buy(b, who, tierId, count = 1) {
    const price = (await b.ticket.tiers(tierId)).priceUSDC;
    await usdc.mint(who.address, price * BigInt(count));
    await usdc.connect(who).approve(b.ticket.target, price * BigInt(count));
    for (let i = 0; i < count; i++) await b.ticket.connect(who).buyTicket(tierId);
  }
  const attempt = async (b, who, tierId) => {
    await usdc.mint(who.address, TICKET_PRICE);
    await usdc.connect(who).approve(b.ticket.target, TICKET_PRICE);
    return b.ticket.connect(who).buyTicket(tierId);
  };

  beforeEach(async function () {
    [, promoter, artist, , member, direct, stranger] = await ethers.getSigners();
    sys = await deploySystem();
    usdc = sys.usdc;
    t0 = await time.latest();
    presaleFrom = t0 + 1_000;
    generalSale = t0 + 5 * ONE_DAY;

    // A membership program with one member, and a perk module that grants access to its members.
    const mImpl = await (await ethers.getContractFactory("FanMembership")).deploy();
    const mFactory = await (await ethers.getContractFactory("FanMembershipFactory")).deploy(mImpl.target);
    const r = await (await mFactory.connect(promoter).createProgram({
      issuer: promoter.address, scopeType: 1, scopeRef: promoter.address, name: "Venue fans", symbol: "VF", baseURI: "ipfs://m/",
      renewable: true, maxSupply: 0, paymentToken: ZERO_ADDRESS, paymentReceiver: ZERO_ADDRESS, saleStart: 0, saleEnd: 0,
    })).wait();
    membership = await ethers.getContractAt("FanMembership", mFactory.interface.parseLog(r.logs.find((l) => l.address === mFactory.target)).args.program);
    await membership.connect(promoter).createTier("Member", "", 1, 30 * ONE_DAY, 0, 0, 0, false);
    await membership.connect(promoter).grantMembership(1, member.address, ZERO_BYTES32, ZERO_BYTES32);

    const pImpl = await (await ethers.getContractFactory("PerkModule")).deploy();
    const pFactory = await (await ethers.getContractFactory("PerkModuleFactory")).deploy(pImpl.target);
    const pr = await (await pFactory.connect(promoter).createModule({ issuer: promoter.address, scopeType: 2, scopeRef: promoter.address, metadataURI: "" })).wait();
    perks = await ethers.getContractAt("PerkModule", pFactory.interface.parseLog(pr.logs.find((l) => l.address === pFactory.target)).args.module);

    ids.presale = await addPerk({ perkType: PerkType.PRESALE_ACCESS });
    ids.access  = await addPerk({ perkType: PerkType.EVENT_ACCESS });
    ids.pos     = await addPerk({ perkType: PerkType.POS_DISCOUNT, benefitValue: 1_000, isPercent: true });
    ids.granted = await addPerk({ perkType: PerkType.PRESALE_ACCESS, eligibilityType: Eligibility.DIRECT_GRANT, eligibilityRef: ZERO_ADDRESS });
    await perks.connect(promoter).grantPerk(ids.granted, direct.address);
  });

  // ─── PRESALE ────────────────────────────────────────────────────────────
  describe("a presale tier", function () {
    let b;
    beforeEach(async function () {
      b = await newShow("presale", [open(), presale()]);          // tier 0 open, tier 1 presale
    });

    it("an ordinary tier is not affected by any of this", async function () {
      await buy(b, stranger, 0);
      expect(await b.ticket.totalSold()).to.equal(1);
    });

    it("is closed to everyone before the presale opens, perk holders included", async function () {
      await expect(attempt(b, member, 1)).to.be.revertedWithCustomError(b.ticket, "NotOnSaleYet");
    });

    it("opens early to perk holders only", async function () {
      await time.increaseTo(presaleFrom + 1);
      await buy(b, member, 1);
      expect(await b.ticket.balanceOf(member.address, 1)).to.equal(1);
      await expect(attempt(b, stranger, 1)).to.be.revertedWithCustomError(b.ticket, "NotEligibleForTier");
    });

    it("a perk holder is not limited to one ticket: the perk is looked at, not used up", async function () {
      await time.increaseTo(presaleFrom + 1);
      await buy(b, member, 1, 3);
      expect(await b.ticket.totalSold()).to.equal(3);
    });

    it("opens to everyone when the general sale starts", async function () {
      await time.increaseTo(generalSale + 1);
      await buy(b, stranger, 1);
      expect(await b.ticket.totalSold()).to.equal(1);
    });

    it("a perk that is handed out directly works as well as a membership", async function () {
      const direct1 = await newShow("presale-direct", [presale({ gateId: ids.granted })]);
      await time.increaseTo(presaleFrom + 1);
      await buy(direct1, direct, 0);
      await expect(attempt(direct1, member, 0)).to.be.revertedWithCustomError(direct1.ticket, "NotEligibleForTier");   // a member, but not granted this perk
    });

    it("sells like any other ticket: the same money reaches the escrow", async function () {
      await time.increaseTo(presaleFrom + 1);
      await buy(b, member, 1);
      expect(await b.ticket.getPricePaid(1)).to.equal(TICKET_PRICE);
      expect((await b.ticket.getRefundBasis(1))[0]).to.equal(TICKET_PRICE - 1_000_000n);
    });
  });

  // ─── MEMBERS ONLY ───────────────────────────────────────────────────────
  describe("a members-only tier", function () {
    let b;
    beforeEach(async function () {
      b = await newShow("members", [membersOnly()]);
    });

    it("sells to perk holders and nobody else, at any time", async function () {
      await buy(b, member, 0);
      await expect(attempt(b, stranger, 0)).to.be.revertedWithCustomError(b.ticket, "NotEligibleForTier");
      await time.increase(10 * ONE_DAY);
      await expect(attempt(b, stranger, 0)).to.be.revertedWithCustomError(b.ticket, "NotEligibleForTier");
    });

    it("stops the day the membership ends: it is looked at every time", async function () {
      await buy(b, member, 0);
      await time.increase(31 * ONE_DAY);
      await expect(attempt(b, member, 0)).to.be.revertedWithCustomError(b.ticket, "NotEligibleForTier");
    });

    it("still waits for its on-sale time", async function () {
      const later = await newShow("members-later", [membersOnly({ onSaleTimestamp: generalSale })]);
      await expect(attempt(later, member, 0)).to.be.revertedWithCustomError(later.ticket, "NotOnSaleYet");
      await time.increaseTo(generalSale + 1);
      await buy(later, member, 0);
    });
  });

  // ─── WHEN THE PERK CANNOT SAY YES ───────────────────────────────────────
  describe("when the perk cannot say yes", function () {
    it("a perk of the wrong kind never opens a gate", async function () {
      const b = await newShow("wrong-kind", [membersOnly({ gateId: ids.pos }), membersOnly({ gateId: ids.presale })]);
      await expect(attempt(b, member, 0)).to.be.revertedWithCustomError(b.ticket, "NotEligibleForTier");      // a POS discount
      await expect(attempt(b, member, 1)).to.be.revertedWithCustomError(b.ticket, "NotEligibleForTier");      // a presale perk is not an access perk
    });

    it("a paused perk, or one that does not exist, closes the gate", async function () {
      const b = await newShow("paused", [membersOnly(), membersOnly({ gateId: 99 })]);
      await buy(b, member, 0);
      await perks.connect(promoter).setPerkActive(ids.access, false);
      await expect(attempt(b, member, 0)).to.be.revertedWithCustomError(b.ticket, "NotEligibleForTier");
      await expect(attempt(b, member, 1)).to.be.revertedWithCustomError(b.ticket, "NotEligibleForTier");
      await perks.connect(promoter).setPerkActive(ids.access, true);
      await buy(b, member, 0);
    });

    it("a module that cannot answer closes the gate; it never opens it or breaks the sale of other tiers", async function () {
      const b = await newShow("broken", [open(), membersOnly({ gateModule: usdc.target })]);       // a token, not a perk module
      await expect(attempt(b, member, 1)).to.be.revertedWithCustomError(b.ticket, "NotEligibleForTier");
      await buy(b, stranger, 0);
    });

    it("a presale module that cannot answer closes the presale too", async function () {
      const b = await newShow("broken-presale", [presale({ gateModule: usdc.target })]);
      await time.increaseTo(presaleFrom + 1);
      await expect(attempt(b, member, 0)).to.be.revertedWithCustomError(b.ticket, "NotEligibleForTier");
      await time.increaseTo(generalSale + 1);
      await buy(b, stranger, 0);                                                            // the general sale does not ask anyone
    });
  });

  // ─── SETTING A GATE UP ──────────────────────────────────────────────────
  describe("setting a gate up", function () {
    const make = (name, tiers) => createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
      anchors: { termsHash: ethers.id(name) }, funding: [], tiers,
    }));

    it("needs a perk module that exists", async function () {
      await expect(make("g1", [membersOnly({ gateModule: ZERO_ADDRESS })])).to.be.revertedWithCustomError(sys.ticketImpl, "InvalidGate");
      await expect(make("g2", [membersOnly({ gateModule: stranger.address })])).to.be.revertedWithCustomError(sys.ticketImpl, "InvalidGate");
      await expect(make("g3", [presale({ gateModule: stranger.address })])).to.be.revertedWithCustomError(sys.ticketImpl, "InvalidGate");
    });

    it("a presale must open before the general sale, and the general sale needs a time", async function () {
      await expect(make("p1", [presale({ presaleFrom: generalSale })])).to.be.revertedWithCustomError(sys.ticketImpl, "InvalidGate");
      await expect(make("p2", [presale({ presaleFrom: generalSale + 1 })])).to.be.revertedWithCustomError(sys.ticketImpl, "InvalidGate");
      await expect(make("p3", [presale({ onSaleTimestamp: 0 })])).to.be.revertedWithCustomError(sys.ticketImpl, "InvalidGate");
      await make("p4", [presale({ presaleFrom: 0 })]);                                  // open from the start of the sale
    });

    it("is stored with the tier and announced", async function () {
      const b = await make("stored", [open(), presale(), membersOnly()]);
      const t1 = await b.ticket.tiers(1);
      expect([t1.gateMode, t1.gateModule, t1.gateId, t1.presaleFrom]).to.deep.equal([BigInt(Gate.PRESALE), perks.target, BigInt(ids.presale), BigInt(presaleFrom)]);
      expect((await b.ticket.tiers(0)).gateMode).to.equal(Gate.NONE);
      const events = await b.ticket.queryFilter(b.ticket.filters.TierGated());
      expect(events.length).to.equal(2);                                               // the open tier announces nothing
      expect(events[0].args.mode).to.equal(Gate.PRESALE);
      expect(events[1].args.mode).to.equal(Gate.MEMBERS_ONLY);
    });

    it("is fixed once the show is signed, like every other part of a tier", async function () {
      const b = await newShow("locked", [open()]);
      await expect(b.ticket.connect(promoter).addTier(membersOnly())).to.be.revertedWithCustomError(b.ticket, "TiersLocked");
    });
  });
});
