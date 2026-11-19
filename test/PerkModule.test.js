// test/PerkModule.test.js
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { USDC, ONE_DAY, tier, deploySystem, showConfig, createShow, TICKET_PRICE } = require("./helpers/show");

const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;
const PerkType = { PRESALE_ACCESS: 0, EVENT_ACCESS: 1, POS_DISCOUNT: 2, CLAIMABLE_REWARD: 3, VOUCHER: 4, BADGE: 5 };
const Eligibility = { MEMBERSHIP: 0, TICKET_WINDOW: 1, DIRECT_GRANT: 2 };
const Mode = { PASSIVE: 0, SINGLE_USE: 1, PER_EVENT: 2, CLAIM_ONCE: 3 };
const Reason = { Eligible: 0, UnknownPerk: 1, NotActive: 2, NotStarted: 3, Ended: 4, NotMember: 5, NoQualifyingTicket: 6, NoGrant: 7, AlreadyUsed: 8, CapReached: 9 };
const ROLE = { OPERATOR: ethers.id("ROLE_OPERATOR"), ADMIN: ethers.id("ROLE_ADMIN"), OWNER: ethers.id("ROLE_OWNER"), TREASURER: ethers.id("ROLE_TREASURER") };
const GRANT = { OWNER: ethers.id("OWNER_GRANT"), ADMIN: ethers.id("ADMIN_GRANT"), OPERATOR: ethers.id("OPERATOR_GRANT") };
const EdgeType = { HAS_MODULE: 0 };
const EdgeStatus = { Active: 2 };
const NONE = { ticketTokenId: 0, eventRef: ZERO_BYTES32 };

