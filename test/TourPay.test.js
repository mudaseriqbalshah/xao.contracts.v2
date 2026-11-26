// test/TourPay.test.js
// Whole-tour pay: one amount for the tour, paid in installments, from the tour contract's own money
// first and the tour obligor for the rest, less the discounts the band funded.
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { ONE_DAY, PayoutKind, tier, deploySystem, showConfig, createShow, edgeIdOf } = require("./helpers/show");

const $ = (n) => ethers.parseUnits(String(n), 6);
const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;
const PARENTS = 2;
const Model = { FixedShow: 0, FixedTour: 1, Percentage: 2, MixedShow: 3, MixedTour: 4 };
const Timing = { AfterShow: 0, Milestone: 1, EndOfTour: 2 };
const Kind = { None: 0, Period: 1, Shows: 2 };

describe("Whole-tour pay", function () {
  let sys, usdc, registry, shell, module, coverage;
  let promoter, tourOwner, bandA, bandB, stranger, buyers;
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

  async function buildTour({ tokenName = "MockERC20", withCoverage = true } = {}) {
    sys = await deploySystem(tokenName);
    usdc = sys.usdc;
    registry = sys.registry;
    const tpaImpl = await (await ethers.getContractFactory("TourParticipationAgreement")).deploy();
    const shellImpl = await (await ethers.getContractFactory("TourShell")).deploy();
    const tf = await (await ethers.getContractFactory("TourFactory")).deploy(shellImpl.target, tpaImpl.target, registry.target);
    const made = await (await tf.connect(tourOwner).createTourShell(ethers.id("tour"), "ipfs://tour", ethers.id("meta"))).wait();
    const log = made.logs.map((l) => { try { return tf.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "TourShellCreated");
    shell = await ethers.getContractAt("TourShell", log.args.shell ?? log.args[0]);

    const mImpl = await (await ethers.getContractFactory("TourSettlementEscrow")).deploy();
    const mf = await (await ethers.getContractFactory("TourSettlementEscrowFactory")).deploy(mImpl.target, sys.factory.target);
    await mf.connect(tourOwner).createModule(shell.target, usdc.target, tourOwner.address);
    module = await ethers.getContractAt("TourSettlementEscrow", await mf.moduleOf(shell.target));
    await shell.connect(tourOwner).registerSettlementModule(module.target);

    const cImpl = await (await ethers.getContractFactory("TourCoverage")).deploy();
    const cf = await (await ethers.getContractFactory("TourCoverageFactory")).deploy(cImpl.target, sys.factory.target);
    await cf.connect(tourOwner).createCoverage(shell.target, usdc.target);
    coverage = await ethers.getContractAt("TourCoverage", await cf.coverageOf(shell.target));
    if (withCoverage) await shell.connect(tourOwner).registerCoverageModule(coverage.target);

    t0 = await time.latest();
    showEnd = t0 + 30 * ONE_DAY + 7_200;
    deadline = t0 + 20 * ONE_DAY;
    tpaA = await newTPA(bandA, "tpa-A");
    tpaB = await newTPA(bandB, "tpa-B");
  }

  async function guarantee(tpa, band, amount) {
    await coverage.connect(tourOwner).registerGuarantee(tpa.target, amount, deadline, ZERO_ADDRESS);
    const id = await coverage.guaranteeCount();
    await coverage.connect(band).signGuarantee(id);
    await coverage.connect(tourOwner).signGuarantee(id);
    return id;
  }

  // cover the guarantee with a deposit so the tour can be started
  async function cover(id, amount) {
    await usdc.mint(stranger.address, amount);
    await usdc.connect(stranger).approve(coverage.target, amount);
    await coverage.connect(stranger).depositCoverage(id, amount);
  }

  const termsFor = async (tpa, band, o = {}) => ({
    artistMiniOrg: band.address, tourObligor: tourOwner.address, model: Model.FixedTour, timing: Timing.Milestone,
    fixedAmount: $(1000), percentageBps: 0, guaranteedFloor: 0,
    revenueBaseHash: ethers.id("base"), cancellationTermsHash: ZERO_BYTES32, reserveRulesHash: ZERO_BYTES32, showEligibilityHash: ZERO_BYTES32,
    coverageDeadline: 0, installmentAmount: $(200), scheduleKind: Kind.Shows, scheduleValue: 2, scheduleStart: 0,
    termsVersionHash: await tpa.termsHash(), ...o,
  });

  async function sign(tpa, band) {
    await module.connect(band).signArtistTerms(tpa.target);
    await module.connect(tourOwner).signArtistTerms(tpa.target);
  }

  // guarantee + terms, signed
  async function tourBand(tpa = tpaA, band = bandA, o = {}) {
    const total = o.fixedAmount ?? $(1000);
    const id = await guarantee(tpa, band, total);
    await module.connect(tourOwner).registerArtistTPA(tpa.target, await termsFor(tpa, band, o));
    await sign(tpa, band);
    return id;
  }

  const perShow = async (tpa, band, amount) => {
    await module.connect(tourOwner).registerArtistTPA(tpa.target, await termsFor(tpa, band, { model: Model.FixedShow, timing: 0, fixedAmount: amount, installmentAmount: 0, scheduleKind: 0, scheduleValue: 0 }));
    await sign(tpa, band);
  };

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
    await module.connect(tourOwner).registerShow(b.show.target);
    return b;
  }

  async function link(tpa, b) {
    await shell.connect(tourOwner).linkShowToTPA(tpa.target, b.show.target, ZERO_BYTES32, "");
    const id = edgeIdOf(tpa.target, b.show.target, PARENTS);
    await registry.connect(promoter).confirmEdge(id);
    await registry.connect(tourOwner).confirmEdge(id);
    await module.connect(tourOwner).applyShow(tpa.target, b.show.target, id);
  }

  // n shows applied to the tour band
  async function shows(n, tpa = tpaA, prefix = "s") {
    const list = [];
    for (let i = 0; i < n; i++) { const b = await newShow(`${prefix}-${i}`); await link(tpa, b); list.push(b); }
    return list;
  }

  async function fundShow(b, amount = $(300)) {
    await usdc.mint(promoter.address, amount);
    await usdc.connect(promoter).approve(b.escrow.target, amount);
    await b.escrow.connect(promoter).deposit(amount);
  }

  // complete the shows ($300 guarantee each goes to the module), not yet settled
  async function complete(list) {
    for (const b of list) await fundShow(b);
    if ((await time.latest()) < showEnd) await time.increaseTo(showEnd);
    for (const b of list) await b.escrow.connect(stranger).executeFinalSweep();
  }
  const settle = async (list) => { for (const b of list) await module.connect(stranger).settleShow(b.show.target); };

  async function obligorHas(amount, allow = amount) {
    await usdc.mint(tourOwner.address, amount);
    await usdc.connect(tourOwner).approve(module.target, allow);
  }
  const bandHas = () => usdc.balanceOf(bandA.address);

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    [, promoter, , , tourOwner, bandA, bandB, stranger] = signers;
    buyers = signers.slice(9, 20);
    await buildTour();
  });

  // ─── THE TERMS ──────────────────────────────────────────────────────────
  describe("the terms", function () {
    it("need a signed tour-wide guarantee of the same amount in the coverage ledger", async function () {
      const reg = async (o) => module.connect(tourOwner).registerArtistTPA(tpaA.target, await termsFor(tpaA, bandA, o));
      await expect(reg()).to.be.revertedWithCustomError(module, "NoTourGuarantee");                  // none
      await coverage.connect(tourOwner).registerGuarantee(tpaA.target, $(1000), deadline, ZERO_ADDRESS);
      await coverage.connect(bandA).signGuarantee(1);
      await expect(reg()).to.be.revertedWithCustomError(module, "NoTourGuarantee");                  // half signed
      await coverage.connect(tourOwner).signGuarantee(1);
      await expect(reg({ fixedAmount: $(999) })).to.be.revertedWithCustomError(module, "NoTourGuarantee");
      await reg();
      expect(await coverage.signedGuaranteeAmount(tpaA.target)).to.equal($(1000));
      expect(await coverage.signedGuaranteeAmount(tpaB.target)).to.equal(0);
    });

    it("need a coverage ledger on the tour at all", async function () {
      await buildTour({ withCoverage: false });
      await expect(module.connect(tourOwner).registerArtistTPA(tpaA.target, await termsFor(tpaA, bandA)))
        .to.be.revertedWithCustomError(module, "NoTourGuarantee");
    });

    it("are agreed before the tour starts", async function () {
      const id = await guarantee(tpaA, bandA, $(1000));
      await cover(id, $(1000));
      await shell.connect(tourOwner).requestTourStart();
      await expect(module.connect(tourOwner).registerArtistTPA(tpaA.target, await termsFor(tpaA, bandA)))
        .to.be.revertedWithCustomError(module, "TourAlreadyStarted");
    });

    it("have a schedule that makes sense", async function () {
      await guarantee(tpaA, bandA, $(1000));
      const bad = async (o, err = "InvalidTerms") =>
        expect(module.connect(tourOwner).registerArtistTPA(tpaA.target, await termsFor(tpaA, bandA, o))).to.be.revertedWithCustomError(module, err);
      await bad({ installmentAmount: 0 });
      await bad({ installmentAmount: $(1001) });
      await bad({ scheduleValue: 0 });
      await bad({ scheduleKind: Kind.None });
      await bad({ scheduleStart: 5 });                                              // a start date belongs to a period schedule
      await bad({ scheduleKind: Kind.Period, scheduleStart: 0 });
      await bad({ timing: Timing.EndOfTour });                                      // nothing to schedule at the end
      await bad({ timing: Timing.EndOfTour, installmentAmount: 0, scheduleKind: 0, scheduleValue: 0, scheduleStart: 1 });
      await bad({ timing: Timing.AfterShow }, "UnsupportedModel");
      await bad({ fixedAmount: 0 });
    });

    it("keep schedules away from per-show models, and leave the pooled tour floor out", async function () {
      const bad = async (o) => expect(module.connect(tourOwner).registerArtistTPA(tpaA.target, await termsFor(tpaA, bandA, o))).to.be.revertedWithCustomError(module, "UnsupportedModel");
      const plain = { model: Model.FixedShow, timing: 0, installmentAmount: 0, scheduleKind: 0, scheduleValue: 0 };
      await bad({ ...plain, installmentAmount: 1 });
      await bad({ ...plain, scheduleKind: Kind.Shows });
      await bad({ ...plain, scheduleValue: 1 });
      await bad({ ...plain, scheduleStart: 1 });
      await bad({ ...plain, timing: Timing.Milestone });
      await bad({ ...plain, model: Model.MixedTour, guaranteedFloor: 1, percentageBps: 1 });
    });

    it("let the band fund discounts up to what it is promised for the tour", async function () {
      await tourBand();
      expect(await module.debtRoute(bandA.address)).to.deep.equal([$(1000), false]);
    });
  });

  // ─── WHAT FALLS DUE ─────────────────────────────────────────────────────
  describe("what falls due", function () {
    it("every so many completed shows, one installment at a time, up to the whole amount", async function () {
      await tourBand(tpaA, bandA, { installmentAmount: $(400) });
      const list = await shows(7);
      expect(await module.completedShows(tpaA.target)).to.equal(0);
      expect(await module.tourDue(tpaA.target)).to.equal(0);
      await complete(list.slice(0, 1));
      expect(await module.completedShows(tpaA.target)).to.equal(1);
      expect(await module.tourDue(tpaA.target)).to.equal(0);                          // one of two
      await complete(list.slice(1, 2));
      expect(await module.tourDue(tpaA.target)).to.equal($(400));                     // completed is enough: not settled yet
      await complete(list.slice(2, 5));
      expect(await module.tourDue(tpaA.target)).to.equal($(800));                     // 5 shows: two installments
      await complete(list.slice(5, 7));
      expect(await module.tourDue(tpaA.target)).to.equal($(1000));                    // the third is only what is left
    });

    it("on a period schedule from its start date", async function () {
      const start = t0 + 5 * ONE_DAY;
      await tourBand(tpaA, bandA, { scheduleKind: Kind.Period, scheduleValue: 7 * ONE_DAY, scheduleStart: start });
      expect(await module.tourDue(tpaA.target)).to.equal(0);
      await time.increaseTo(start);
      expect(await module.tourDue(tpaA.target)).to.equal($(200));
      await time.increaseTo(start + 7 * ONE_DAY - 1);
      expect(await module.tourDue(tpaA.target)).to.equal($(200));
      await time.increaseTo(start + 7 * ONE_DAY);
      expect(await module.tourDue(tpaA.target)).to.equal($(400));
      await time.increaseTo(start + 100 * ONE_DAY);
      expect(await module.tourDue(tpaA.target)).to.equal($(1000));
    });

    it("all at once at the end, and all of it for any schedule once the tour is settling", async function () {
      const idA = await tourBand(tpaA, bandA, { timing: Timing.EndOfTour, installmentAmount: 0, scheduleKind: 0, scheduleValue: 0 });
      const idB = await tourBand(tpaB, bandB, { fixedAmount: $(500) });
      expect(await module.tourDue(tpaA.target)).to.equal(0);
      await cover(idA, $(1000));
      await cover(idB, $(500));
      await shell.connect(tourOwner).requestTourStart();
      expect(await module.tourDue(tpaA.target)).to.equal(0);                          // touring is not the end
      await shell.connect(tourOwner).beginSettlement();
      expect(await module.tourDue(tpaA.target)).to.equal($(1000));
      expect(await module.tourDue(tpaB.target)).to.equal($(500));
    });

    it("not for an agreement that is not signed by both, not a whole-tour one, or that was ended", async function () {
      await guarantee(tpaA, bandA, $(1000));
      await module.connect(tourOwner).registerArtistTPA(tpaA.target, await termsFor(tpaA, bandA, { scheduleKind: Kind.Period, scheduleValue: 1, scheduleStart: 1 }));
      expect(await module.tourDue(tpaA.target)).to.equal(0);                          // unsigned
      await module.connect(bandA).signArtistTerms(tpaA.target);
      expect(await module.tourDue(tpaA.target)).to.equal(0);                          // half signed
      await module.connect(tourOwner).signArtistTerms(tpaA.target);
      expect(await module.tourDue(tpaA.target)).to.equal($(1000));
      await perShow(tpaB, bandB, $(100));
      expect(await module.tourDue(tpaB.target)).to.equal(0);
      await tpaA.connect(bandA).terminate("x");
      expect(await module.tourDue(tpaA.target)).to.equal(0);
      await expect(module.releaseTourPay(tpaA.target)).to.be.revertedWithCustomError(module, "NothingToPay");
    });

    it("pays nothing per show: a show's money is not a whole-tour band's", async function () {
      await tourBand();
      const list = await shows(1);
      await complete(list);
      await settle(list);
      expect(await module.payableNet(list[0].show.target, tpaA.target)).to.equal(0);
      expect(await module.shortfallOwed(list[0].show.target, tpaA.target)).to.equal(0);
      expect(await module.remainderOwed(list[0].show.target)).to.equal($(300));
      expect(await module.remainderOutstanding()).to.equal($(300));
    });
  });

  describe("a share written into whole-tour terms", function () {
    it("earns nothing per show: only the whole amount counts", async function () {
      await tourBand(tpaA, bandA, { percentageBps: 5_000, guaranteedFloor: $(100) });
      const list = await shows(1);
      await complete(list);
      await settle(list);
      expect(await module.earnedGross(list[0].show.target, tpaA.target)).to.equal(0);
      expect(await module.payableNet(list[0].show.target, tpaA.target)).to.equal(0);
      expect(await module.shortfallOwed(list[0].show.target, tpaA.target)).to.equal(0);
    });
  });

  // the contract money of a show is always what its bands are still owed plus the tour side's share
  describe("the money of a show", function () {
    it("stays accounted for through payments, shortfalls and releases", async function () {
      await tourBand(tpaA, bandA, { installmentAmount: $(400) });
      await perShow(tpaB, bandB, $(500));
      const list = await shows(2);
      await link(tpaB, list[0]);
      await complete(list);
      await settle(list);
      const check = async () => {
        for (const b of list) {
          const s = b.show.target;
          const bands = (await module.payableNet(s, tpaB.target)) - (await module.paid(s, tpaB.target));
          expect(await module.cash(s)).to.equal(bands + (await module.remainderOwed(s)) - (await module.remainderPaid(s)));
        }
      };
      await check();
      await obligorHas($(1000));
      await module.collectShortfall(list[0].show.target, tpaB.target);
      await check();
      await module.releaseTourPay(tpaA.target);
      await check();
      await module.releaseBandPayout(list[0].show.target, tpaB.target);
      await check();
      await module.releaseRemainder(list[1].show.target).catch(() => {});
      await check();
    });
  });

  // ─── PAYING IT ──────────────────────────────────────────────────────────
  describe("paying an installment", function () {
    let list;
    async function due(o = {}, n = 2) {
      await tourBand(tpaA, bandA, o);
      list = await shows(n);
      await complete(list);
      await settle(list);                                                             // each show leaves $300 to the tour side
    }

    it("comes from the tour contract's own money first", async function () {
      await due();                                                                     // $200 due, $600 held for the tour side
      await expect(module.connect(stranger).releaseTourPay(tpaA.target))
        .to.emit(module, "TourPaymentReleased").withArgs(tpaA.target, bandA.address, $(200), 0);
      expect(await bandHas()).to.equal($(200));
      expect(await module.tourPaid(tpaA.target)).to.equal($(200));
      expect(await module.remainderOutstanding()).to.equal($(400));
      expect(await module.remainderOwed(list[0].show.target)).to.equal($(100));
      expect(await module.cash(list[0].show.target)).to.equal($(100));
      expect(await module.liquid()).to.equal($(400));
      expect(await usdc.balanceOf(module.target)).to.equal($(400));
      expect(await module.tourOwedNow(tpaA.target)).to.equal(0);
      await expect(module.releaseTourPay(tpaA.target)).to.be.revertedWithCustomError(module, "NothingToPay");
    });

    it("takes from one show after another, and the obligor for what the shows do not cover", async function () {
      await due({ installmentAmount: $(700), fixedAmount: $(1000) });                  // $700 due, $600 held
      await obligorHas($(1000));
      await expect(module.releaseTourPay(tpaA.target)).to.emit(module, "TourPaymentReleased").withArgs(tpaA.target, bandA.address, $(600), $(100));
      expect(await bandHas()).to.equal($(700));
      expect(await usdc.balanceOf(tourOwner.address)).to.equal($(900));
      expect(await module.remainderOutstanding()).to.equal(0);
      expect(await module.inBreach(tpaA.target)).to.equal(false);
    });

    it("records what nobody could pay, and pays it when the obligor can", async function () {
      await due({ installmentAmount: $(700), fixedAmount: $(1000) });
      await obligorHas($(1000), $(40));                                                 // approves only $40
      await expect(module.releaseTourPay(tpaA.target)).to.emit(module, "PaymentMissed").withArgs(tpaA.target, ZERO_ADDRESS, $(60));
      expect(await module.tourPaid(tpaA.target)).to.equal($(640));
      expect(await module.tourMissed(tpaA.target)).to.equal($(60));
      expect(await module.inBreach(tpaA.target)).to.equal(true);
      expect(await module.tourOwedNow(tpaA.target)).to.equal($(60));

      await usdc.connect(tourOwner).approve(module.target, $(1000));
      await module.releaseTourPay(tpaA.target);
      expect(await bandHas()).to.equal($(700));
      expect(await module.tourMissed(tpaA.target)).to.equal(0);
      expect(await module.inBreach(tpaA.target)).to.equal(false);
    });

    it("does not use money a per-show band is still owed, or a show that is not settled", async function () {
      await tourBand(tpaA, bandA, { installmentAmount: $(600) });
      await perShow(tpaB, bandB, $(250));
      list = await shows(2);
      await link(tpaB, list[0]);
      await complete(list);
      await settle([list[0]]);                                                          // the second is completed but not settled
      await obligorHas($(1000));
      await expect(module.releaseTourPay(tpaA.target)).to.emit(module, "TourPaymentReleased").withArgs(tpaA.target, bandA.address, $(50), $(550));
      expect(await module.payableNet(list[0].show.target, tpaB.target)).to.equal($(250));
      await module.releaseBandPayout(list[0].show.target, tpaB.target);                 // band B's money is intact
      expect(await usdc.balanceOf(bandB.address)).to.equal($(250));
    });

    it("keeps the tour side from taking what a waiting installment needs, but not more", async function () {
      await due({ installmentAmount: $(400) });                                         // $400 waiting, $600 held
      await expect(module.releaseRemainder(list[0].show.target)).to.emit(module, "RemainderReleased").withArgs(list[0].show.target, tourOwner.address, $(200));
      await expect(module.releaseRemainder(list[1].show.target)).to.be.revertedWithCustomError(module, "NothingToPay");
      await module.releaseTourPay(tpaA.target);
      expect(await bandHas()).to.equal($(400));                                          // all from the contract, nobody was asked
      expect(await module.remainderOutstanding()).to.equal(0);
    });

    it("lets the tour side take its share once nothing is waiting", async function () {
      await due();
      await module.releaseTourPay(tpaA.target);
      await module.releaseRemainder(list[0].show.target);
      await module.releaseRemainder(list[1].show.target);
      expect(await module.remainderOutstanding()).to.equal(0);
      expect(await usdc.balanceOf(module.target)).to.equal(0);
    });

    it("records the shortfall when the token will not move the obligor's money", async function () {
      await buildTour({ tokenName: "MockFalseTransferFromERC20" });
      await tourBand(tpaA, bandA, { scheduleKind: Kind.Period, scheduleValue: 1_000_000, scheduleStart: 1 });
      await obligorHas($(1000));
      await usdc.setFailTransferFrom(true);
      await expect(module.releaseTourPay(tpaA.target)).to.emit(module, "PaymentMissed");
      expect(await module.tourPaid(tpaA.target)).to.equal(0);
      expect(await module.inBreach(tpaA.target)).to.equal(true);
    });
  });

  // ─── CLOSING ────────────────────────────────────────────────────────────
  describe("closing the tour", function () {
    it("waits for the whole amount to be paid", async function () {
      const id = await tourBand(tpaA, bandA, { timing: Timing.EndOfTour, installmentAmount: 0, scheduleKind: 0, scheduleValue: 0 });
      await cover(id, $(1000));
      await shell.connect(tourOwner).requestTourStart();
      await shell.connect(tourOwner).beginSettlement();
      expect(await module.canClose()).to.equal(false);
      await expect(shell.connect(tourOwner).closeTour()).to.be.revertedWithCustomError(shell, "CannotClose");
      await obligorHas($(1000));
      await module.releaseTourPay(tpaA.target);
      expect(await module.canClose()).to.equal(true);
      await shell.connect(tourOwner).closeTour();
    });

    it("does not let a tour be abandoned while a whole-tour agreement is in force", async function () {
      await tourBand();
      expect(await module.canClose()).to.equal(false);
      await expect(shell.connect(tourOwner).closeTour()).to.be.revertedWithCustomError(shell, "CannotClose");
      await tpaA.connect(tourOwner).terminate("x");
      expect(await module.canClose()).to.equal(true);
      await shell.connect(tourOwner).closeTour();
    });
  });

  // ─── DISCOUNTS ──────────────────────────────────────────────────────────
  describe("discounts the band funded", function () {
    const NO_CONSENT = { availableMask: 0, grantedMasks: [], commitment: ZERO_BYTES32 };
    async function membership() {
      const impl = await (await ethers.getContractFactory("FanMembership")).deploy();
      const f = await (await ethers.getContractFactory("FanMembershipFactory")).deploy(impl.target);
      const r = await (await f.connect(promoter).createProgram({
        issuer: promoter.address, scopeType: 0, scopeRef: tourOwner.address, name: "Fans", symbol: "F", baseURI: "",
        renewable: true, maxSupply: 0, paymentToken: ZERO_ADDRESS, paymentReceiver: ZERO_ADDRESS, saleStart: 0, saleEnd: 0,
      })).wait();
      const m = await ethers.getContractAt("FanMembership", f.interface.parseLog(r.logs.find((l) => l.address === f.target)).args.program);
      await m.connect(promoter).createTier("Member", "", 1, 365 * ONE_DAY, 0, 0, 0, false);
      for (const w of buyers.slice(0, 3)) await m.connect(promoter).grantMembership(1, w.address, ZERO_BYTES32, ZERO_BYTES32);
      return m;
    }

    it("come off its whole-tour pay", async function () {
      await tourBand(tpaA, bandA, { timing: Timing.EndOfTour, installmentAmount: 0, scheduleKind: 0, scheduleValue: 0 });
      const m = await membership();
      const b = await createShow(sys.factory, promoter, showConfig(promoter, tourOwner, t0, {
        anchors: { termsHash: ethers.id("tour-discounts") }, funding: [],
        tiers: [tier({ quantity: 100, priceUSDC: $(20) })], tickets: { discountsEnabled: true },
        payoutRules: [{ to: module.target, kind: PayoutKind.FixedAmount, value: $(300), notBefore: t0 + 15 * ONE_DAY, isGuarantee: true }],
        sweep: { recipients: [promoter.address, module.target], bps: [4000, 6000], notBefore: showEnd },
      }));
      await b.discounts.connect(promoter).configureMembershipProgram({
        membership: m.target, minTierPriority: 0, isPercent: false, amount: $(2), priority: 1, allowedTypeMask: 1n, budget: 0, redemptionCap: 0, effectiveFrom: 0, effectiveTo: 0,
      });
      await b.discounts.connect(promoter).proposeFunder(1, bandA.address, 0);
      await b.discounts.connect(bandA).authorizeFunding(1, $(300));
      await b.show.connect(promoter).signTerms();
      await b.show.connect(tourOwner).signTerms();
      await module.connect(tourOwner).registerShow(b.show.target);
      await link(tpaA, b);
      await cover(1n, $(1000));
      await shell.connect(tourOwner).requestTourStart();                                  // before the shows are played

      await fundShow(b);
      for (const w of buyers.slice(0, 3)) {
        const price = (await b.ticket.tiers(0)).priceUSDC;
        const [q, h] = await b.discounts.quote(w.address, [0], [price], await b.ticket.salesTaxBPS(), 200, $(1), NO_CONSENT);
        await usdc.mint(w.address, q.checkoutTotal);
        await usdc.connect(w).approve(b.ticket.target, q.checkoutTotal);
        await b.ticket.connect(w).buyTickets([0], NO_CONSENT, h, q.checkoutTotal);
      }
      await time.increaseTo(showEnd);
      await b.escrow.connect(stranger).executeFinalSweep();
      await module.connect(stranger).settleShow(b.show.target);

      const debt = await b.discounts.funderDebit(bandA.address);
      expect(debt).to.equal($(6));
      expect(await module.tourDebt(tpaA.target)).to.equal(debt);

      await shell.connect(tourOwner).beginSettlement();
      expect(await module.tourOwedNow(tpaA.target)).to.equal($(1000) - debt);
      await obligorHas($(1000));
      await module.releaseTourPay(tpaA.target);
      expect(await bandHas()).to.equal($(1000) - debt);
      expect(await module.cash(b.show.target)).to.equal(0);                               // the contract money went into the payment
      expect(await module.canClose()).to.equal(true);
    });
  });
});
