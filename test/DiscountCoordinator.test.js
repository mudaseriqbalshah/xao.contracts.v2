// test/DiscountCoordinator.test.js
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { tier, deploySystem, showConfig, createShow } = require("./helpers/show");

const $ = (n) => ethers.parseUnits(String(n), 6);
const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;
const ROLE = { ADMIN: ethers.id("ROLE_ADMIN"), OWNER: ethers.id("ROLE_OWNER"), OPERATOR: ethers.id("ROLE_OPERATOR") };
const GRANT = { ADMIN: ethers.id("ADMIN_GRANT"), OWNER: ethers.id("OWNER_GRANT"), OPERATOR: ethers.id("OPERATOR_GRANT") };
const GA = 0, VIP = 1;                                           // ticket types: the show's tier ids
const mask = (...t) => t.reduce((m, x) => m | (1n << BigInt(x)), 0n);
const NONE = { availableMask: 0, grantedMasks: [], commitment: ZERO_BYTES32 };
const consent = (granted, available = 0b11, commitment = ethers.id("consent")) => ({ availableMask: available, grantedMasks: granted, commitment });

describe("DiscountCoordinator", function () {
  let sys, bundle, coord, membership, coordFactory;
  let promoter, artist, fan, fan2, bandA, bandB, ticket, stranger;
  let t0;

  // The show pays both bands a share of the final sweep, so either can fund a discount.
  const SWEEP = () => ({
    recipients: [promoter.address, artist.address, bandA.address, bandB.address],
    bps: [3000, 5000, 1000, 1000],
    notBefore: t0 + 30 * 86_400 + 7_200,
  });

  const dataCfg = (o = {}) => ({ maxDiscount: $(1), categoryCount: 2, allowedTypeMask: mask(GA, VIP), budget: 0, redemptionCap: 0, effectiveFrom: 0, effectiveTo: 0, ...o });
  const memberCfg = (o = {}) => ({
    membership: membership.target, minTierPriority: 0, isPercent: false, amount: $(5), priority: 1,
    allowedTypeMask: mask(GA, VIP), budget: 0, redemptionCap: 0, effectiveFrom: 0, effectiveTo: 0, ...o,
  });

  async function addMember(o) { await coord.connect(promoter).configureMembershipProgram(memberCfg(o)); return coord.programCount(); }
  async function addData(o) { await coord.connect(promoter).configureDataProgram(dataCfg(o)); return coord.programCount(); }
  async function fund(programId, funder, cap = $(100), categoryMask = 0b11) {
    await coord.connect(promoter).proposeFunder(programId, funder.address, categoryMask);
    await coord.connect(funder).authorizeFunding(programId, cap);
  }
  async function sign() {
    await bundle.show.connect(promoter).signTerms();
    await bundle.show.connect(artist).signTerms();
  }

  const args = (wallet, items, c = NONE) => [wallet.address, items.map((i) => i[0]), items.map((i) => i[1]), 800, 200, $(1), c];
  const price = async (wallet, items = [[GA, $(20)]], c = NONE) => coord.quote(...args(wallet, items, c));
  const buy = async (wallet, items = [[GA, $(20)]], c = NONE) => {
    const [, h] = await price(wallet, items, c);
    return coord.connect(ticket).commit(...args(wallet, items, c), h);
  };

  beforeEach(async function () {
    [, promoter, artist, , fan, fan2, bandA, bandB, ticket, stranger] = await ethers.getSigners();
    sys = await deploySystem();
    t0 = await time.latest();
    bundle = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
      anchors: { termsHash: ethers.id("coordinator-show") }, funding: [], sweep: SWEEP(),
      tiers: [tier({ quantity: 100, priceUSDC: $(20) }), tier({ quantity: 100, priceUSDC: $(50), ticketType: 3 })],
    }));

    const mImpl = await (await ethers.getContractFactory("FanMembership")).deploy();
    const mFactory = await (await ethers.getContractFactory("FanMembershipFactory")).deploy(mImpl.target);
    const r = await (await mFactory.connect(promoter).createProgram({
      issuer: promoter.address, scopeType: 0, scopeRef: artist.address, name: "Fans", symbol: "F", baseURI: "",
      renewable: true, maxSupply: 0, paymentToken: ZERO_ADDRESS, paymentReceiver: ZERO_ADDRESS, saleStart: 0, saleEnd: 0,
    })).wait();
    membership = await ethers.getContractAt("FanMembership", mFactory.interface.parseLog(r.logs.find((l) => l.address === mFactory.target)).args.program);
    await membership.connect(promoter).createTier("Member", "", 1, 30 * 86_400, 0, 0, 0, false);
    await membership.connect(promoter).grantMembership(1, fan.address, ZERO_BYTES32, ZERO_BYTES32);

    const impl = await (await ethers.getContractFactory("DiscountCoordinator")).deploy();
    coordFactory = await (await ethers.getContractFactory("DiscountCoordinatorFactory")).deploy(impl.target);
    await coordFactory.connect(promoter).createCoordinator(bundle.show.target, ticket.address);
    coord = await ethers.getContractAt("DiscountCoordinator", await coordFactory.coordinatorOf(bundle.show.target));
  });

  // ─── CREATING THE COORDINATOR ───────────────────────────────────────────
  describe("creating the coordinator", function () {
    it("is created by one of the show's parties, once, and locks its implementation", async function () {
      await expect(coordFactory.connect(stranger).createCoordinator(bundle.show.target, ticket.address)).to.be.revertedWithCustomError(coordFactory, "NotAShowParty");
      await expect(coordFactory.connect(promoter).createCoordinator(bundle.show.target, ticket.address)).to.be.revertedWithCustomError(coordFactory, "AlreadyCreated");
      expect(await coord.show()).to.equal(bundle.show.target);
      expect(await coord.ticketContract()).to.equal(ticket.address);
      await expect(coord.initialize(bundle.show.target, ticket.address)).to.be.revertedWithCustomError(coord, "AlreadyInitialized");
      const F = await ethers.getContractFactory("DiscountCoordinatorFactory");
      await expect(F.deploy(ZERO_ADDRESS)).to.be.revertedWithCustomError(F, "ZeroImplementation");
    });
  });

  // ─── SETTING PROGRAMS UP ────────────────────────────────────────────────
  describe("setting programs up", function () {
    it("only the show's side sets programs up", async function () {
      await expect(coord.connect(stranger).configureDataProgram(dataCfg())).to.be.revertedWithCustomError(coord, "NotShowSide");
      await expect(coord.connect(fan).configureMembershipProgram(memberCfg())).to.be.revertedWithCustomError(coord, "NotShowSide");
      await coord.connect(artist).configureDataProgram(dataCfg());                    // partyB can as well
    });

    it("one data program, with sensible values", async function () {
      const bad = (o) => expect(coord.connect(promoter).configureDataProgram(dataCfg(o))).to.be.revertedWithCustomError(coord, "InvalidProgram");
      await bad({ maxDiscount: 0 });
      await bad({ categoryCount: 0 });
      await bad({ categoryCount: 17 });
      await bad({ allowedTypeMask: 0 });
      await expect(coord.connect(promoter).configureDataProgram(dataCfg({ effectiveFrom: 10, effectiveTo: 10 }))).to.be.revertedWithCustomError(coord, "InvalidWindow");
      const id = await addData();
      expect(await coord.dataProgramId()).to.equal(id);
      await expect(coord.connect(promoter).configureDataProgram(dataCfg())).to.be.revertedWithCustomError(coord, "DataProgramExists");
    });

    it("membership programs are kept in priority order and cannot share a priority", async function () {
      const c = await addMember({ priority: 30 });
      const a = await addMember({ priority: 10 });
      const b = await addMember({ priority: 20 });
      expect((await coord.getMemberOrder()).map(Number)).to.deep.equal([a, b, c].map(Number));
      await expect(coord.connect(promoter).configureMembershipProgram(memberCfg({ priority: 20 }))).to.be.revertedWithCustomError(coord, "DuplicatePriority");
    });

    it("membership programs need a real membership, an amount, types and a sane percentage", async function () {
      const bad = (o) => expect(coord.connect(promoter).configureMembershipProgram(memberCfg(o))).to.be.revertedWithCustomError(coord, "InvalidProgram");
      await bad({ membership: stranger.address });
      await bad({ amount: 0 });
      await bad({ allowedTypeMask: 0 });
      await bad({ isPercent: true, amount: 10_001 });
    });

    it("allows at most sixteen membership programs", async function () {
      for (let i = 1; i <= 16; i++) await addMember({ priority: i });
      await expect(coord.connect(promoter).configureMembershipProgram(memberCfg({ priority: 17 }))).to.be.revertedWithCustomError(coord, "TooManyPrograms");
    });

    it("funders are listed by the show side, and listing charges nobody", async function () {
      const id = await addMember();
      await expect(coord.connect(stranger).proposeFunder(id, bandA.address, 0)).to.be.revertedWithCustomError(coord, "NotShowSide");
      await coord.connect(promoter).proposeFunder(id, bandA.address, 0b11);
      await expect(coord.connect(promoter).proposeFunder(id, bandA.address, 0b11)).to.be.revertedWithCustomError(coord, "AlreadyOnRoster");
      await expect(coord.connect(promoter).proposeFunder(id, ZERO_ADDRESS, 0)).to.be.revertedWithCustomError(coord, "ZeroAddress");
      await expect(coord.connect(promoter).proposeFunder(99, bandA.address, 0)).to.be.revertedWithCustomError(coord, "UnknownProgram");
      expect(await coord.getFunders(id)).to.deep.equal([bandA.address]);
      expect((await coord.getFunderAuth(id, bandA.address)).authorized).to.equal(false);
    });

    it("a program has at most sixteen funders", async function () {
      const id = await addMember();
      for (let i = 0; i < 16; i++) await coord.connect(promoter).proposeFunder(id, ethers.Wallet.createRandom().address, 0);
      await expect(coord.connect(promoter).proposeFunder(id, bandA.address, 0)).to.be.revertedWithCustomError(coord, "TooManyFunders");
    });
  });

  // ─── THE FUNDER SAYS YES ────────────────────────────────────────────────
  describe("the funder's own authorization", function () {
    it("only the listed funder can authorize, with a cap", async function () {
      const id = await addMember();
      await coord.connect(promoter).proposeFunder(id, bandA.address, 0);
      await expect(coord.connect(stranger).authorizeFunding(id, $(10))).to.be.revertedWithCustomError(coord, "NotFunderSigner");
      await expect(coord.connect(bandA).authorizeFunding(id, 0)).to.be.revertedWithCustomError(coord, "ZeroCap");
      await expect(coord.connect(bandA).authorizeFunding(id, $(10))).to.emit(coord, "FundingAuthorized").withArgs(id, bandA.address, $(10));
      expect((await coord.getFunderAuth(id, bandA.address)).maxDebit).to.equal($(10));
    });

    it("the show's side cannot say yes for a funder, not even for a band in its own tour", async function () {
      const id = await addMember();
      await coord.connect(promoter).proposeFunder(id, bandA.address, 0);
      await expect(coord.connect(promoter).authorizeFunding(id, $(10))).to.be.revertedWithCustomError(coord, "NotFunderSigner");
      await expect(coord.connect(artist).authorizeFunding(id, $(10))).to.be.revertedWithCustomError(coord, "NotFunderSigner");
      expect((await coord.getFunderAuth(id, bandA.address)).authorized).to.equal(false);
    });

    it("a program only goes live once every funder said yes, and the show is signed", async function () {
      const id = await addMember();
      await coord.connect(promoter).proposeFunder(id, bandA.address, 0);
      await coord.connect(promoter).proposeFunder(id, bandB.address, 0);
      await coord.connect(bandA).authorizeFunding(id, $(10));
      await sign();
      expect(await coord.isProgramLive(id)).to.equal(false);          // bandB has not said yes
      expect((await price(fan))[0].discounts.totalDiscount).to.equal(0);
    });

    it("an org wallet funder is spoken for by its owners and admins, not its operators", async function () {
      const [, , , , , , , , , , owner, admin, operator] = await ethers.getSigners();
      const wImpl = await (await ethers.getContractFactory("MiniOrgWallet")).deploy();
      const gImpl = await (await ethers.getContractFactory("MiniOrgGrant")).deploy();
      const of = await (await ethers.getContractFactory("MiniOrgFactory")).deploy(wImpl.target, gImpl.target, sys.registry.target);
      const salt = ethers.id("band");
      const orgAddress = await of.predictMiniOrg(owner.address, salt);       // known before it exists, so the show can pay it

      const b = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("org-funder") }, funding: [], tiers: [tier({ quantity: 10 })],
        sweep: { recipients: [promoter.address, artist.address, orgAddress], bps: [3000, 5000, 2000], notBefore: t0 + 30 * 86_400 + 7_200 },
      }));
      await coordFactory.connect(promoter).createCoordinator(b.show.target, ticket.address);
      const c = await ethers.getContractAt("DiscountCoordinator", await coordFactory.coordinatorOf(b.show.target));

      const made = await (await of.connect(owner).createMiniOrg(salt, ZERO_ADDRESS, [owner.address], ZERO_BYTES32, "")).wait();
      const parse = (r, n) => of.interface.parseLog(r.logs.find((l) => l.address === of.target && of.interface.parseLog(l)?.name === n));
      const org = await ethers.getContractAt("MiniOrgWallet", parse(made, "MiniOrgCreated").args.org);
      expect(org.target).to.equal(orgAddress);
      const attach = async (type, user, role) => {
        const rr = await (await of.connect(owner).createGrant(org.target, type, 0, 0, ZERO_BYTES32, "", [{ user: user.address, role, expiresAt: 0 }])).wait();
        await org.connect(owner).addGrant(parse(rr, "GrantCreated").args.grant);
      };
      await attach(GRANT.ADMIN, admin, ROLE.ADMIN);
      await attach(GRANT.OPERATOR, operator, ROLE.OPERATOR);
      await attach(GRANT.OWNER, owner, ROLE.OWNER);

      await c.connect(promoter).configureMembershipProgram(memberCfg());
      await c.connect(promoter).proposeFunder(1, org.target, 0);
      await expect(c.connect(operator).authorizeFunding(1, $(10))).to.be.revertedWithCustomError(c, "NotFunderSigner");
      await expect(c.connect(stranger).authorizeFunding(1, $(10))).to.be.revertedWithCustomError(c, "NotFunderSigner");
      await c.connect(admin).authorizeFunding(1, $(10));
      expect((await c.getFunderAuth(1, org.target)).authorized).to.equal(true);
      await c.connect(owner).authorizeFunding(1, $(20));
      expect((await c.getFunderAuth(1, org.target)).maxDebit).to.equal($(20));
    });
  });

  // ─── AFTER THE SHOW IS SIGNED ───────────────────────────────────────────
  describe("after the show is signed", function () {
    let id;
    beforeEach(async function () {
      id = await addMember();
      await fund(id, bandA);
      await sign();
    });

    it("programs, funders and authorizations are fixed", async function () {
      await expect(coord.connect(promoter).configureMembershipProgram(memberCfg({ priority: 5 }))).to.be.revertedWithCustomError(coord, "ShowAlreadySigned");
      await expect(coord.connect(promoter).configureDataProgram(dataCfg())).to.be.revertedWithCustomError(coord, "ShowAlreadySigned");
      await expect(coord.connect(promoter).proposeFunder(id, bandB.address, 0)).to.be.revertedWithCustomError(coord, "ShowAlreadySigned");
      await expect(coord.connect(bandA).authorizeFunding(id, $(500))).to.be.revertedWithCustomError(coord, "ShowAlreadySigned");
      expect((await coord.getFunderAuth(id, bandA.address)).maxDebit).to.equal($(100));
    });

    it("the show's side can stop a program, which ends it for future sales", async function () {
      expect((await price(fan))[0].discounts.totalDiscount).to.equal($(5));
      await expect(coord.connect(stranger).stopProgram(id)).to.be.revertedWithCustomError(coord, "NotShowSide");
      await expect(coord.connect(promoter).stopProgram(id)).to.emit(coord, "ProgramStopped").withArgs(id, promoter.address);
      expect(await coord.isProgramLive(id)).to.equal(false);
      expect((await price(fan))[0].discounts.totalDiscount).to.equal(0);
    });

    it("a funder can leave, which ends the program for future sales but not what it already owes", async function () {
      await buy(fan);
      expect(await coord.funderDebit(bandA.address)).to.equal($(5));
      await expect(coord.connect(stranger).withdrawFunding(id)).to.be.revertedWithCustomError(coord, "NotFunderSigner");
      await expect(coord.connect(bandA).withdrawFunding(id)).to.emit(coord, "FundingWithdrawn").withArgs(id, bandA.address);
      expect(await coord.funderDebit(bandA.address)).to.equal($(5));
      expect((await price(fan2))[0].discounts.totalDiscount).to.equal(0);
    });

    it("a program can have a start and an end", async function () {
      const timed = await (async () => {
        // a new coordinator, since this show is already signed
        const b = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
          anchors: { termsHash: ethers.id("timed") }, funding: [], sweep: SWEEP(), tiers: [tier({ quantity: 10 })],
        }));
        await coordFactory.connect(promoter).createCoordinator(b.show.target, ticket.address);
        const c = await ethers.getContractAt("DiscountCoordinator", await coordFactory.coordinatorOf(b.show.target));
        const now = await time.latest();
        await c.connect(promoter).configureMembershipProgram(memberCfg({ effectiveFrom: now + 1_000, effectiveTo: now + 2_000 }));
        await c.connect(promoter).proposeFunder(1, bandA.address, 0);
        await c.connect(bandA).authorizeFunding(1, $(50));
        await b.show.connect(promoter).signTerms();
        await b.show.connect(artist).signTerms();
        return { c, now };
      })();
      expect(await timed.c.isProgramLive(1)).to.equal(false);
      await time.increaseTo(timed.now + 1_500);
      expect(await timed.c.isProgramLive(1)).to.equal(true);
      await time.increaseTo(timed.now + 2_500);
      expect(await timed.c.isProgramLive(1)).to.equal(false);
    });
  });

  // ─── MEMBERSHIP DISCOUNTS ───────────────────────────────────────────────
  describe("membership discounts", function () {
    it("give a member the benefit, and nobody else", async function () {
      const id = await addMember();
      await fund(id, bandA);
      await sign();
      const [q] = await price(fan);
      expect(q.discounts.totalDiscount).to.equal($(5));
      expect(q.pricePaid[0]).to.equal($(15));
      expect((await price(fan2))[0].discounts.totalDiscount).to.equal(0);          // not a member
    });

    it("work once per wallet per show, whatever it buys later", async function () {
      const id = await addMember();
      await fund(id, bandA);
      await sign();
      await buy(fan);
      expect(await coord.redeemed(id, fan.address)).to.equal(true);
      expect((await price(fan))[0].discounts.totalDiscount).to.equal(0);
      expect((await price(fan, [[GA, $(20)], [VIP, $(50)]]))[0].discounts.totalDiscount).to.equal(0);
    });

    it("stop when the membership ends", async function () {
      const id = await addMember();
      await fund(id, bandA);
      await sign();
      expect((await price(fan))[0].discounts.totalDiscount).to.equal($(5));
      await time.increase(31 * 86_400);
      expect((await price(fan))[0].discounts.totalDiscount).to.equal(0);
    });

    it("can ask for a minimum tier", async function () {
      const id = await addMember({ minTierPriority: 5 });                            // the membership tier is priority 1
      await fund(id, bandA);
      await sign();
      expect((await price(fan))[0].discounts.totalDiscount).to.equal(0);
    });

    it("only apply to the ticket types they list", async function () {
      const id = await addMember({ allowedTypeMask: mask(VIP) });
      await fund(id, bandA);
      await sign();
      expect((await price(fan, [[GA, $(20)]]))[0].discounts.totalDiscount).to.equal(0);
      expect((await price(fan, [[GA, $(20)], [VIP, $(50)]]))[0].discounts.itemDiscount.map(Number)).to.deep.equal([0, Number($(5))]);
    });

    it("two bands, two types: $50 VIP and $20 GA cost $45 and $18 (the spec's example)", async function () {
      const a = await addMember({ priority: 1, amount: $(5), allowedTypeMask: mask(VIP) });
      const b = await addMember({ priority: 2, amount: $(2), allowedTypeMask: mask(GA) });
      await fund(a, bandA);
      await fund(b, bandB);
      await sign();
      const [q] = await price(fan, [[VIP, $(50)], [GA, $(20)]]);
      expect([...q.pricePaid]).to.deep.equal([$(45), $(18)]);
      await buy(fan, [[VIP, $(50)], [GA, $(20)]]);
      expect(await coord.funderDebit(bandA.address)).to.equal($(5));
      expect(await coord.funderDebit(bandB.address)).to.equal($(2));
    });

    it("split their cost equally between funders, each charged only its share", async function () {
      const id = await addMember({ amount: $(5) });
      await fund(id, bandA);
      await fund(id, bandB);
      await sign();
      await buy(fan);
      expect(await coord.funderDebit(bandA.address)).to.equal($(2.5));
      expect(await coord.funderDebit(bandB.address)).to.equal($(2.5));
      expect((await coord.getFunderAuth(id, bandA.address)).debited).to.equal($(2.5));
      expect(await coord.totalDebit()).to.equal($(5));
    });

    it("are limited by what a funder may still be charged: the program gives less, never charges more", async function () {
      const id = await addMember({ amount: $(5) });
      await fund(id, bandA, $(3));                                                    // may be charged $3
      await sign();
      const [q] = await price(fan);
      expect(q.discounts.totalDiscount).to.equal($(3));
      await buy(fan);
      expect((await coord.getFunderAuth(id, bandA.address)).debited).to.equal($(3));
      await membership.connect(promoter).grantMembership(1, fan2.address, ZERO_BYTES32, ZERO_BYTES32);
      expect((await price(fan2))[0].discounts.totalDiscount).to.equal(0);              // bandA has nothing left to give
    });

    it("with several funders the one with the least room limits the program", async function () {
      const id = await addMember({ amount: $(10) });
      await fund(id, bandA, $(100));
      await fund(id, bandB, $(2));                                                    // $2 room: an equal split can give at most $4
      await sign();
      expect((await price(fan))[0].discounts.totalDiscount).to.equal($(4));
    });

    it("can have a total budget and a limit on how many buyers take it", async function () {
      const id = await addMember({ amount: $(5), budget: $(7), redemptionCap: 2 });
      await fund(id, bandA);
      await sign();
      await membership.connect(promoter).grantMembership(1, fan2.address, ZERO_BYTES32, ZERO_BYTES32);
      await membership.connect(promoter).grantMembership(1, stranger.address, ZERO_BYTES32, ZERO_BYTES32);
      await buy(fan);
      expect((await price(fan2))[0].discounts.totalDiscount).to.equal($(2));          // $7 budget, $5 used
      await buy(fan2);
      expect((await coord.getProgram(id)).budgetUsed).to.equal($(7));
      expect((await price(stranger))[0].discounts.totalDiscount).to.equal(0);         // budget and the two-buyer limit are both used up
    });

    it("a limit on how many buyers take it works without any budget", async function () {
      const id = await addMember({ amount: $(1), redemptionCap: 1 });
      await fund(id, bandA);
      await sign();
      await membership.connect(promoter).grantMembership(1, fan2.address, ZERO_BYTES32, ZERO_BYTES32);
      await buy(fan);
      expect((await price(fan2))[0].discounts.totalDiscount).to.equal(0);
      expect((await coord.getProgram(id)).redemptions).to.equal(1);
    });

    it("stack in priority order", async function () {
      const a = await addMember({ priority: 1, amount: $(4) });
      const b = await addMember({ priority: 2, amount: $(4) });
      await fund(a, bandA);
      await fund(b, bandB);
      await sign();
      const [q] = await price(fan, [[GA, $(6)]]);                                      // the net of a $6 ticket is $4.40: the first program takes $4, the second what is left
      expect(q.discounts.memberApplied[0]).to.be.gt(q.discounts.memberApplied[1]);
      expect(q.discounts.totalDiscount).to.equal(q.parts[0].net);
    });
  });

  // ─── DATA DISCOUNT ──────────────────────────────────────────────────────
  describe("the data discount", function () {
    let id;
    beforeEach(async function () {
      id = await addData({ maxDiscount: $(1), categoryCount: 2 });                    // 4 cells of $0.25 with two funders
      await fund(id, bandA);
      await fund(id, bandB);
      await sign();
    });

    it("gives what the buyer shares, and each funder pays for its own cells", async function () {
      const [q] = await price(fan2, [[GA, $(20)]], consent([0b11, 0b01]));            // everything to A, one category to B
      expect(q.discounts.dataDiscount).to.equal($(0.75));
      expect([...q.discounts.dataDebits]).to.deep.equal([$(0.5), $(0.25)]);
    });

    it("gives nothing, and charges nobody, to a buyer who shares nothing", async function () {
      expect((await price(fan2, [[GA, $(20)]], NONE))[0].discounts.dataDiscount).to.equal(0);
      expect((await price(fan2, [[GA, $(20)]], consent([0, 0])))[0].discounts.dataDiscount).to.equal(0);
    });

    it("pays only for categories the buyer has data for", async function () {
      const [q] = await price(fan2, [[GA, $(20)]], consent([0b11, 0b11], 0b01));
      expect(q.discounts.dataDiscount).to.equal($(0.5));
    });

    it("never gives a funder more than the categories it was listed for", async function () {
      const b = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("masks") }, funding: [], sweep: SWEEP(), tiers: [tier({ quantity: 10 })],
      }));
      await coordFactory.connect(promoter).createCoordinator(b.show.target, ticket.address);
      const c = await ethers.getContractAt("DiscountCoordinator", await coordFactory.coordinatorOf(b.show.target));
      await c.connect(promoter).configureDataProgram(dataCfg());
      await c.connect(promoter).proposeFunder(1, bandA.address, 0b01);                // only the first category
      await c.connect(bandA).authorizeFunding(1, $(50));
      await b.show.connect(promoter).signTerms();
      await b.show.connect(artist).signTerms();
      const [q] = await c.quote(fan2.address, [0], [$(20)], 800, 200, $(1), consent([0b11]));
      expect(q.discounts.dataDiscount).to.equal($(0.5));                              // 2 cells of $0.50: only the first is received
    });

    it("works once per wallet per show, and keeps the buyer's commitment", async function () {
      const c = consent([0b11, 0b11], 0b11, ethers.id("my consent"));
      await expect(buy(fan2, [[GA, $(20)]], c)).to.emit(coord, "DataClaimed").withArgs(fan2.address, ethers.id("my consent"));
      expect(await coord.dataClaimed(fan2.address)).to.equal(true);
      expect(await coord.dataCommitment(fan2.address)).to.equal(ethers.id("my consent"));
      expect((await price(fan2, [[GA, $(20)]], c))[0].discounts.dataDiscount).to.equal(0);
      expect((await coord.getProgram(id)).redemptions).to.equal(1);
    });

    it("needs one consent value for each funder", async function () {
      await expect(price(fan2, [[GA, $(20)]], consent([0b11]))).to.be.revertedWithCustomError(coord, "ConsentMismatch");
    });

    it("loses a funder's cells when it leaves, and keeps the others'", async function () {
      await coord.connect(bandB).withdrawFunding(id);
      const [q] = await price(fan2, [[GA, $(20)]], consent([0b11, 0b11]));
      expect([...q.discounts.dataDebits]).to.deep.equal([$(0.5), 0n]);
      expect(q.discounts.dataDiscount).to.equal($(0.5));                              // B's half is simply not given
    });

    it("skips a funder that may no longer be charged, and never overdraws it", async function () {
      const b = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("room") }, funding: [], sweep: SWEEP(), tiers: [tier({ quantity: 10 })],
      }));
      await coordFactory.connect(promoter).createCoordinator(b.show.target, ticket.address);
      const c = await ethers.getContractAt("DiscountCoordinator", await coordFactory.coordinatorOf(b.show.target));
      await c.connect(promoter).configureDataProgram(dataCfg());
      await c.connect(promoter).proposeFunder(1, bandA.address, 0b11);
      await c.connect(promoter).proposeFunder(1, bandB.address, 0b11);
      await c.connect(bandA).authorizeFunding(1, $(50));
      await c.connect(bandB).authorizeFunding(1, 1n);                                  // a single unit: not enough for a buyer's cells
      await b.show.connect(promoter).signTerms();
      await b.show.connect(artist).signTerms();
      const [q] = await c.quote(fan2.address, [0], [$(20)], 800, 200, $(1), consent([0b11, 0b11]));
      expect([...q.discounts.dataDebits]).to.deep.equal([$(0.5), 0n]);
    });

    it("has a total budget and a limit on buyers", async function () {
      const b = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("data-caps") }, funding: [], sweep: SWEEP(), tiers: [tier({ quantity: 10 })],
      }));
      await coordFactory.connect(promoter).createCoordinator(b.show.target, ticket.address);
      const c = await ethers.getContractAt("DiscountCoordinator", await coordFactory.coordinatorOf(b.show.target));
      await c.connect(promoter).configureDataProgram(dataCfg({ budget: $(1.5), redemptionCap: 2 }));
      await c.connect(promoter).proposeFunder(1, bandA.address, 0b11);
      await c.connect(bandA).authorizeFunding(1, $(50));
      await b.show.connect(promoter).signTerms();
      await b.show.connect(artist).signTerms();
      const run = async (w) => {
        const a = [w.address, [0], [$(20)], 800, 200, $(1), consent([0b11])];
        const [q, h] = await c.quote(...a);
        await c.connect(ticket).commit(...a, h);
        return q.discounts.dataDiscount;
      };
      expect(await run(fan)).to.equal($(1));
      expect(await run(fan2)).to.equal($(0.5));                                        // only $0.50 of the budget is left
      const [q3] = await c.quote(stranger.address, [0], [$(20)], 800, 200, $(1), consent([0b11]));
      expect(q3.discounts.dataDiscount).to.equal(0);
    });

    it("comes first, ahead of a membership benefit", async function () {
      const bs = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("both") }, funding: [], sweep: SWEEP(), tiers: [tier({ quantity: 10 })],
      }));
      await coordFactory.connect(promoter).createCoordinator(bs.show.target, ticket.address);
      const c = await ethers.getContractAt("DiscountCoordinator", await coordFactory.coordinatorOf(bs.show.target));
      await c.connect(promoter).configureDataProgram(dataCfg());
      await c.connect(promoter).configureMembershipProgram(memberCfg({ amount: $(2) }));
      for (const pid of [1, 2]) { await c.connect(promoter).proposeFunder(pid, bandA.address, 0b11); await c.connect(bandA).authorizeFunding(pid, $(50)); }
      await bs.show.connect(promoter).signTerms();
      await bs.show.connect(artist).signTerms();
      const [q] = await c.quote(fan.address, [0], [$(20)], 800, 200, $(1), consent([0b11]));
      expect(q.discounts.dataDiscount).to.equal($(1));
      expect(q.discounts.memberApplied[0]).to.equal($(2));
      expect(q.pricePaid[0]).to.equal($(17));
    });
  });

  // ─── COMMITTING A SALE ──────────────────────────────────────────────────
  describe("committing a sale", function () {
    let id;
    beforeEach(async function () {
      id = await addMember({ amount: $(5) });
      await fund(id, bandA);
      await sign();
    });

    it("only the ticket contract can commit", async function () {
      const [, h] = await price(fan);
      await expect(coord.connect(stranger).commit(...args(fan, [[GA, $(20)]]), h)).to.be.revertedWithCustomError(coord, "NotTicketContract");
      await expect(coord.connect(promoter).commit(...args(fan, [[GA, $(20)]]), h)).to.be.revertedWithCustomError(coord, "NotTicketContract");
    });

    it("refuses a quote that is not what the contract would give, and one that went stale", async function () {
      const [, h] = await price(fan);
      await expect(coord.connect(ticket).commit(...args(fan, [[GA, $(20)]]), ethers.id("made up"))).to.be.revertedWithCustomError(coord, "QuoteChanged");
      // The wallet's own benefit is used by another order: the old quote no longer holds.
      await buy(fan);
      await expect(coord.connect(ticket).commit(...args(fan, [[GA, $(20)]]), h)).to.be.revertedWithCustomError(coord, "QuoteChanged");
    });

    it("a quote for other tickets or another wallet does not carry over", async function () {
      const [, h] = await price(fan, [[GA, $(20)]]);
      await expect(coord.connect(ticket).commit(...args(fan, [[GA, $(21)]]), h)).to.be.revertedWithCustomError(coord, "QuoteChanged");
      await expect(coord.connect(ticket).commit(...args(fan2, [[GA, $(20)]]), h)).to.be.revertedWithCustomError(coord, "QuoteChanged");
    });

    it("records the redemption, the budget and what the funder owes, and says so", async function () {
      const [, h] = await price(fan);
      await expect(coord.connect(ticket).commit(...args(fan, [[GA, $(20)]]), h))
        .to.emit(coord, "MemberBenefitRedeemed").withArgs(fan.address, id)
        .and.to.emit(coord, "DiscountGranted").withArgs(fan.address, id, 0, $(5))
        .and.to.emit(coord, "FunderDebited").withArgs(id, bandA.address, fan.address, $(5));
      expect(await coord.redeemed(id, fan.address)).to.equal(true);
      expect((await coord.getProgram(id)).budgetUsed).to.equal($(5));
      expect((await coord.getProgram(id)).redemptions).to.equal(1);
      expect(await coord.funderDebit(bandA.address)).to.equal($(5));
    });

    it("records nothing for a buyer who gets no discount", async function () {
      await buy(fan2);
      expect(await coord.totalDebit()).to.equal(0);
      expect((await coord.getProgram(id)).redemptions).to.equal(0);
    });

    it("what funders owe always adds up to what buyers were given, and nobody goes over their cap", async function () {
      const bs = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("conservation") }, funding: [], sweep: SWEEP(),
        tiers: [tier({ quantity: 100, priceUSDC: $(20) }), tier({ quantity: 100, priceUSDC: $(50), ticketType: 3 })],
      }));
      await coordFactory.connect(promoter).createCoordinator(bs.show.target, ticket.address);
      const c = await ethers.getContractAt("DiscountCoordinator", await coordFactory.coordinatorOf(bs.show.target));
      await c.connect(promoter).configureDataProgram(dataCfg({ maxDiscount: $(1.01) }));            // does not split evenly
      await c.connect(promoter).configureMembershipProgram(memberCfg({ priority: 1, amount: $(3.33), allowedTypeMask: mask(VIP) }));
      await c.connect(promoter).configureMembershipProgram(memberCfg({ priority: 2, isPercent: true, amount: 1_250 }));
      const caps = { 1: [$(2), $(2.5)], 2: [$(10)], 3: [$(9)] };                                   // some caps will bite
      await c.connect(promoter).proposeFunder(1, bandA.address, 0b11); await c.connect(bandA).authorizeFunding(1, caps[1][0]);
      await c.connect(promoter).proposeFunder(1, bandB.address, 0b11); await c.connect(bandB).authorizeFunding(1, caps[1][1]);
      await c.connect(promoter).proposeFunder(2, bandA.address, 0); await c.connect(bandA).authorizeFunding(2, caps[2][0]);
      await c.connect(promoter).proposeFunder(3, bandB.address, 0); await c.connect(bandB).authorizeFunding(3, caps[3][0]);
      await bs.show.connect(promoter).signTerms();
      await bs.show.connect(artist).signTerms();

      const buyers = [fan, fan2, stranger, promoter, artist];
      for (const w of buyers) await membership.connect(promoter).grantMembership(1, w.address, ZERO_BYTES32, ZERO_BYTES32);
      let given = 0n;
      for (let i = 0; i < buyers.length; i++) {
        const items = i % 2 === 0 ? [[VIP, $(50)], [GA, $(20)]] : [[GA, $(20)], [GA, $(20)], [VIP, $(50)]];
        const a = [buyers[i].address, items.map((x) => x[0]), items.map((x) => x[1]), 800, 200, $(1), consent([0b11, 0b01], 0b11, ethers.id("c" + i))];
        const [q, h] = await c.quote(...a);
        await c.connect(ticket).commit(...a, h);
        given += q.discounts.totalDiscount;
        for (const [k, pid] of [[0, 1], [1, 2], [2, 3]]) void k, void pid;
      }
      expect(given).to.be.gt(0);
      expect(await c.totalDebit()).to.equal(given);
      expect((await c.funderDebit(bandA.address)) + (await c.funderDebit(bandB.address))).to.equal(given);
      for (const [pid, f, cap] of [[1, bandA, caps[1][0]], [1, bandB, caps[1][1]], [2, bandA, caps[2][0]], [3, bandB, caps[3][0]]]) {
        expect((await c.getFunderAuth(pid, f.address)).debited, `program ${pid}`).to.be.lte(cap);
      }
      let programTotal = 0n;
      for (const pid of [1, 2, 3]) programTotal += (await c.getProgram(pid)).budgetUsed;
      expect(programTotal).to.equal(given);                                                         // the programs' own books agree
    });
  });
});
