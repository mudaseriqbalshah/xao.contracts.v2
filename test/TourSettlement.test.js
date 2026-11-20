// test/TourSettlement.test.js
// The tour's settlement escrow: a show's package arrives here from the show's escrow, and each
// band is paid under its own signed terms.
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { ONE_DAY, PayoutKind, tier, deploySystem, showConfig, createShow, edgeIdOf } = require("./helpers/show");

const $ = (n) => ethers.parseUnits(String(n), 6);
const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;
const Model = { FixedShow: 0, FixedTour: 1, Percentage: 2, MixedShow: 3, MixedTour: 4 };
const PARENTS = 2;

describe("TourSettlementEscrow", function () {
  let sys, usdc, registry, shell, module, moduleFactory;
  let promoter, treasury, tourOwner, bandA, bandB, stranger, agent, buyers;
  let t0, showEnd;
  let tpaA, tpaB;

  // ─── SETUP ──────────────────────────────────────────────────────────────
  async function buildTour(tokenName = "MockERC20") {
    sys = await deploySystem(tokenName);
    usdc = sys.usdc;
    registry = sys.registry;

    const tpaImpl = await (await ethers.getContractFactory("TourParticipationAgreement")).deploy();
    const shellImpl = await (await ethers.getContractFactory("TourShell")).deploy();
    const tourFactory = await (await ethers.getContractFactory("TourFactory")).deploy(shellImpl.target, tpaImpl.target, registry.target);
    const made = await (await tourFactory.connect(tourOwner).createTourShell(ethers.id("tour"), "ipfs://tour", ethers.id("tour-meta"))).wait();
    const log = made.logs.map((l) => { try { return tourFactory.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "TourShellCreated");
    shell = await ethers.getContractAt("TourShell", log.args.shell ?? log.args[0]);

    const mImpl = await (await ethers.getContractFactory("TourSettlementEscrow")).deploy();
    moduleFactory = await (await ethers.getContractFactory("TourSettlementEscrowFactory")).deploy(mImpl.target, sys.factory.target);
    await moduleFactory.connect(tourOwner).createModule(shell.target, usdc.target, tourOwner.address);
    module = await ethers.getContractAt("TourSettlementEscrow", await moduleFactory.moduleOf(shell.target));
    await shell.connect(tourOwner).registerSettlementModule(module.target);

    tpaA = await newTPA(bandA, "tpa-A");
    tpaB = await newTPA(bandB, "tpa-B");
  }

  async function newTPA(band, name) {
    const tx = await shell.connect(tourOwner).createTourParticipationAgreement({
      partyB: band.address, termsHash: ethers.id(name), termsCID: "ipfs://" + name, effectiveFrom: 0, effectiveTo: 0,
      metaHash: ZERO_BYTES32, metaCID: "", supersedes: ZERO_ADDRESS,
    });
    const receipt = await tx.wait();
    const log = receipt.logs.map((l) => { try { return shell.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "TPACreated");
    const tpa = await ethers.getContractAt("TourParticipationAgreement", log.args.tpa);
    await tpa.connect(tourOwner).sign();
    await tpa.connect(band).sign();
    return tpa;
  }

  async function termsFor(tpa, band, model, o = {}) {
    return {
      artistMiniOrg: band.address, tourObligor: tourOwner.address, model, timing: 0,
      fixedAmount: 0, percentageBps: 0, guaranteedFloor: 0,
      revenueBaseHash: ethers.id("base"), cancellationTermsHash: ZERO_BYTES32, reserveRulesHash: ZERO_BYTES32, showEligibilityHash: ZERO_BYTES32,
      coverageDeadline: 0, termsVersionHash: await tpa.termsHash(), ...o,
    };
  }

  // Register a band's terms and have both sides sign them.
  async function agree(tpa, band, model, o) {
    await module.connect(tourOwner).registerArtistTPA(tpa.target, await termsFor(tpa, band, model, o));
    await module.connect(band).signArtistTerms(tpa.target);
    await module.connect(tourOwner).signArtistTerms(tpa.target);
  }

  // A show whose escrow pays this tour: a $300 guarantee and 60% of the sweep go to the module.
  async function newShow(name, o = {}) {
    const b = await createShow(sys.factory, promoter, showConfig(promoter, tourOwner, t0, {
      anchors: { termsHash: ethers.id(name) }, funding: [],
      tiers: [tier({ quantity: 100, priceUSDC: $(20) })],
      payoutRules: [{ to: module.target, kind: PayoutKind.FixedAmount, value: $(300), notBefore: t0 + 15 * ONE_DAY, isGuarantee: true }],
      sweep: { recipients: [promoter.address, module.target], bps: [4000, 6000], notBefore: showEnd },
      ...o,
    }));
    await b.show.connect(promoter).signTerms();
    await b.show.connect(tourOwner).signTerms();
    return b;
  }

  async function link(tpa, b) {
    await shell.connect(tourOwner).linkShowToTPA(tpa.target, b.show.target, ZERO_BYTES32, "");
    const id = edgeIdOf(tpa.target, b.show.target, PARENTS);
    await registry.connect(promoter).confirmEdge(id);
    await registry.connect(tourOwner).confirmEdge(id);
    return id;
  }

  // The show happens: the promoter funds the guarantee, five people buy $20 tickets, and it completes.
  async function playShow(b, tickets = 5) {
    await usdc.mint(promoter.address, $(300));
    await usdc.connect(promoter).approve(b.escrow.target, $(300));
    await b.escrow.connect(promoter).deposit($(300));
    for (let i = 0; i < tickets; i++) {
      await usdc.mint(buyers[i].address, $(20));
      await usdc.connect(buyers[i]).approve(b.ticket.target, $(20));
      await b.ticket.connect(buyers[i]).buyTicket(0);
    }
    await time.increaseTo(Math.max(showEnd, (await time.latest()) + 1));
    await b.escrow.connect(stranger).executeFinalSweep();
  }

  // $300 guarantee + 60% of five $18.60 tickets = $300 + $55.80
  const PACKAGE = $(355.8);

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    [, promoter, , treasury, tourOwner, bandA, bandB, stranger, agent] = signers;
    buyers = signers.slice(9, 20);
    await buildTour();
    t0 = await time.latest();
    showEnd = t0 + 30 * ONE_DAY + 7_200;
  });

  // ─── CREATING THE MODULE ────────────────────────────────────────────────
  describe("creating the module", function () {
    it("is created by the tour's owner, once, and the shell points to it without holding anything", async function () {
      expect(await shell.tourSettlementEscrow()).to.equal(module.target);
      expect(await module.tourShell()).to.equal(shell.target);
      expect(await module.token()).to.equal(usdc.target);
      expect(await module.remainderReceiver()).to.equal(tourOwner.address);
      expect(await moduleFactory.moduleOf(shell.target)).to.equal(module.target);
      await expect(moduleFactory.connect(stranger).createModule(shell.target, usdc.target, stranger.address)).to.be.revertedWithCustomError(moduleFactory, "AlreadyCreated");
      await expect(module.initialize(shell.target, usdc.target, sys.factory.target, tourOwner.address)).to.be.revertedWithCustomError(module, "AlreadyInitialized");
    });

    it("only the owner (or an operator) of a tour can create its module", async function () {
      const tpaImpl = await (await ethers.getContractFactory("TourParticipationAgreement")).deploy();
      const shellImpl = await (await ethers.getContractFactory("TourShell")).deploy();
      const tf = await (await ethers.getContractFactory("TourFactory")).deploy(shellImpl.target, tpaImpl.target, registry.target);
      const made = await (await tf.connect(tourOwner).createTourShell(ethers.id("other"), "x", ZERO_BYTES32)).wait();
      const other = made.logs.map((l) => { try { return tf.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "TourShellCreated").args;
      const addr = other.shell ?? other[0];
      await expect(moduleFactory.connect(stranger).createModule(addr, usdc.target, stranger.address)).to.be.revertedWithCustomError(moduleFactory, "NotTourSide");
      await moduleFactory.connect(tourOwner).createModule(addr, usdc.target, tourOwner.address);
    });

    it("the shell takes a module once, from its owner, and only one that names this shell", async function () {
      await expect(shell.connect(tourOwner).registerSettlementModule(module.target)).to.be.revertedWithCustomError(shell, "SettlementModuleAlreadySet");
      await expect(shell.connect(stranger).registerSettlementModule(module.target)).to.be.revertedWithCustomError(shell, "NotOwner");
    });
  });

  // ─── BAND TERMS ─────────────────────────────────────────────────────────
  describe("a band's pay terms", function () {
    it("are registered by the tour side against a TPA of this tour, and match it", async function () {
      const good = await termsFor(tpaA, bandA, Model.FixedShow, { fixedAmount: $(100) });
      await expect(module.connect(stranger).registerArtistTPA(tpaA.target, good)).to.be.revertedWithCustomError(module, "NotTourSide");
      await expect(module.connect(tourOwner).registerArtistTPA(stranger.address, good)).to.be.revertedWithCustomError(module, "UnknownTPA");
      for (const bad of [
        { artistMiniOrg: bandB.address }, { tourObligor: stranger.address }, { termsVersionHash: ethers.id("other") },
      ]) {
        await expect(module.connect(tourOwner).registerArtistTPA(tpaA.target, { ...good, ...bad })).to.be.revertedWithCustomError(module, "TermsDoNotMatchTPA");
      }
      await expect(module.connect(tourOwner).registerArtistTPA(tpaA.target, good)).to.emit(module, "ArtistTermsRegistered");
      await expect(module.connect(tourOwner).registerArtistTPA(tpaA.target, good)).to.be.revertedWithCustomError(module, "AlreadyRegistered");
      expect((await module.getArtistTerms(tpaA.target)).fixedAmount).to.equal($(100));
      expect(await module.getTPAs()).to.deep.equal([tpaA.target]);
    });

    it("an operator of the tour can register them, but cannot sign for the obligor", async function () {
      await shell.connect(tourOwner).setOperator(agent.address, true);
      await module.connect(agent).registerArtistTPA(tpaA.target, await termsFor(tpaA, bandA, Model.FixedShow, { fixedAmount: $(100) }));
      await expect(module.connect(agent).signArtistTerms(tpaA.target)).to.be.revertedWithCustomError(module, "NotAuthorized");
      await module.connect(tourOwner).signArtistTerms(tpaA.target);
      expect(await module.signedByObligor(tpaA.target)).to.equal(true);
    });

    it("support fixed per show, a share of the package, and the higher of a share and a floor", async function () {
      await module.connect(tourOwner).registerArtistTPA(tpaA.target, await termsFor(tpaA, bandA, Model.Percentage, { percentageBps: 2_500 }));
      await module.connect(tourOwner).registerArtistTPA(tpaB.target, await termsFor(tpaB, bandB, Model.MixedShow, { percentageBps: 1_000, guaranteedFloor: $(50) }));
    });

    it("refuse tour-wide pay, other timings, and values that make no sense", async function () {
      const bad = async (model, o, err) => expect(module.connect(tourOwner).registerArtistTPA(tpaA.target, await termsFor(tpaA, bandA, model, o))).to.be.revertedWithCustomError(module, err);
      await bad(Model.FixedTour, { fixedAmount: 1 }, "UnsupportedModel");
      await bad(Model.MixedTour, { percentageBps: 100, guaranteedFloor: 1 }, "UnsupportedModel");
      await bad(Model.FixedShow, { fixedAmount: 1, timing: 1 }, "UnsupportedModel");
      await bad(Model.FixedShow, { fixedAmount: 0 }, "InvalidTerms");
      await bad(Model.Percentage, { percentageBps: 0 }, "InvalidTerms");
      await bad(Model.Percentage, { percentageBps: 10_001 }, "InvalidTerms");
      await bad(Model.MixedShow, { percentageBps: 1_000, guaranteedFloor: 0 }, "InvalidTerms");
    });

    it("are signed by the band and by the obligor, each for itself", async function () {
      await module.connect(tourOwner).registerArtistTPA(tpaA.target, await termsFor(tpaA, bandA, Model.FixedShow, { fixedAmount: $(100) }));
      await expect(module.connect(stranger).signArtistTerms(tpaA.target)).to.be.revertedWithCustomError(module, "NotAuthorized");
      await expect(module.connect(bandB).signArtistTerms(tpaA.target)).to.be.revertedWithCustomError(module, "NotAuthorized");
      await expect(module.connect(bandA).signArtistTerms(tpaA.target)).to.emit(module, "ArtistTermsSigned").withArgs(tpaA.target, bandA.address, true);
      expect(await module.signedByBand(tpaA.target)).to.equal(true);
      expect(await module.signedByObligor(tpaA.target)).to.equal(false);
      await module.connect(tourOwner).signArtistTerms(tpaA.target);
      await expect(module.connect(stranger).signArtistTerms(tpaB.target)).to.be.revertedWithCustomError(module, "UnknownTPA");
    });

    it("tell the discount side what a band is sure to be paid, once both have signed", async function () {
      await module.connect(tourOwner).registerArtistTPA(tpaA.target, await termsFor(tpaA, bandA, Model.FixedShow, { fixedAmount: $(100) }));
      expect(await module.debtRoute(bandA.address)).to.deep.equal([0n, false]);                 // not signed yet
      await module.connect(bandA).signArtistTerms(tpaA.target);
      await module.connect(tourOwner).signArtistTerms(tpaA.target);
      expect(await module.debtRoute(bandA.address)).to.deep.equal([$(100), false]);
      await agree(tpaB, bandB, Model.Percentage, { percentageBps: 2_000 });
      expect(await module.debtRoute(bandB.address)).to.deep.equal([0n, true]);
      expect(await module.debtRoute(stranger.address)).to.deep.equal([0n, false]);
    });
  });

  // ─── SHOWS ──────────────────────────────────────────────────────────────
  describe("shows", function () {
    it("only a signed show of the official factory, whose escrow pays this module, can be registered", async function () {
      const good = await newShow("ok");
      await expect(module.connect(stranger).registerShow(good.show.target)).to.be.revertedWithCustomError(module, "NotTourSide");
      await expect(module.connect(tourOwner).registerShow(good.show.target)).to.emit(module, "ShowRegistered");
      await expect(module.connect(tourOwner).registerShow(good.show.target)).to.be.revertedWithCustomError(module, "AlreadyRegistered");
      expect(await module.getShows()).to.deep.equal([good.show.target]);

      // a show from another factory is not official
      const otherSys = await deploySystem();
      const foreign = await createShow(otherSys.factory, promoter, showConfig(promoter, tourOwner, t0, {
        anchors: { termsHash: ethers.id("foreign") }, funding: [],
        sweep: { recipients: [promoter.address, module.target], bps: [4000, 6000], notBefore: showEnd },
        payoutRules: [{ to: module.target, kind: PayoutKind.FixedAmount, value: $(1), notBefore: t0 + ONE_DAY, isGuarantee: true }],
      }));
      await foreign.show.connect(promoter).signTerms();
      await foreign.show.connect(tourOwner).signTerms();
      await expect(module.connect(tourOwner).registerShow(foreign.show.target)).to.be.revertedWithCustomError(module, "NotAnOfficialShow");
    });

    it("refuses a show that is not signed, or whose escrow does not pay this module", async function () {
      const unsigned = await createShow(sys.factory, promoter, showConfig(promoter, tourOwner, t0, {
        anchors: { termsHash: ethers.id("unsigned") }, funding: [],
        sweep: { recipients: [promoter.address, module.target], bps: [4000, 6000], notBefore: showEnd },
        payoutRules: [{ to: module.target, kind: PayoutKind.FixedAmount, value: $(1), notBefore: t0 + ONE_DAY, isGuarantee: true }],
      }));
      await expect(module.connect(tourOwner).registerShow(unsigned.show.target)).to.be.revertedWithCustomError(module, "ShowNotSigned");

      const elsewhere = await createShow(sys.factory, promoter, showConfig(promoter, tourOwner, t0, {
        anchors: { termsHash: ethers.id("elsewhere") }, funding: [],
        sweep: { recipients: [promoter.address, tourOwner.address], bps: [4000, 6000], notBefore: showEnd },
        payoutRules: [],
      }));
      await elsewhere.show.connect(promoter).signTerms();
      await elsewhere.show.connect(tourOwner).signTerms();
      await expect(module.connect(tourOwner).registerShow(elsewhere.show.target)).to.be.revertedWithCustomError(module, "ShowDoesNotPayThisContract");
    });

    it("a band's agreement applies to a show only through an active link and signed terms", async function () {
      const b = await newShow("apply");
      await module.connect(tourOwner).registerShow(b.show.target);
      await module.connect(tourOwner).registerArtistTPA(tpaA.target, await termsFor(tpaA, bandA, Model.Percentage, { percentageBps: 2_500 }));
      const id = edgeIdOf(tpaA.target, b.show.target, PARENTS);

      await expect(module.connect(tourOwner).applyShow(tpaA.target, b.show.target, id)).to.be.revertedWithCustomError(module, "TermsNotSigned");
      await module.connect(bandA).signArtistTerms(tpaA.target);                              // the band alone is not enough
      await expect(module.connect(tourOwner).applyShow(tpaA.target, b.show.target, id)).to.be.revertedWithCustomError(module, "TermsNotSigned");
      await module.connect(tourOwner).signArtistTerms(tpaA.target);

      // the link is only proposed: the graph says Pending, so no money moves
      await shell.connect(tourOwner).linkShowToTPA(tpaA.target, b.show.target, ZERO_BYTES32, "");
      await expect(module.connect(tourOwner).applyShow(tpaA.target, b.show.target, id)).to.be.revertedWithCustomError(module, "WrongLink");
      await registry.connect(promoter).confirmEdge(id);
      await expect(module.connect(tourOwner).applyShow(tpaA.target, b.show.target, id)).to.be.revertedWithCustomError(module, "WrongLink");
      await registry.connect(tourOwner).confirmEdge(id);

      await expect(module.connect(stranger).applyShow(tpaA.target, b.show.target, id)).to.be.revertedWithCustomError(module, "NotTourSide");
      // a link for another show, or another kind of edge, does not do
      const other = await newShow("apply-other");
      await module.connect(tourOwner).registerShow(other.show.target);
      await expect(module.connect(tourOwner).applyShow(tpaA.target, other.show.target, id)).to.be.revertedWithCustomError(module, "WrongLink");
      await expect(module.connect(tourOwner).applyShow(tpaA.target, b.show.target, edgeIdOf(b.show.target, tpaA.target, 1))).to.be.revertedWithCustomError(module, "WrongLink");

      await expect(module.connect(tourOwner).applyShow(tpaA.target, b.show.target, id)).to.emit(module, "ShowAppliedToTPA");
      await expect(module.connect(tourOwner).applyShow(tpaA.target, b.show.target, id)).to.be.revertedWithCustomError(module, "AlreadyApplied");
      expect(await module.getAppliedTPAs(b.show.target)).to.deep.equal([tpaA.target]);
    });

    it("the obligor's signature alone is not enough either", async function () {
      const b = await newShow("one-sided");
      await module.connect(tourOwner).registerShow(b.show.target);
      await module.connect(tourOwner).registerArtistTPA(tpaB.target, await termsFor(tpaB, bandB, Model.FixedShow, { fixedAmount: $(100) }));
      await module.connect(tourOwner).signArtistTerms(tpaB.target);
      const id = edgeIdOf(tpaB.target, b.show.target, PARENTS);
      await expect(module.connect(tourOwner).applyShow(tpaB.target, b.show.target, id)).to.be.revertedWithCustomError(module, "TermsNotSigned");
    });

    it("an agreement that has ended cannot be applied to a show", async function () {
      const b = await newShow("ended");
      await module.connect(tourOwner).registerShow(b.show.target);
      await agree(tpaA, bandA, Model.Percentage, { percentageBps: 2_500 });
      const id = await link(tpaA, b);
      await tpaA.connect(bandA).terminate("ipfs://left");
      await expect(module.connect(tourOwner).applyShow(tpaA.target, b.show.target, id)).to.be.revertedWithCustomError(module, "TPANotActive");
    });
  });

  // ─── MONEY IN ───────────────────────────────────────────────────────────
  describe("money coming in", function () {
    let b;
    beforeEach(async function () {
      b = await newShow("money");
      await module.connect(tourOwner).registerShow(b.show.target);
    });

    it("credits exactly what the show's escrow paid, once, however often it is called", async function () {
      await playShow(b);
      expect(await usdc.balanceOf(module.target)).to.equal(PACKAGE);
      await expect(module.connect(stranger).syncShow(b.show.target)).to.emit(module, "ShowSettlementReceived").withArgs(b.show.target, PACKAGE);
      expect(await module.received(b.show.target)).to.equal(PACKAGE);
      expect(await module.cash(b.show.target)).to.equal(PACKAGE);
      await module.connect(stranger).syncShow(b.show.target);
      expect(await module.received(b.show.target)).to.equal(PACKAGE);                         // not twice
      expect(await module.liquid()).to.equal(PACKAGE);
    });

    it("never credits tokens that someone just sent: they are tracked apart and given to no band", async function () {
      await usdc.mint(module.target, $(1_000));
      await module.connect(stranger).syncShow(b.show.target);
      expect(await module.received(b.show.target)).to.equal(0);
      expect(await module.unassigned()).to.equal($(1_000));
      await playShow(b);
      await module.connect(stranger).syncShow(b.show.target);
      await module.connect(stranger).syncShow(b.show.target);                                // and again: the spare tokens are not a second payment
      expect(await module.received(b.show.target)).to.equal(PACKAGE);                         // only what the escrow says it paid
      expect(await module.unassigned()).to.equal($(1_000));
    });

    it("is kept per show: one show's money is not another's", async function () {
      const other = await newShow("money-2");
      await module.connect(tourOwner).registerShow(other.show.target);
      await playShow(b);
      await module.connect(stranger).syncShow(b.show.target);
      await module.connect(stranger).syncShow(other.show.target);
      expect(await module.received(other.show.target)).to.equal(0);
      expect(await module.cash(b.show.target)).to.equal(PACKAGE);
    });

    it("only knows registered shows", async function () {
      await expect(module.syncShow(stranger.address)).to.be.revertedWithCustomError(module, "UnknownShow");
      await expect(module.claimShow(stranger.address)).to.be.revertedWithCustomError(module, "UnknownShow");
    });

    it("credits a payment the token refused only once it has been collected", async function () {
      await buildTour("MockBlockableERC20");
      t0 = await time.latest();
      showEnd = t0 + 30 * ONE_DAY + 7_200;
      const blocked = await newShow("blocked");
      await module.connect(tourOwner).registerShow(blocked.show.target);
      await usdc.setBlocked(module.target, true);
      await playShow(blocked);

      await module.connect(stranger).syncShow(blocked.show.target);
      expect(await module.received(blocked.show.target)).to.equal(0);                         // the escrow says it paid, the tokens are not here
      expect(await usdc.balanceOf(module.target)).to.equal(0);

      await usdc.setBlocked(module.target, false);
      await module.connect(stranger).claimShow(blocked.show.target);
      expect(await module.received(blocked.show.target)).to.equal(PACKAGE);
      expect(await usdc.balanceOf(module.target)).to.equal(PACKAGE);
    });
  });

  // ─── SETTLING A SHOW ────────────────────────────────────────────────────
  describe("settling a show", function () {
    let b;
    async function setUp(bands, name = "settle") {
      b = await newShow(name);
      await module.connect(tourOwner).registerShow(b.show.target);
      for (const [tpa, band, model, o] of bands) {
        await agree(tpa, band, model, o);
        const id = await link(tpa, b);
        await module.connect(tourOwner).applyShow(tpa.target, b.show.target, id);
      }
    }

    it("pays each band under its own terms from that show's money, and the tour side what is left", async function () {
      await setUp([[tpaA, bandA, Model.Percentage, { percentageBps: 2_500 }], [tpaB, bandB, Model.FixedShow, { fixedAmount: $(100) }]]);
      await playShow(b);
      await expect(module.connect(stranger).settleShow(b.show.target)).to.emit(module, "BandGrossEarned").withArgs(bandA.address, b.show.target, $(88.95));

      expect(await module.nominal(b.show.target)).to.equal(PACKAGE);
      expect(await module.earnedGross(b.show.target, tpaA.target)).to.equal($(88.95));
      expect(await module.earnedGross(b.show.target, tpaB.target)).to.equal($(100));
      expect(await module.payableNet(b.show.target, tpaA.target)).to.equal($(88.95));
      expect(await module.remainderOwed(b.show.target)).to.equal($(166.85));

      await expect(module.connect(stranger).releaseBandPayout(b.show.target, tpaA.target)).to.emit(module, "BandPaymentReleased").withArgs(bandA.address, b.show.target, $(88.95));
      await module.connect(stranger).releaseBandPayout(b.show.target, tpaB.target);
      await expect(module.connect(stranger).releaseRemainder(b.show.target)).to.emit(module, "RemainderReleased").withArgs(b.show.target, tourOwner.address, $(166.85));

      expect(await usdc.balanceOf(bandA.address)).to.equal($(88.95));
      expect(await usdc.balanceOf(bandB.address)).to.equal($(100));
      expect(await usdc.balanceOf(tourOwner.address)).to.be.gte($(166.85));
      expect(await usdc.balanceOf(module.target)).to.equal(0);                                // everything is paid out
      expect(await module.liquid()).to.equal(0);
      expect(await module.cash(b.show.target)).to.equal(0);
    });

    it("pays a mixed deal the higher of its share and its floor", async function () {
      await setUp([[tpaA, bandA, Model.MixedShow, { percentageBps: 1_000, guaranteedFloor: $(50) }], [tpaB, bandB, Model.MixedShow, { percentageBps: 1_000, guaranteedFloor: $(20) }]]);
      await playShow(b);
      await module.settleShow(b.show.target);
      expect(await module.earnedGross(b.show.target, tpaA.target)).to.equal($(50));          // 10% of $355.80 is $35.58: the floor is higher
      expect(await module.earnedGross(b.show.target, tpaB.target)).to.equal($(35.58));       // here the share is higher
    });

    it("when the package cannot cover everyone, bands are covered in the order they were applied and the rest is still recorded as earned", async function () {
      await setUp([[tpaA, bandA, Model.FixedShow, { fixedAmount: $(300) }], [tpaB, bandB, Model.FixedShow, { fixedAmount: $(300) }]]);
      await playShow(b);
      await module.settleShow(b.show.target);
      expect(await module.earnedGross(b.show.target, tpaB.target)).to.equal($(300));          // what the contract says it earned
      expect(await module.allocated(b.show.target, tpaA.target)).to.equal($(300));
      expect(await module.allocated(b.show.target, tpaB.target)).to.equal($(55.8));           // what the package could cover
      expect(await module.remainderOwed(b.show.target)).to.equal(0);
    });

    it("an agreement that ended before settlement earns nothing from the show", async function () {
      await setUp([[tpaA, bandA, Model.Percentage, { percentageBps: 2_500 }], [tpaB, bandB, Model.FixedShow, { fixedAmount: $(100) }]]);
      await playShow(b);
      await tpaB.connect(bandB).terminate("ipfs://left");
      await module.settleShow(b.show.target);
      expect(await module.earnedGross(b.show.target, tpaB.target)).to.equal(0);
      expect(await module.earnedGross(b.show.target, tpaA.target)).to.equal($(88.95));
    });

    it("waits for the show to be completed, and is done once", async function () {
      await setUp([[tpaA, bandA, Model.Percentage, { percentageBps: 2_500 }]]);
      await expect(module.settleShow(b.show.target)).to.be.revertedWithCustomError(module, "ShowNotCompleted");
      await expect(module.releaseBandPayout(b.show.target, tpaA.target)).to.be.revertedWithCustomError(module, "ShowNotSettled");
      await expect(module.releaseRemainder(b.show.target)).to.be.revertedWithCustomError(module, "ShowNotSettled");
      await playShow(b);
      await module.settleShow(b.show.target);
      await expect(module.settleShow(b.show.target)).to.be.revertedWithCustomError(module, "ShowAlreadySettled");
      await expect(module.settleShow(stranger.address)).to.be.revertedWithCustomError(module, "UnknownShow");
    });

    it("pays each amount once, and a band nobody applied to gets nothing", async function () {
      await setUp([[tpaA, bandA, Model.Percentage, { percentageBps: 2_500 }]]);
      await playShow(b);
      await module.settleShow(b.show.target);
      await module.releaseBandPayout(b.show.target, tpaA.target);
      await expect(module.releaseBandPayout(b.show.target, tpaA.target)).to.be.revertedWithCustomError(module, "NothingToPay");
      await expect(module.releaseBandPayout(b.show.target, tpaB.target)).to.be.revertedWithCustomError(module, "UnknownTPA");
    });

    it("money that arrives after the show is settled goes to the tour side, never to a band", async function () {
      await setUp([[tpaA, bandA, Model.Percentage, { percentageBps: 2_500 }]]);
      await playShow(b);
      await module.settleShow(b.show.target);
      await module.releaseBandPayout(b.show.target, tpaA.target);
      await module.releaseRemainder(b.show.target);

      await usdc.mint(b.escrow.target, $(100));                                               // a late resale royalty at the show's escrow
      await b.escrow.connect(stranger).distributeLateFunds();
      await module.syncShow(b.show.target);
      const before = await usdc.balanceOf(tourOwner.address);
      await module.releaseRemainder(b.show.target);
      expect((await usdc.balanceOf(tourOwner.address)) - before).to.equal($(60));            // 60% of the $100
      expect(await usdc.balanceOf(bandA.address)).to.equal($(88.95));                        // unchanged
    });

    it("a cancelled show brings the tour nothing, so nobody is paid", async function () {
      await setUp([[tpaA, bandA, Model.FixedShow, { fixedAmount: $(100) }]]);
      await b.escrow.connect(promoter).cancel();
      await b.escrow.connect(stranger).finalizeCancellationPayout();
      await module.settleShow(b.show.target);
      expect(await module.received(b.show.target)).to.equal(0);
      expect(await module.payableNet(b.show.target, tpaA.target)).to.equal(0);
      await expect(module.releaseBandPayout(b.show.target, tpaA.target)).to.be.revertedWithCustomError(module, "NothingToPay");
    });

    it("adds up: what is paid out is exactly what was received", async function () {
      await setUp([[tpaA, bandA, Model.Percentage, { percentageBps: 3_333 }], [tpaB, bandB, Model.MixedShow, { percentageBps: 777, guaranteedFloor: $(10) }]]);
      await playShow(b, 3);
      await module.settleShow(b.show.target);
      await module.releaseBandPayout(b.show.target, tpaA.target);
      await module.releaseBandPayout(b.show.target, tpaB.target);
      await module.releaseRemainder(b.show.target);
      const out = (await usdc.balanceOf(bandA.address)) + (await usdc.balanceOf(bandB.address));
      expect(out + (await module.remainderPaid(b.show.target))).to.equal(await module.received(b.show.target));
      expect(await usdc.balanceOf(module.target)).to.equal(0);
    });
  });
});