describe("PerkModule", function () {
  let sys, usdc, memberFactory, membership, perkFactory, impl, perks, bundle;
  let issuer, artist, fan, fan2, stranger, executor;
  let t0;

  function perk(o = {}) {
    return {
      perkType: PerkType.POS_DISCOUNT,
      eligibilityType: Eligibility.MEMBERSHIP,
      eligibilityRef: membership.target,
      minTierPriority: 0,
      windowFrom: 0,
      windowTo: 0,
      benefitValue: 1_000,          // 10%
      isPercent: true,
      benefitTarget: ZERO_BYTES32,
      startTime: 0,
      endTime: 0,
      mode: Mode.PASSIVE,
      maxUsesGlobal: 0,
      metadataURI: "ipfs://perk",
      ...o,
    };
  }

  async function deployModule(creator, init) {
    const receipt = await (await perkFactory.connect(creator).createModule(init)).wait();
    const log = receipt.logs
      .map((l) => { try { return perkFactory.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === "PerkModuleDeployed");
    return ethers.getContractAt("PerkModule", log.args.module);
  }

  const moduleInit = (o = {}) => ({ issuer: issuer.address, scopeType: 0, scopeRef: bundle.show.target, metadataURI: "ipfs://module", ...o });
  const addPerk = async (o = {}, who = issuer) => { await perks.connect(who).createPerk(perk(o)); return perks.perkCount(); };
  const status = (id, who = fan, ctx = NONE) => perks.eligibility(who.address, id, ctx);

  async function buyTicket(who) {
    await usdc.mint(who.address, TICKET_PRICE);
    await usdc.connect(who).approve(bundle.ticket.target, TICKET_PRICE);
    await bundle.ticket.connect(who).buyTicket(0);
    return bundle.ticket.lastMintedId();
  }

  beforeEach(async function () {
    [, issuer, artist, , fan, fan2, stranger, executor] = await ethers.getSigners();
    sys = await deploySystem();
    usdc = sys.usdc;
    t0 = await time.latest();

    // A show whose tickets can be bought, so ticket-based perks have something to look at.
    bundle = await createShow(sys.factory, issuer, showConfig(issuer, artist, t0, {
      anchors: { termsHash: ethers.id("perk-show") }, funding: [], tiers: [tier({ quantity: 100 })],
    }));
    await bundle.show.connect(issuer).signTerms();
    await bundle.show.connect(artist).signTerms();

    // A membership program: Silver (priority 1) for fan2, Gold (priority 5) for fan.
    const mImpl = await (await ethers.getContractFactory("FanMembership")).deploy();
    memberFactory = await (await ethers.getContractFactory("FanMembershipFactory")).deploy(mImpl.target);
    const r = await (await memberFactory.connect(issuer).createProgram({
      issuer: issuer.address, scopeType: 0, scopeRef: artist.address, name: "Fans", symbol: "FANS", baseURI: "ipfs://m/",
      renewable: true, maxSupply: 0, paymentToken: ZERO_ADDRESS, paymentReceiver: ZERO_ADDRESS, saleStart: 0, saleEnd: 0,
    })).wait();
    const program = memberFactory.interface.parseLog(r.logs.find((l) => l.address === memberFactory.target)).args.program;
    membership = await ethers.getContractAt("FanMembership", program);
    await membership.connect(issuer).createTier("Silver", "", 1, 30 * 86_400, 0, 0, 0, false);
    await membership.connect(issuer).createTier("Gold", "", 5, 30 * 86_400, 0, 0, 0, false);
    await membership.connect(issuer).grantMembership(2, fan.address, ZERO_BYTES32, ZERO_BYTES32);
    await membership.connect(issuer).grantMembership(1, fan2.address, ZERO_BYTES32, ZERO_BYTES32);

    impl = await (await ethers.getContractFactory("PerkModule")).deploy();
    perkFactory = await (await ethers.getContractFactory("PerkModuleFactory")).deploy(impl.target);
    perks = await deployModule(issuer, moduleInit());
  });

  // ─── CREATING A MODULE ──────────────────────────────────────────────────
  describe("creating a module", function () {
    it("is created by its issuer and recorded", async function () {
      expect(await perks.issuer()).to.equal(issuer.address);
      expect(await perks.scopeRef()).to.equal(bundle.show.target);
      expect(await perkFactory.getModuleCount()).to.equal(1);
      expect(await perkFactory.getIssuerModules(issuer.address)).to.deep.equal([perks.target]);
    });

    it("cannot be created for someone else, or without an issuer or scope", async function () {
      await expect(perkFactory.connect(stranger).createModule(moduleInit())).to.be.revertedWithCustomError(perkFactory, "NotAuthorized");
      await expect(deployModule(issuer, moduleInit({ scopeRef: ZERO_ADDRESS }))).to.be.revertedWithCustomError(impl, "ZeroScopeRef");
      const F = await ethers.getContractFactory("PerkModuleFactory");
      await expect(F.deploy(ZERO_ADDRESS)).to.be.revertedWithCustomError(F, "ZeroImplementation");
    });

    it("locks the implementation and cannot be set up twice", async function () {
      await expect(impl.initialize(moduleInit())).to.be.revertedWithCustomError(impl, "AlreadyInitialized");
      await expect(perks.initialize(moduleInit())).to.be.revertedWithCustomError(perks, "AlreadyInitialized");
    });
  });

  // ─── DEFINING PERKS ─────────────────────────────────────────────────────
  describe("defining perks", function () {
    it("only the issuer's managers create perks", async function () {
      await expect(perks.connect(stranger).createPerk(perk())).to.be.revertedWithCustomError(perks, "NotManager");
      await expect(perks.connect(fan).setExecutor(executor.address, true)).to.be.revertedWithCustomError(perks, "NotManager");
      await expect(perks.connect(stranger).setPerkActive(1, false)).to.be.revertedWithCustomError(perks, "NotManager");
    });

    it("stores the perk and announces it", async function () {
      await expect(perks.connect(issuer).createPerk(perk({ benefitValue: 500 })))
        .to.emit(perks, "PerkCreated").withArgs(1, PerkType.POS_DISCOUNT, Eligibility.MEMBERSHIP, membership.target, Mode.PASSIVE);
      const p = await perks.getPerk(1);
      expect(p.benefitValue).to.equal(500);
      expect(p.state).to.equal(0);
      expect(p.usesGlobal).to.equal(0);
      await expect(perks.getPerk(2)).to.be.revertedWithCustomError(perks, "UnknownPerk");
    });

    it("refuses perks that make no sense", async function () {
      const bad = (o, err) => expect(perks.connect(issuer).createPerk(perk(o))).to.be.revertedWithCustomError(perks, err);
      await bad({ startTime: 100, endTime: 100 }, "InvalidWindow");
      await bad({ eligibilityRef: stranger.address }, "InvalidEligibility");                              // not a contract
      await bad({ eligibilityType: Eligibility.TICKET_WINDOW, eligibilityRef: bundle.ticket.target, windowFrom: 50, windowTo: 50 }, "InvalidWindow");
      await bad({ benefitValue: 0 }, "InvalidBenefit");
      await bad({ benefitValue: 10_001, isPercent: true }, "InvalidBenefit");
      await bad({ perkType: PerkType.CLAIMABLE_REWARD, mode: Mode.PASSIVE }, "InvalidMode");              // a reward is claimed once
      await bad({ perkType: PerkType.VOUCHER, mode: Mode.CLAIM_ONCE }, "InvalidMode");                    // only rewards are claimed
      await bad({ perkType: PerkType.BADGE, mode: Mode.SINGLE_USE }, "InvalidMode");                      // a badge is only ever looked at
    });

    it("allows at most 200 perks", async function () {
      for (let i = 0; i < 200; i++) await perks.connect(issuer).createPerk(perk({ eligibilityType: Eligibility.DIRECT_GRANT, eligibilityRef: ZERO_ADDRESS, perkType: PerkType.BADGE }));
      await expect(perks.connect(issuer).createPerk(perk())).to.be.revertedWithCustomError(perks, "TooManyPerks");
    });

    it("only the text and the end date of a perk can change", async function () {
      const id = await addPerk({ startTime: t0 + 100 });
      await perks.connect(issuer).updatePerk(id, "ipfs://new", t0 + 5_000);
      const p = await perks.getPerk(id);
      expect(p.metadataURI).to.equal("ipfs://new");
      expect(p.endTime).to.equal(t0 + 5_000);
      expect(p.benefitValue).to.equal(1_000);
      await expect(perks.connect(issuer).updatePerk(id, "x", t0 + 100)).to.be.revertedWithCustomError(perks, "InvalidWindow");
      await expect(perks.connect(stranger).updatePerk(id, "x", 0)).to.be.revertedWithCustomError(perks, "NotManager");
    });

    it("a perk can be paused and resumed, and an archived one is gone for good", async function () {
      const id = await addPerk();
      await expect(perks.connect(issuer).setPerkActive(id, true)).to.be.revertedWithCustomError(perks, "NothingToChange");
      await expect(perks.connect(issuer).setPerkActive(id, false)).to.emit(perks, "PerkDeactivated").withArgs(id);
      expect(await status(id)).to.equal(Reason.NotActive);
      await expect(perks.connect(issuer).setPerkActive(id, true)).to.emit(perks, "PerkActivated").withArgs(id);
      expect(await status(id)).to.equal(Reason.Eligible);
      await expect(perks.connect(issuer).archivePerk(id)).to.emit(perks, "PerkArchived").withArgs(id);
      expect(await status(id)).to.equal(Reason.NotActive);
      await expect(perks.connect(issuer).setPerkActive(id, true)).to.be.revertedWithCustomError(perks, "NothingToChange");
      await expect(perks.connect(issuer).archivePerk(id)).to.be.revertedWithCustomError(perks, "NothingToChange");
    });
  });

  // ─── WHO QUALIFIES: MEMBERSHIP ──────────────────────────────────────────
  describe("membership perks", function () {
    it("members qualify, others do not", async function () {
      const id = await addPerk();
      expect(await status(id, fan)).to.equal(Reason.Eligible);
      expect(await status(id, fan2)).to.equal(Reason.Eligible);
      expect(await status(id, stranger)).to.equal(Reason.NotMember);
      expect(await perks.isEligible(fan.address, id, NONE)).to.equal(true);
      expect(await perks.isEligible(stranger.address, id, NONE)).to.equal(false);
    });

    it("can ask for a minimum tier", async function () {
      const id = await addPerk({ minTierPriority: 5 });                  // Gold only
      expect(await status(id, fan)).to.equal(Reason.Eligible);
      expect(await status(id, fan2)).to.equal(Reason.NotMember);         // Silver is priority 1
    });

    it("stops the moment the membership ends: nothing to revoke", async function () {
      const id = await addPerk();
      expect(await status(id, fan)).to.equal(Reason.Eligible);
      await time.increase(31 * 86_400);
      expect(await status(id, fan)).to.equal(Reason.NotMember);
      expect(await perks.getPOSDiscount(fan.address, id, USDC(20), NONE)).to.equal(0);
    });

    it("a membership address that is not a membership never breaks the check", async function () {
      const id = await addPerk({ eligibilityRef: usdc.target });
      expect(await status(id, fan)).to.equal(Reason.NotMember);
    });
  });

  // ─── WHO QUALIFIES: DIRECT GRANT ────────────────────────────────────────
  describe("direct grants", function () {
    let id;
    beforeEach(async function () {
      id = await addPerk({ perkType: PerkType.BADGE, eligibilityType: Eligibility.DIRECT_GRANT, eligibilityRef: ZERO_ADDRESS });
    });

    it("the issuer hands a perk to a wallet, and takes it back", async function () {
      expect(await status(id, fan)).to.equal(Reason.NoGrant);
      await expect(perks.connect(issuer).grantPerk(id, fan.address)).to.emit(perks, "PerkGranted").withArgs(id, fan.address, issuer.address);
      expect(await status(id, fan)).to.equal(Reason.Eligible);
      expect(await perks.hasStatus(fan.address, id, NONE)).to.equal(true);
      await expect(perks.connect(issuer).grantPerk(id, fan.address)).to.be.revertedWithCustomError(perks, "NothingToChange");
      await expect(perks.connect(issuer).revokeGrant(id, fan.address)).to.emit(perks, "PerkGrantRevoked");
      expect(await status(id, fan)).to.equal(Reason.NoGrant);
      await expect(perks.connect(issuer).revokeGrant(id, fan.address)).to.be.revertedWithCustomError(perks, "NothingToChange");
    });

    it("strangers cannot, and only a direct-grant perk can be granted", async function () {
      await expect(perks.connect(stranger).grantPerk(id, fan.address)).to.be.revertedWithCustomError(perks, "NotOperator");
      await expect(perks.connect(issuer).grantPerk(id, ZERO_ADDRESS)).to.be.revertedWithCustomError(perks, "ZeroWallet");
      const memberPerk = await addPerk();
      await expect(perks.connect(issuer).grantPerk(memberPerk, fan.address)).to.be.revertedWithCustomError(perks, "InvalidEligibility");
    });
  });

  // ─── WHO QUALIFIES: A TICKET BOUGHT IN A WINDOW ─────────────────────────
  describe("ticket-window perks", function () {
    const ticketPerk = (o = {}) => perk({
      perkType: PerkType.EVENT_ACCESS, eligibilityType: Eligibility.TICKET_WINDOW, eligibilityRef: bundle.ticket.target,
      windowFrom: t0, windowTo: 0, ...o,
    });
    const ctxFor = (tokenId) => ({ ticketTokenId: tokenId, eventRef: ZERO_BYTES32 });

    it("qualifies the holder of a ticket bought inside the window, and nobody else", async function () {
      await perks.connect(issuer).createPerk(ticketPerk());
      const token = await buyTicket(fan);
      expect(await status(1, fan, ctxFor(token))).to.equal(Reason.Eligible);
      expect(await perks.hasAccess(fan.address, 1, ctxFor(token))).to.equal(true);
      expect(await status(1, fan, NONE)).to.equal(Reason.NoQualifyingTicket);                   // no ticket shown
      expect(await status(1, fan2, ctxFor(token))).to.equal(Reason.NoQualifyingTicket);         // someone else's ticket
      expect(await status(1, fan, ctxFor(99))).to.equal(Reason.NoQualifyingTicket);             // no such ticket
    });

    it("only counts tickets bought inside the window", async function () {
      const token = await buyTicket(fan);
      const bought = Number((await bundle.ticket.ticketData(token)).mintTime);
      await perks.connect(issuer).createPerk(ticketPerk({ windowFrom: bought + 1_000 }));        // opens later
      await perks.connect(issuer).createPerk(ticketPerk({ windowFrom: 1, windowTo: bought - 1 })); // closed earlier
      await perks.connect(issuer).createPerk(ticketPerk({ windowFrom: bought, windowTo: bought + 1 })); // includes that moment
      expect(await status(1, fan, ctxFor(token))).to.equal(Reason.NoQualifyingTicket);
      expect(await status(2, fan, ctxFor(token))).to.equal(Reason.NoQualifyingTicket);
      expect(await status(3, fan, ctxFor(token))).to.equal(Reason.Eligible);
    });

    it("stops when the ticket is refunded", async function () {
      await perks.connect(issuer).createPerk(ticketPerk());
      const token = await buyTicket(fan);
      expect(await status(1, fan, ctxFor(token))).to.equal(Reason.Eligible);

      await bundle.escrow.connect(artist).cancel();
      await bundle.escrow.connect(stranger).continueRefunds(5);
      expect(await status(1, fan, ctxFor(token))).to.equal(Reason.NoQualifyingTicket);
    });
  });

  // ─── DATES AND UNKNOWN PERKS ────────────────────────────────────────────
  describe("dates", function () {
    it("a perk runs only between its start and end", async function () {
      const id = await addPerk({ startTime: t0 + 1_000, endTime: t0 + 2_000 });
      expect(await status(id)).to.equal(Reason.NotStarted);
      await time.increaseTo(t0 + 1_500);
      expect(await status(id)).to.equal(Reason.Eligible);
      await time.increaseTo(t0 + 2_500);
      expect(await status(id)).to.equal(Reason.Ended);
    });

    it("an unknown perk qualifies nobody", async function () {
      expect(await status(0)).to.equal(Reason.UnknownPerk);
      expect(await status(9)).to.equal(Reason.UnknownPerk);
      expect(await perks.isEligible(fan.address, 9, NONE)).to.equal(false);
      expect(await perks.hasPresaleAccess(fan.address, 9, NONE)).to.equal(false);
    });
  });

  // ─── WHAT A PERK IS WORTH ───────────────────────────────────────────────
  describe("benefits", function () {
    it("each question is only answered by the right kind of perk", async function () {
      const presale = await addPerk({ perkType: PerkType.PRESALE_ACCESS, benefitValue: 0, isPercent: false });
      const access  = await addPerk({ perkType: PerkType.EVENT_ACCESS });
      const badge   = await addPerk({ perkType: PerkType.BADGE });
      const reward  = await addPerk({ perkType: PerkType.CLAIMABLE_REWARD, mode: Mode.CLAIM_ONCE });
      const pos     = await addPerk({ perkType: PerkType.POS_DISCOUNT });

      expect(await perks.hasPresaleAccess(fan.address, presale, NONE)).to.equal(true);
      expect(await perks.hasPresaleAccess(fan.address, access, NONE)).to.equal(false);
      expect(await perks.hasAccess(fan.address, access, NONE)).to.equal(true);
      expect(await perks.hasAccess(fan.address, presale, NONE)).to.equal(false);
      expect(await perks.hasStatus(fan.address, badge, NONE)).to.equal(true);
      expect(await perks.hasStatus(fan.address, pos, NONE)).to.equal(false);
      expect(await perks.canClaim(fan.address, reward, NONE)).to.equal(true);
      expect(await perks.canClaim(fan.address, badge, NONE)).to.equal(false);
      expect(await perks.hasPresaleAccess(stranger.address, presale, NONE)).to.equal(false);
    });

    it("a POS discount is a percentage or a fixed amount, and never more than the price", async function () {
      const pct   = await addPerk({ benefitValue: 1_000, isPercent: true });                  // 10%
      const fixed = await addPerk({ benefitValue: USDC(3), isPercent: false });
      expect(await perks.getPOSDiscount(fan.address, pct, USDC(20), NONE)).to.equal(USDC(2));
      expect(await perks.getPOSDiscount(fan.address, fixed, USDC(20), NONE)).to.equal(USDC(3));
      expect(await perks.getPOSDiscount(fan.address, fixed, USDC(2), NONE)).to.equal(USDC(2));      // capped at the price
      expect(await perks.getPOSDiscount(stranger.address, pct, USDC(20), NONE)).to.equal(0);          // not a member
      expect(await perks.getPOSDiscount(fan.address, 99, USDC(20), NONE)).to.equal(0);
    });

    it("several perks give the best one, never the sum (best of)", async function () {
      const a = await addPerk({ benefitValue: 1_000, isPercent: true });                          // $2 on $20
      const b = await addPerk({ benefitValue: USDC(5), isPercent: false });                       // $5
      const c = await addPerk({ benefitValue: USDC(5), isPercent: false });                       // ties with b
      const gold = await addPerk({ benefitValue: USDC(9), isPercent: false, minTierPriority: 5 }); // fan only
      let [best, id] = await perks.getBestPOSDiscount(fan.address, [a, b, c], USDC(20), NONE);
      expect([best, id]).to.deep.equal([USDC(5), b]);                                              // first of a tie
      [best, id] = await perks.getBestPOSDiscount(fan.address, [a, b, gold], USDC(20), NONE);
      expect([best, id]).to.deep.equal([USDC(9), gold]);
      [best, id] = await perks.getBestPOSDiscount(fan2.address, [a, b, gold], USDC(20), NONE);     // Silver cannot use gold
      expect([best, id]).to.deep.equal([USDC(5), b]);
      [best, id] = await perks.getBestPOSDiscount(stranger.address, [a, b], USDC(20), NONE);
      expect([best, id]).to.deep.equal([0n, 0n]);
      await expect(perks.getBestPOSDiscount(fan.address, Array(51).fill(a), USDC(20), NONE)).to.be.revertedWithCustomError(perks, "TooManyIds");
    });
  });

  // ─── USING A PERK ───────────────────────────────────────────────────────
  describe("using a perk", function () {
    const redeem = (who, id, wallet = fan, ctx = NONE) => perks.connect(who).redeemPerk(id, wallet.address, ctx);

    beforeEach(async function () {
      await perks.connect(issuer).setExecutor(executor.address, true);
    });

    it("only an executor or a manager can record a use", async function () {
      const id = await addPerk({ mode: Mode.SINGLE_USE });
      await expect(redeem(stranger, id)).to.be.revertedWithCustomError(perks, "NotExecutor");
      await expect(redeem(fan, id)).to.be.revertedWithCustomError(perks, "NotExecutor");           // not even the holder
      await expect(redeem(executor, id)).to.emit(perks, "PerkRedeemed").withArgs(id, fan.address, ZERO_BYTES32, executor.address);
      await perks.connect(issuer).setExecutor(executor.address, false);
      const other = await addPerk({ mode: Mode.SINGLE_USE });
      await expect(redeem(executor, other)).to.be.revertedWithCustomError(perks, "NotExecutor");
      await redeem(issuer, other);                                                                  // a manager always can
    });

    it("a single-use perk works once per wallet", async function () {
      const id = await addPerk({ mode: Mode.SINGLE_USE });
      await redeem(executor, id);
      expect(await status(id, fan)).to.equal(Reason.AlreadyUsed);
      expect(await status(id, fan2)).to.equal(Reason.Eligible);                                    // others are unaffected
      await expect(redeem(executor, id)).to.be.revertedWithCustomError(perks, "NotEligible").withArgs(Reason.AlreadyUsed);
      await redeem(executor, id, fan2);
      expect(await perks.getPOSDiscount(fan.address, id, USDC(20), NONE)).to.equal(0);              // and it no longer discounts
    });

    it("a passive perk is never used up, and cannot be recorded", async function () {
      const id = await addPerk({ mode: Mode.PASSIVE });
      await expect(redeem(executor, id)).to.be.revertedWithCustomError(perks, "NotRedeemable");
      expect(await perks.getPOSDiscount(fan.address, id, USDC(20), NONE)).to.equal(USDC(2));
      expect(await perks.getPOSDiscount(fan.address, id, USDC(20), NONE)).to.equal(USDC(2));
    });

    it("a per-event perk works once for each event, and the event is required", async function () {
      const id = await addPerk({ mode: Mode.PER_EVENT });
      const a = { ticketTokenId: 0, eventRef: ethers.id("show-a") };
      const b = { ticketTokenId: 0, eventRef: ethers.id("show-b") };
      await expect(redeem(executor, id, fan, NONE)).to.be.revertedWithCustomError(perks, "EventRefRequired");
      await redeem(executor, id, fan, a);
      expect(await status(id, fan, a)).to.equal(Reason.AlreadyUsed);
      expect(await status(id, fan, b)).to.equal(Reason.Eligible);
      await expect(redeem(executor, id, fan, a)).to.be.revertedWithCustomError(perks, "NotEligible").withArgs(Reason.AlreadyUsed);
      await redeem(executor, id, fan, b);
    });

    it("a perk can have a limit on all its uses together", async function () {
      const id = await addPerk({ mode: Mode.SINGLE_USE, maxUsesGlobal: 1 });
      await redeem(executor, id, fan);
      expect(await status(id, fan2)).to.equal(Reason.CapReached);
      await expect(redeem(executor, id, fan2)).to.be.revertedWithCustomError(perks, "NotEligible").withArgs(Reason.CapReached);
      const s = await perks.getWalletPerkStatus(fan2.address, id, NONE);
      expect([s.reason, s.usesGlobal, s.usesLeft]).to.deep.equal([BigInt(Reason.CapReached), 1n, 0n]);
    });

    it("a use is refused for someone who does not qualify", async function () {
      const id = await addPerk({ mode: Mode.SINGLE_USE });
      await expect(redeem(executor, id, stranger)).to.be.revertedWithCustomError(perks, "NotEligible").withArgs(Reason.NotMember);
    });
  });

  // ─── CLAIMING A REWARD ──────────────────────────────────────────────────
  describe("claiming a reward", function () {
    let id;
    const target = ethers.id("founders-nft");
    beforeEach(async function () {
      id = await addPerk({ perkType: PerkType.CLAIMABLE_REWARD, mode: Mode.CLAIM_ONCE, benefitTarget: target, maxUsesGlobal: 2 });
    });

    it("lets a qualifying wallet claim once, naming where it goes", async function () {
      await expect(perks.connect(fan).claimReward(id, stranger.address, NONE))
        .to.emit(perks, "RewardClaimed").withArgs(id, fan.address, stranger.address, target);
      expect(await status(id, fan)).to.equal(Reason.AlreadyUsed);
      expect(await perks.canClaim(fan.address, id, NONE)).to.equal(false);
      await expect(perks.connect(fan).claimReward(id, fan.address, NONE))
        .to.be.revertedWithCustomError(perks, "NotEligible").withArgs(Reason.AlreadyUsed);
      expect(await perks.walletUses(id, fan.address)).to.equal(1);
    });

    it("refuses wallets that do not qualify, and nobody can claim for someone else", async function () {
      await expect(perks.connect(stranger).claimReward(id, stranger.address, NONE))
        .to.be.revertedWithCustomError(perks, "NotEligible").withArgs(Reason.NotMember);
      expect(await status(id, fan)).to.equal(Reason.Eligible);                                      // fan's claim is untouched
    });

    it("stops at the limit", async function () {
      await perks.connect(fan).claimReward(id, fan.address, NONE);
      await perks.connect(fan2).claimReward(id, fan2.address, NONE);
      await membership.connect(issuer).grantMembership(1, stranger.address, ZERO_BYTES32, ZERO_BYTES32);
      await expect(perks.connect(stranger).claimReward(id, stranger.address, NONE))
        .to.be.revertedWithCustomError(perks, "NotEligible").withArgs(Reason.CapReached);
    });

    it("only a reward can be claimed, and not to the zero address", async function () {
      const other = await addPerk({ perkType: PerkType.POS_DISCOUNT });
      await expect(perks.connect(fan).claimReward(other, fan.address, NONE)).to.be.revertedWithCustomError(perks, "NotClaimable");
      await expect(perks.connect(fan).claimReward(id, ZERO_ADDRESS, NONE)).to.be.revertedWithCustomError(perks, "ZeroWallet");
      await expect(perks.connect(fan).claimReward(99, fan.address, NONE)).to.be.revertedWithCustomError(perks, "UnknownPerk");
    });

    it("a claim-once perk cannot be 'redeemed' by an executor instead", async function () {
      await perks.connect(issuer).setExecutor(executor.address, true);
      await expect(perks.connect(executor).redeemPerk(id, fan.address, NONE)).to.be.revertedWithCustomError(perks, "NotRedeemable");
    });
  });

  // ─── LISTS FOR AN APP ───────────────────────────────────────────────────
  describe("lists for an app", function () {
    it("shows what a wallet qualifies for, what is running, and the state of one perk", async function () {
      const a = await addPerk();                                                  // members
      const b = await addPerk({ minTierPriority: 5 });                            // gold only
      const c = await addPerk({ startTime: t0 + 10_000 });                        // not yet
      const d = await addPerk();
      await perks.connect(issuer).setPerkActive(d, false);                        // paused

      expect((await perks.getWalletActivePerks(fan.address, NONE)).map(Number)).to.deep.equal([a, b].map(Number));
      expect((await perks.getWalletActivePerks(fan2.address, NONE)).map(Number)).to.deep.equal([Number(a)]);
      expect(await perks.getWalletActivePerks(stranger.address, NONE)).to.deep.equal([]);
      expect((await perks.getActivePerks()).map(Number)).to.deep.equal([a, b].map(Number));

      const s = await perks.getWalletPerkStatus(fan.address, a, NONE);
      expect([s.reason, s.usedByWallet, s.usesGlobal, s.usesLeft]).to.deep.equal([0n, false, 0n, 0n]);
      expect((await perks.getWalletPerkStatus(fan.address, 77, NONE)).reason).to.equal(Reason.UnknownPerk);
      expect(c).to.equal(3n);
    });
  });

  // ─── AN ORG AS ISSUER, AND THE GRAPH ────────────────────────────────────
  describe("an org wallet as issuer", function () {
    let org, owner, admin, operator, orgPerks;

    async function makeOrg() {
      [, , , , , , , , owner, admin, operator] = await ethers.getSigners();
      const wImpl = await (await ethers.getContractFactory("MiniOrgWallet")).deploy();
      const gImpl = await (await ethers.getContractFactory("MiniOrgGrant")).deploy();
      const of = await (await ethers.getContractFactory("MiniOrgFactory")).deploy(wImpl.target, gImpl.target, sys.registry.target);
      const created = await (await of.connect(owner).createMiniOrg(ethers.id("venue"), ZERO_ADDRESS, [owner.address], ZERO_BYTES32, "")).wait();
      const parse = (r, name) => of.interface.parseLog(r.logs.find((l) => l.address === of.target && of.interface.parseLog(l)?.name === name));
      const w = await ethers.getContractAt("MiniOrgWallet", parse(created, "MiniOrgCreated").args.org);
      const attach = async (type, user, role) => {
        const rr = await (await of.connect(owner).createGrant(w.target, type, 0, 0, ZERO_BYTES32, "", [{ user: user.address, role, expiresAt: 0 }])).wait();
        await w.connect(owner).addGrant(parse(rr, "GrantCreated").args.grant);
      };
      await attach(GRANT.ADMIN, admin, ROLE.ADMIN);
      await attach(GRANT.OPERATOR, operator, ROLE.OPERATOR);
      await attach(GRANT.OWNER, owner, ROLE.OWNER);
      return w;
    }

    beforeEach(async function () {
      org = await makeOrg();
      orgPerks = await deployModule(operator, moduleInit({ issuer: org.target }));
      await orgPerks.connect(owner).createPerk(perk({ eligibilityType: Eligibility.DIRECT_GRANT, eligibilityRef: ZERO_ADDRESS, perkType: PerkType.BADGE }));
    });

    it("lets the org's owners, admins and operators create the module, and nobody else", async function () {
      await deployModule(owner, moduleInit({ issuer: org.target }));
      await deployModule(admin, moduleInit({ issuer: org.target }));
      await expect(perkFactory.connect(stranger).createModule(moduleInit({ issuer: org.target }))).to.be.revertedWithCustomError(perkFactory, "NotAuthorized");
    });

    it("owners and admins shape the perks; an operator only hands them out", async function () {
      await orgPerks.connect(admin).createPerk(perk());
      await expect(orgPerks.connect(operator).createPerk(perk())).to.be.revertedWithCustomError(orgPerks, "NotManager");
      await expect(orgPerks.connect(operator).setExecutor(executor.address, true)).to.be.revertedWithCustomError(orgPerks, "NotManager");
      await orgPerks.connect(operator).grantPerk(1, fan.address);
      expect(await orgPerks.eligibility(fan.address, 1, NONE)).to.equal(Reason.Eligible);
    });

    it("is a graph node of the org, and the show's party links it to the show as a module", async function () {
      expect(await orgPerks.partyA()).to.equal(org.target);
      expect(await sys.registry.isAuthorizedFor(orgPerks.target, operator.address)).to.equal(true);

      // The show's own party (issuer) says: this show has this perk module.
      const args = [bundle.show.target, perks.target, EdgeType.HAS_MODULE, ZERO_BYTES32, ""];
      const id = await sys.registry.connect(issuer).registerEdge.staticCall(...args);
      await sys.registry.connect(issuer).registerEdge(...args);
      expect(await sys.registry.edgeStatus(id)).to.equal(EdgeStatus.Active);
      await expect(sys.registry.connect(stranger).registerEdge(...args)).to.be.reverted;
    });
  });
});
