// test/TourLifecycle.test.js
// The tour's life: Booking -> Touring -> Settling -> Closed. Starting needs every tour-wide guarantee
// covered; settling and closing shut the doors that must be shut and give back what is left.
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { ONE_DAY, PayoutKind, tier, deploySystem, showConfig, createShow, edgeIdOf } = require("./helpers/show");

const $ = (n) => ethers.parseUnits(String(n), 6);
const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;
const PARENTS = 2;
const Model = { FixedShow: 0 };
const State = { Booking: 0, Touring: 1, Settling: 2, Closed: 3 };

describe("Tour lifecycle", function () {
  let sys, usdc, registry, shell, module, coverage;
  let promoter, tourOwner, bandA, bandB, stranger, agent, funder, buyers;
  let t0, showEnd, deadline;
  let tpaA, tpaB;

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

  // withModules: register the settlement escrow and the coverage ledger on the shell
  async function buildTour({ settlement = true, coverageModule = true } = {}) {
    sys = await deploySystem();
    usdc = sys.usdc;
    registry = sys.registry;
    const tpaImpl = await (await ethers.getContractFactory("TourParticipationAgreement")).deploy();
    const shellImpl = await (await ethers.getContractFactory("TourShell")).deploy();
    const tourFactory = await (await ethers.getContractFactory("TourFactory")).deploy(shellImpl.target, tpaImpl.target, registry.target);
    const made = await (await tourFactory.connect(tourOwner).createTourShell(ethers.id("tour"), "ipfs://tour", ethers.id("tour-meta"))).wait();
    const log = made.logs.map((l) => { try { return tourFactory.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "TourShellCreated");
    shell = await ethers.getContractAt("TourShell", log.args.shell ?? log.args[0]);

    const mImpl = await (await ethers.getContractFactory("TourSettlementEscrow")).deploy();
    const moduleFactory = await (await ethers.getContractFactory("TourSettlementEscrowFactory")).deploy(mImpl.target, sys.factory.target);
    await moduleFactory.connect(tourOwner).createModule(shell.target, usdc.target, tourOwner.address);
    module = await ethers.getContractAt("TourSettlementEscrow", await moduleFactory.moduleOf(shell.target));
    if (settlement) await shell.connect(tourOwner).registerSettlementModule(module.target);

    const cImpl = await (await ethers.getContractFactory("TourCoverage")).deploy();
    const coverageFactory = await (await ethers.getContractFactory("TourCoverageFactory")).deploy(cImpl.target, sys.factory.target);
    await coverageFactory.connect(tourOwner).createCoverage(shell.target, usdc.target);
    coverage = await ethers.getContractAt("TourCoverage", await coverageFactory.coverageOf(shell.target));
    if (coverageModule) await shell.connect(tourOwner).registerCoverageModule(coverage.target);

    tpaA = await newTPA(bandA, "tpa-A");
    tpaB = await newTPA(bandB, "tpa-B");
  }

  async function guarantee(tpa, band, amount, dl = deadline) {
    await coverage.connect(tourOwner).registerGuarantee(tpa.target, amount, dl, ZERO_ADDRESS);
    const id = await coverage.guaranteeCount();
    await coverage.connect(band).signGuarantee(id);
    await coverage.connect(tourOwner).signGuarantee(id);
    return id;
  }

  async function putIn(id, who, amount) {
    await usdc.mint(who.address, amount);
    await usdc.connect(who).approve(coverage.target, amount);
    return coverage.connect(who).depositCoverage(id, amount);
  }

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

  const linked = new Set();
  async function link(tpa, b) {
    const id = edgeIdOf(tpa.target, b.show.target, PARENTS);
    if (linked.has(id)) return id;
    await shell.connect(tourOwner).linkShowToTPA(tpa.target, b.show.target, ZERO_BYTES32, "");
    await registry.connect(promoter).confirmEdge(id);
    await registry.connect(tourOwner).confirmEdge(id);
    linked.add(id);
    return id;
  }

  async function fund(b, amount) {
    await usdc.mint(promoter.address, amount);
    await usdc.connect(promoter).approve(b.escrow.target, amount);
    await b.escrow.connect(promoter).deposit(amount);
  }

  async function agree(tpa, band) {
    const terms = {
      artistMiniOrg: band.address, tourObligor: tourOwner.address, model: Model.FixedShow, timing: 0,
      fixedAmount: $(100), percentageBps: 0, guaranteedFloor: 0,
      revenueBaseHash: ethers.id("base"), cancellationTermsHash: ZERO_BYTES32, reserveRulesHash: ZERO_BYTES32, showEligibilityHash: ZERO_BYTES32,
      coverageDeadline: 0, termsVersionHash: await tpa.termsHash(),
    };
    await module.connect(tourOwner).registerArtistTPA(tpa.target, terms);
    await module.connect(band).signArtistTerms(tpa.target);
    await module.connect(tourOwner).signArtistTerms(tpa.target);
  }

  // a show that is registered with the module, played and completed
  async function playedShow(name) {
    const b = await newShow(name);
    await module.connect(tourOwner).registerShow(b.show.target);
    await agree(tpaA, bandA);
    const edge = await link(tpaA, b);
    await module.connect(tourOwner).applyShow(tpaA.target, b.show.target, edge);
    await fund(b, $(300));
    for (let i = 0; i < 5; i++) {
      await usdc.mint(buyers[i].address, $(20));
      await usdc.connect(buyers[i]).approve(b.ticket.target, $(20));
      await b.ticket.connect(buyers[i]).buyTicket(0);
    }
    await time.increaseTo(Math.max(showEnd, (await time.latest()) + 1));
    await b.escrow.connect(stranger).executeFinalSweep();
    return b;
  }

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    [, promoter, , , tourOwner, bandA, bandB, stranger, agent, , funder] = signers;
    buyers = signers.slice(11, 20);
    await buildTour();
    t0 = await time.latest();
    showEnd = t0 + 30 * ONE_DAY + 7_200;
    deadline = t0 + 20 * ONE_DAY;
  });

  // ─── THE COVERAGE MODULE ────────────────────────────────────────────────
  describe("naming the coverage ledger", function () {
    it("is done once, by the owner, for a ledger that names this tour", async function () {
      expect(await shell.tourCoverage()).to.equal(coverage.target);
      await expect(shell.connect(tourOwner).registerCoverageModule(coverage.target)).to.be.revertedWithCustomError(shell, "CoverageModuleAlreadySet");

      await buildTour({ coverageModule: false });
      await expect(shell.connect(stranger).registerCoverageModule(coverage.target)).to.be.revertedWithCustomError(shell, "NotOwner");
      await expect(shell.connect(tourOwner).registerCoverageModule(ZERO_ADDRESS)).to.be.revertedWithCustomError(shell, "ZeroAddress");
    });

    it("refuses a ledger that belongs to a different tour", async function () {
      const tpaImpl = await (await ethers.getContractFactory("TourParticipationAgreement")).deploy();
      const shellImpl = await (await ethers.getContractFactory("TourShell")).deploy();
      const tf = await (await ethers.getContractFactory("TourFactory")).deploy(shellImpl.target, tpaImpl.target, registry.target);
      const made = await (await tf.connect(tourOwner).createTourShell(ethers.id("other"), "x", ZERO_BYTES32)).wait();
      const otherShell = await ethers.getContractAt("TourShell", tf.interface.parseLog(made.logs.find((l) => { try { return tf.interface.parseLog(l).name === "TourShellCreated"; } catch { return false; } })).args[0]);
      await expect(otherShell.connect(tourOwner).registerCoverageModule(coverage.target)).to.be.revertedWithCustomError(otherShell, "CoverageModuleNotForThisShell");
    });
  });

  // ─── STARTING THE TOUR ──────────────────────────────────────────────────
  describe("starting", function () {
    it("begins in Booking, and is started by the owner or an operator once", async function () {
      expect(await shell.state()).to.equal(State.Booking);
      await expect(shell.connect(stranger).requestTourStart()).to.be.revertedWithCustomError(shell, "NotOwnerOrOperator");
      await shell.connect(tourOwner).setOperator(agent.address, true);
      await expect(shell.connect(agent).requestTourStart()).to.emit(shell, "TourStarted").withArgs(agent.address);
      expect(await shell.state()).to.equal(State.Touring);
      await expect(shell.connect(tourOwner).requestTourStart()).to.be.revertedWithCustomError(shell, "WrongState");
    });

    it("needs the settlement escrow to be in place", async function () {
      await buildTour({ settlement: false });
      await expect(shell.connect(tourOwner).requestTourStart()).to.be.revertedWithCustomError(shell, "NoSettlementModule");
    });

    it("starts a tour with no coverage ledger, and one with a ledger and nothing to cover", async function () {
      await buildTour({ coverageModule: false });
      expect(await shell.launchReady()).to.equal(true);
      await shell.connect(tourOwner).requestTourStart();
      expect(await shell.state()).to.equal(State.Touring);

      await buildTour();
      expect(await shell.launchReady()).to.equal(true);
      await shell.connect(tourOwner).requestTourStart();
      expect(await coverage.isSealed()).to.equal(true);
    });

    it("does not start while a signed tour-wide guarantee is not covered, and starts once it is", async function () {
      const id = await guarantee(tpaA, bandA, $(1000));
      await coverage.reconcileCoverage();
      expect(await shell.launchReady()).to.equal(false);
      await expect(shell.connect(tourOwner).requestTourStart()).to.be.revertedWithCustomError(shell, "CoverageNotReady");
      expect(await shell.state()).to.equal(State.Booking);

      await putIn(id, funder, $(999));
      await expect(shell.connect(tourOwner).requestTourStart()).to.be.revertedWithCustomError(shell, "CoverageNotReady");   // one dollar short
      await putIn(id, funder, $(1));
      await shell.connect(tourOwner).requestTourStart();                                                                    // no manual reconcile needed
      expect(await shell.state()).to.equal(State.Touring);
      expect(await coverage.launchCleared()).to.equal(true);
      expect(await coverage.isSealed()).to.equal(true);
    });

    it("works the coverage out again at the moment of starting: a show that was cancelled since is noticed", async function () {
      const b = await newShow("cover-show");
      await module.connect(tourOwner).registerShow(b.show.target);
      await fund(b, $(300));
      const id = await guarantee(tpaA, bandA, $(300));
      const edge = await link(tpaA, b);
      await coverage.connect(tourOwner).reserveShow(id, b.show.target, edge, $(300));
      await coverage.reconcileCoverage();
      expect(await coverage.launchCleared()).to.equal(true);
      expect(await shell.launchReady()).to.equal(true);                                  // as of the last reconcile

      await b.escrow.connect(tourOwner).cancel();                                         // the cover is gone, nobody has reconciled
      expect(await shell.launchReady()).to.equal(true);                                  // the stale view still says yes
      await expect(shell.connect(tourOwner).requestTourStart()).to.be.revertedWithCustomError(shell, "CoverageNotReady");
      expect(await shell.state()).to.equal(State.Booking);
    });

    it("is not held up by a guarantee that was never signed, but that guarantee can then never be signed", async function () {
      await coverage.connect(tourOwner).registerGuarantee(tpaA.target, $(5000), deadline, ZERO_ADDRESS);
      await coverage.connect(bandA).signGuarantee(1);                                    // only half signed
      await shell.connect(tourOwner).requestTourStart();
      await expect(coverage.connect(tourOwner).signGuarantee(1)).to.be.revertedWithCustomError(coverage, "Sealed");
      await expect(coverage.connect(bandA).signGuarantee(1)).to.be.revertedWithCustomError(coverage, "Sealed");
    });

    it("does not start when the cover is complete but the coverage deadline has already passed", async function () {
      const id = await guarantee(tpaA, bandA, $(100), t0 + 2 * ONE_DAY);
      await putIn(id, funder, $(100));
      await time.increaseTo(t0 + 3 * ONE_DAY);
      await expect(shell.connect(tourOwner).requestTourStart()).to.be.revertedWithCustomError(shell, "CoverageNotReady");
      expect(await coverage.coverageGap()).to.equal(0);
      expect(await coverage.launchCleared()).to.equal(false);
    });

    it("closes the coverage ledger to new guarantees, but still takes cover", async function () {
      const id = await guarantee(tpaA, bandA, $(100));
      await putIn(id, funder, $(60));
      await putIn(id, funder, $(40));
      await shell.connect(tourOwner).requestTourStart();
      await expect(coverage.connect(tourOwner).registerGuarantee(tpaB.target, $(1), deadline, ZERO_ADDRESS)).to.be.revertedWithCustomError(coverage, "AlreadyCleared");

      await buildTour();                                                                  // a tour that started with nothing to cover
      await shell.connect(tourOwner).requestTourStart();
      await expect(coverage.connect(tourOwner).registerGuarantee(tpaA.target, $(1), deadline, ZERO_ADDRESS)).to.be.revertedWithCustomError(coverage, "Sealed");
    });

    it("can only be sealed by the shell", async function () {
      await expect(coverage.connect(tourOwner).seal()).to.be.revertedWithCustomError(coverage, "NotShell");
      await expect(coverage.connect(stranger).seal()).to.be.revertedWithCustomError(coverage, "NotShell");
    });
  });

  // ─── SETTLING ───────────────────────────────────────────────────────────
  describe("settling", function () {
    it("follows Touring, by the owner or an operator, once", async function () {
      await expect(shell.connect(tourOwner).beginSettlement()).to.be.revertedWithCustomError(shell, "WrongState");        // still Booking
      await shell.connect(tourOwner).requestTourStart();
      await expect(shell.connect(stranger).beginSettlement()).to.be.revertedWithCustomError(shell, "NotOwnerOrOperator");
      await shell.connect(tourOwner).setOperator(agent.address, true);
      await expect(shell.connect(agent).beginSettlement()).to.emit(shell, "SettlementBegun").withArgs(agent.address);
      expect(await shell.state()).to.equal(State.Settling);
      await expect(shell.connect(tourOwner).beginSettlement()).to.be.revertedWithCustomError(shell, "WrongState");
      await expect(shell.connect(tourOwner).requestTourStart()).to.be.revertedWithCustomError(shell, "WrongState");
    });

    it("allows new agreements, links and shows while touring, and none once settling has begun", async function () {
      const b = await newShow("during");
      await shell.connect(tourOwner).requestTourStart();
      const tpaC = await newTPA(bandB, "while-touring");                                  // allowed: the tour is on
      await module.connect(tourOwner).registerShow(b.show.target);
      await agree(tpaA, bandA);
      const edge = await link(tpaA, b);

      await shell.connect(tourOwner).beginSettlement();
      const late = await newShow("late");
      await expect(shell.connect(tourOwner).createTourParticipationAgreement({
        partyB: bandB.address, termsHash: ethers.id("x"), termsCID: "x", effectiveFrom: 0, effectiveTo: 0, metaHash: ZERO_BYTES32, metaCID: "", supersedes: ZERO_ADDRESS,
      })).to.be.revertedWithCustomError(shell, "TourWindingDown");
      await expect(shell.connect(tourOwner).registerTourParticipationAgreement(tpaC.target, ZERO_BYTES32, "")).to.be.revertedWithCustomError(shell, "TourWindingDown");
      await expect(shell.connect(tourOwner).linkShowToTPA(tpaA.target, late.show.target, ZERO_BYTES32, "")).to.be.revertedWithCustomError(shell, "TourWindingDown");
      await expect(module.connect(tourOwner).registerShow(late.show.target)).to.be.revertedWithCustomError(module, "TourWindingDown");
      await expect(module.connect(tourOwner).applyShow(tpaA.target, b.show.target, edge)).to.be.revertedWithCustomError(module, "TourWindingDown");
      const terms = {
        artistMiniOrg: bandB.address, tourObligor: tourOwner.address, model: Model.FixedShow, timing: 0, fixedAmount: $(1), percentageBps: 0, guaranteedFloor: 0,
        revenueBaseHash: ZERO_BYTES32, cancellationTermsHash: ZERO_BYTES32, reserveRulesHash: ZERO_BYTES32, showEligibilityHash: ZERO_BYTES32, coverageDeadline: 0, termsVersionHash: await tpaB.termsHash(),
      };
      await expect(module.connect(tourOwner).registerArtistTPA(tpaB.target, terms)).to.be.revertedWithCustomError(module, "TourWindingDown");
    });

    it("keeps the doors shut once the tour is closed", async function () {
      const b = await newShow("after-close");
      await shell.connect(tourOwner).requestTourStart();
      await shell.connect(tourOwner).beginSettlement();
      await shell.connect(tourOwner).closeTour();
      await expect(shell.connect(tourOwner).createTourParticipationAgreement({
        partyB: bandB.address, termsHash: ethers.id("z"), termsCID: "x", effectiveFrom: 0, effectiveTo: 0, metaHash: ZERO_BYTES32, metaCID: "", supersedes: ZERO_ADDRESS,
      })).to.be.revertedWithCustomError(shell, "TourWindingDown");
      await expect(shell.connect(tourOwner).linkShowToTPA(tpaA.target, b.show.target, ZERO_BYTES32, "")).to.be.revertedWithCustomError(shell, "TourWindingDown");
      await expect(shell.connect(tourOwner).registerTourParticipationAgreement(tpaA.target, ZERO_BYTES32, "")).to.be.revertedWithCustomError(shell, "TourWindingDown");
      await expect(module.connect(tourOwner).registerShow(b.show.target)).to.be.revertedWithCustomError(module, "TourWindingDown");
    });

    it("lets what is already agreed carry on: terms are signed and shows are settled and paid", async function () {
      const b = await playedShow("carry-on");
      await shell.connect(tourOwner).requestTourStart();
      await shell.connect(tourOwner).beginSettlement();
      await module.connect(stranger).settleShow(b.show.target);
      await module.connect(stranger).releaseBandPayout(b.show.target, tpaA.target);
      await module.connect(stranger).releaseRemainder(b.show.target);
    });
  });

  // ─── CLOSING ────────────────────────────────────────────────────────────
  describe("closing", function () {
    it("is done by the owner only, from Settling or from Booking, and not twice", async function () {
      await shell.connect(tourOwner).requestTourStart();
      await expect(shell.connect(tourOwner).closeTour()).to.be.revertedWithCustomError(shell, "WrongState");            // Touring
      await shell.connect(tourOwner).beginSettlement();
      await shell.connect(tourOwner).setOperator(agent.address, true);
      await expect(shell.connect(agent).closeTour()).to.be.revertedWithCustomError(shell, "NotOwner");
      await expect(shell.connect(stranger).closeTour()).to.be.revertedWithCustomError(shell, "NotOwner");
      await expect(shell.connect(tourOwner).closeTour()).to.emit(shell, "TourClosed").withArgs(tourOwner.address);
      expect(await shell.state()).to.equal(State.Closed);
      await expect(shell.connect(tourOwner).closeTour()).to.be.revertedWithCustomError(shell, "WrongState");
      await expect(shell.connect(tourOwner).beginSettlement()).to.be.revertedWithCustomError(shell, "WrongState");
      await expect(shell.connect(tourOwner).requestTourStart()).to.be.revertedWithCustomError(shell, "WrongState");

      await buildTour();
      await shell.connect(tourOwner).closeTour();                                         // abandoned before it started
      expect(await shell.state()).to.equal(State.Closed);
    });

    it("closes a tour that has no settlement escrow named", async function () {
      await buildTour({ settlement: false });
      await shell.connect(tourOwner).closeTour();
      expect(await shell.state()).to.equal(State.Closed);
    });

    it("does not close while a show is unsettled, or money is still held for a band or the tour side", async function () {
      const b = await playedShow("not-yet");
      await shell.connect(tourOwner).requestTourStart();
      await shell.connect(tourOwner).beginSettlement();
      await expect(shell.connect(tourOwner).closeTour()).to.be.revertedWithCustomError(shell, "CannotClose");             // played, not settled

      await module.connect(stranger).settleShow(b.show.target);
      await expect(shell.connect(tourOwner).closeTour()).to.be.revertedWithCustomError(shell, "CannotClose");             // settled, nothing paid out
      await module.connect(stranger).releaseBandPayout(b.show.target, tpaA.target);
      await expect(shell.connect(tourOwner).closeTour()).to.be.revertedWithCustomError(shell, "CannotClose");             // the tour side is still owed
      await module.connect(stranger).releaseRemainder(b.show.target);
      expect(await module.cash(b.show.target)).to.equal(0);
      await shell.connect(tourOwner).closeTour();
      expect(await shell.state()).to.equal(State.Closed);
    });

    it("does not close while a show that has not happened is registered, but does once it is cancelled", async function () {
      const b = await newShow("pending");
      await module.connect(tourOwner).registerShow(b.show.target);
      expect(await module.canClose()).to.equal(false);                                    // signed, not played
      await expect(shell.connect(tourOwner).closeTour()).to.be.revertedWithCustomError(shell, "CannotClose");

      await b.escrow.connect(tourOwner).cancel();
      await b.escrow.connect(stranger).continueRefunds(10);
      await b.escrow.connect(stranger).finalizeCancellationPayout();
      expect(await b.show.status()).to.equal(5);
      expect(await module.canClose()).to.equal(true);                                     // nothing was received
      await shell.connect(tourOwner).closeTour();
    });

    it("counts an expired show that sent nothing as done", async function () {
      const b = await newShow("expires");
      await module.connect(tourOwner).registerShow(b.show.target);
      await time.increaseTo(showEnd + 1);
      await b.show.markExpired();
      expect(await module.canClose()).to.equal(true);
    });

    it("does not count a show that sent money but was never settled as done, even if cancelled later", async function () {
      const b = await playedShow("money-in");
      await module.connect(stranger).syncShow(b.show.target);
      expect(await module.received(b.show.target)).to.be.gt(0);
      expect(await module.canClose()).to.equal(false);
    });

    it("gives a tour with no shows the all clear", async function () {
      expect(await module.canClose()).to.equal(true);
    });
  });

  // ─── CLOSING GIVES COVER BACK ───────────────────────────────────────────
  describe("cover that was put in", function () {
    it("stays locked while the tour is on, and can be taken back once the tour is closed", async function () {
      const id = await guarantee(tpaA, bandA, $(500));
      await putIn(id, funder, $(500));
      await shell.connect(tourOwner).requestTourStart();
      await expect(coverage.connect(funder).withdrawCoverage(id, $(500))).to.be.revertedWithCustomError(coverage, "CoverageLocked");
      await shell.connect(tourOwner).beginSettlement();
      await expect(coverage.connect(funder).withdrawCoverage(id, $(500))).to.be.revertedWithCustomError(coverage, "CoverageLocked");

      await shell.connect(tourOwner).closeTour();
      const before = await usdc.balanceOf(funder.address);
      await coverage.connect(funder).withdrawCoverage(id, $(500));
      expect(await usdc.balanceOf(funder.address)).to.equal(before + $(500));
      expect(await usdc.balanceOf(coverage.target)).to.equal(0);
    });

    it("can be taken back when a tour whose launch was cleared is abandoned before it starts", async function () {
      const id = await guarantee(tpaA, bandA, $(200));
      await putIn(id, funder, $(200));
      await coverage.reconcileCoverage();
      expect(await coverage.launchCleared()).to.equal(true);
      await expect(coverage.connect(funder).withdrawCoverage(id, $(200))).to.be.revertedWithCustomError(coverage, "CoverageLocked");
      await shell.connect(tourOwner).closeTour();
      await coverage.connect(funder).withdrawCoverage(id, $(200));
    });
  });
});
