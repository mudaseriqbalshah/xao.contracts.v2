// test/TourCoverage.test.js
// Launch coverage: a tour-wide guarantee is covered only by money that is really there, and every
// dollar of cover is counted for one guarantee only.
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { ONE_DAY, PayoutKind, tier, deploySystem, showConfig, createShow, edgeIdOf } = require("./helpers/show");

const $ = (n) => ethers.parseUnits(String(n), 6);
const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;
const PARENTS = 2;

describe("TourCoverage", function () {
  let sys, usdc, registry, shell, module, coverage, coverageFactory;
  let promoter, tourOwner, bandA, bandB, bandC, stranger, agent, funder;
  let t0, showEnd, deadline;
  let tpaA, tpaB, tpaC;

  // ─── SETUP ──────────────────────────────────────────────────────────────
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
    const moduleFactory = await (await ethers.getContractFactory("TourSettlementEscrowFactory")).deploy(mImpl.target, sys.factory.target);
    await moduleFactory.connect(tourOwner).createModule(shell.target, usdc.target, tourOwner.address);
    module = await ethers.getContractAt("TourSettlementEscrow", await moduleFactory.moduleOf(shell.target));
    await shell.connect(tourOwner).registerSettlementModule(module.target);

    const cImpl = await (await ethers.getContractFactory("TourCoverage")).deploy();
    coverageFactory = await (await ethers.getContractFactory("TourCoverageFactory")).deploy(cImpl.target, sys.factory.target);
    await coverageFactory.connect(tourOwner).createCoverage(shell.target, usdc.target);
    coverage = await ethers.getContractAt("TourCoverage", await coverageFactory.coverageOf(shell.target));

    tpaA = await newTPA(bandA, "tpa-A");
    tpaB = await newTPA(bandB, "tpa-B");
    tpaC = await newTPA(bandC, "tpa-C");
  }

  // A tour-wide guarantee for a band, signed by both sides.
  async function guarantee(tpa, band, amount, dl = deadline) {
    await coverage.connect(tourOwner).registerGuarantee(tpa.target, amount, dl, ZERO_ADDRESS);
    const id = await coverage.guaranteeCount();
    await coverage.connect(band).signGuarantee(id);
    await coverage.connect(tourOwner).signGuarantee(id);
    return id;
  }

  // A show whose escrow pays this tour's settlement module a fixed amount (default $300) and a share of the sweep.
  async function newShow(name, { fixed = $(300), rules, funded = true } = {}) {
    const b = await createShow(sys.factory, promoter, showConfig(promoter, tourOwner, t0, {
      anchors: { termsHash: ethers.id(name) }, funding: [],
      tiers: [tier({ quantity: 100, priceUSDC: $(20) })],
      payoutRules: rules ?? [{ to: module.target, kind: PayoutKind.FixedAmount, value: fixed, notBefore: t0 + 15 * ONE_DAY, isGuarantee: true }],
      sweep: { recipients: [promoter.address, module.target], bps: [4000, 6000], notBefore: showEnd },
    }));
    await b.show.connect(promoter).signTerms();
    await b.show.connect(tourOwner).signTerms();
    await module.connect(tourOwner).registerShow(b.show.target);
    if (funded) await fund(b, rules ? rules.reduce((s, r) => s + r.value, 0n) : fixed);
    return b;
  }

  async function fund(b, amount) {
    await usdc.mint(promoter.address, amount);
    await usdc.connect(promoter).approve(b.escrow.target, amount);
    await b.escrow.connect(promoter).deposit(amount);
  }

  const linked = new Set();
  async function link(tpa, b) {
    const id = edgeIdOf(tpa.target, b.show.target, PARENTS);
    if (linked.has(id)) return id;                                               // already linked and confirmed
    await shell.connect(tourOwner).linkShowToTPA(tpa.target, b.show.target, ZERO_BYTES32, "");
    await registry.connect(promoter).confirmEdge(id);
    await registry.connect(tourOwner).confirmEdge(id);
    linked.add(id);
    return id;
  }

  // reserve `amount` of a show for the guarantee of `tpa` (linking the show to it first)
  async function reserve(id, tpa, b, amount) {
    const edge = await link(tpa, b);
    return coverage.connect(tourOwner).reserveShow(id, b.show.target, edge, amount);
  }

  async function putIn(id, who, amount) {
    await usdc.mint(who.address, amount);
    await usdc.connect(who).approve(coverage.target, amount);
    return coverage.connect(who).depositCoverage(id, amount);
  }

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    [, promoter, , , tourOwner, bandA, bandB, stranger, agent, bandC, funder] = signers;
    await buildTour();
    t0 = await time.latest();
    showEnd = t0 + 30 * ONE_DAY + 7_200;
    deadline = t0 + 20 * ONE_DAY;
  });

  // ─── CREATING THE LEDGER ────────────────────────────────────────────────
  describe("creating the ledger", function () {
    it("is created by the tour's owner, once, and bound to the tour and its token", async function () {
      expect(await coverage.tourShell()).to.equal(shell.target);
      expect(await coverage.token()).to.equal(usdc.target);
      expect(await coverage.showFactory()).to.equal(sys.factory.target);
      expect(await coverageFactory.coverageOf(shell.target)).to.equal(coverage.target);
      await expect(coverageFactory.connect(tourOwner).createCoverage(shell.target, usdc.target)).to.be.revertedWithCustomError(coverageFactory, "AlreadyCreated");
      await expect(coverage.initialize(shell.target, usdc.target, sys.factory.target)).to.be.revertedWithCustomError(coverage, "AlreadyInitialized");
    });

    it("is created only by the owner or an operator, and needs real addresses", async function () {
      await expect(coverageFactory.connect(stranger).createCoverage(shell.target, usdc.target)).to.be.revertedWithCustomError(coverageFactory, "AlreadyCreated");
      const impl = await (await ethers.getContractFactory("TourCoverage")).deploy();
      const f2 = await (await ethers.getContractFactory("TourCoverageFactory")).deploy(impl.target, sys.factory.target);
      await expect(f2.connect(stranger).createCoverage(shell.target, usdc.target)).to.be.revertedWithCustomError(f2, "NotTourSide");
      await shell.connect(tourOwner).setOperator(agent.address, true);
      await f2.connect(agent).createCoverage(shell.target, usdc.target);
      await expect((await ethers.getContractFactory("TourCoverageFactory")).deploy(ZERO_ADDRESS, sys.factory.target)).to.be.revertedWithCustomError(f2, "ZeroAddress");
      await expect((await ethers.getContractFactory("TourCoverageFactory")).deploy(impl.target, ZERO_ADDRESS)).to.be.revertedWithCustomError(f2, "ZeroAddress");
      const c = await ethers.getContractAt("TourCoverage", await f2.coverageOf(shell.target));
      await expect(impl.initialize(shell.target, usdc.target, sys.factory.target)).to.be.revertedWithCustomError(impl, "AlreadyInitialized");
      void c;
    });
  });

  // ─── GUARANTEES ─────────────────────────────────────────────────────────
  describe("a tour-wide guarantee", function () {
    it("is registered by the tour side against an active TPA of this tour, once", async function () {
      await expect(coverage.connect(stranger).registerGuarantee(tpaA.target, $(1000), deadline, ZERO_ADDRESS)).to.be.revertedWithCustomError(coverage, "NotTourSide");
      await expect(coverage.connect(tourOwner).registerGuarantee(stranger.address, $(1000), deadline, ZERO_ADDRESS)).to.be.revertedWithCustomError(coverage, "UnknownTPA");
      await expect(coverage.connect(tourOwner).registerGuarantee(tpaA.target, 0, deadline, ZERO_ADDRESS)).to.be.revertedWithCustomError(coverage, "InvalidGuarantee");
      await expect(coverage.connect(tourOwner).registerGuarantee(tpaA.target, $(1000), t0, ZERO_ADDRESS)).to.be.revertedWithCustomError(coverage, "InvalidGuarantee");
      await expect(coverage.connect(tourOwner).registerGuarantee(tpaA.target, $(1000), deadline, ZERO_ADDRESS))
        .to.emit(coverage, "GuaranteeRegistered").withArgs(1, tpaA.target, bandA.address, $(1000), deadline);
      await expect(coverage.connect(tourOwner).registerGuarantee(tpaA.target, $(1000), deadline, ZERO_ADDRESS)).to.be.revertedWithCustomError(coverage, "GuaranteeExists");
      const g = await coverage.getGuarantee(1);
      expect(g.tpa).to.equal(tpaA.target);
      expect(g.beneficiary).to.equal(bandA.address);
      expect(g.obligor).to.equal(tourOwner.address);
      expect(await coverage.guaranteeOf(tpaA.target)).to.equal(1);
      await expect(coverage.getGuarantee(0)).to.be.revertedWithCustomError(coverage, "UnknownGuarantee");
      await expect(coverage.getGuarantee(2)).to.be.revertedWithCustomError(coverage, "UnknownGuarantee");
    });

    it("needs a TPA that is active, and one that belongs to this tour", async function () {
      const tx = await shell.connect(tourOwner).createTourParticipationAgreement({
        partyB: bandA.address, termsHash: ethers.id("draft"), termsCID: "x", effectiveFrom: 0, effectiveTo: 0,
        metaHash: ZERO_BYTES32, metaCID: "", supersedes: ZERO_ADDRESS,
      });
      const log = (await tx.wait()).logs.map((l) => { try { return shell.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "TPACreated");
      await expect(coverage.connect(tourOwner).registerGuarantee(log.args.tpa, $(1), deadline, ZERO_ADDRESS)).to.be.revertedWithCustomError(coverage, "TPANotActive");

      // a TPA of another tour
      const tpaImpl = await (await ethers.getContractFactory("TourParticipationAgreement")).deploy();
      const shellImpl = await (await ethers.getContractFactory("TourShell")).deploy();
      const tf = await (await ethers.getContractFactory("TourFactory")).deploy(shellImpl.target, tpaImpl.target, registry.target);
      const made = await (await tf.connect(tourOwner).createTourShell(ethers.id("other"), "x", ZERO_BYTES32)).wait();
      const other = await ethers.getContractAt("TourShell", tf.interface.parseLog(made.logs.find((l) => { try { return tf.interface.parseLog(l).name === "TourShellCreated"; } catch { return false; } })).args[0]);
      const t2 = await (await other.connect(tourOwner).createTourParticipationAgreement({
        partyB: bandA.address, termsHash: ethers.id("o"), termsCID: "x", effectiveFrom: 0, effectiveTo: 0, metaHash: ZERO_BYTES32, metaCID: "", supersedes: ZERO_ADDRESS,
      })).wait();
      const tpa2 = other.interface.parseLog(t2.logs.find((l) => { try { return other.interface.parseLog(l).name === "TPACreated"; } catch { return false; } })).args.tpa;
      await expect(coverage.connect(tourOwner).registerGuarantee(tpa2, $(1), deadline, ZERO_ADDRESS)).to.be.revertedWithCustomError(coverage, "UnknownTPA");
    });

    it("counts only once the band and the tour obligor have both signed it; an agent cannot sign for either", async function () {
      await coverage.connect(tourOwner).registerGuarantee(tpaA.target, $(1000), deadline, ZERO_ADDRESS);
      await shell.connect(tourOwner).setOperator(agent.address, true);
      await expect(coverage.connect(agent).signGuarantee(1)).to.be.revertedWithCustomError(coverage, "NotAuthorized");
      await expect(coverage.connect(stranger).signGuarantee(1)).to.be.revertedWithCustomError(coverage, "NotAuthorized");
      await expect(coverage.connect(bandA).signGuarantee(1)).to.emit(coverage, "GuaranteeSigned").withArgs(1, bandA.address, true);
      await coverage.reconcileCoverage();
      expect(await coverage.requiredCoverage()).to.equal(0);                      // half signed: nothing to cover yet
      await expect(coverage.connect(tourOwner).signGuarantee(1)).to.emit(coverage, "GuaranteeSigned").withArgs(1, tourOwner.address, false);
      await coverage.reconcileCoverage();
      expect(await coverage.requiredCoverage()).to.equal($(1000));
      await expect(coverage.connect(bandA).signGuarantee(2)).to.be.revertedWithCustomError(coverage, "UnknownGuarantee");
    });

    it("is limited to sixteen", async function () {
      for (let i = 0; i < 16; i++) {
        const band = (await ethers.getSigners())[(i % 5) + 10];
        const tpa = await newTPA(band, "many-" + i);
        await coverage.connect(tourOwner).registerGuarantee(tpa.target, $(1), deadline, ZERO_ADDRESS);
      }
      await expect(coverage.connect(tourOwner).registerGuarantee(tpaA.target, $(1), deadline, ZERO_ADDRESS)).to.be.revertedWithCustomError(coverage, "TooMany");
    });
  });

  // ─── MONEY DEPOSITED AS COVER ───────────────────────────────────────────
  describe("deposited cover", function () {
    it("is accepted for a signed guarantee, up to what it lacks, from anyone", async function () {
      await coverage.connect(tourOwner).registerGuarantee(tpaA.target, $(1000), deadline, ZERO_ADDRESS);
      await expect(putIn(1, funder, $(1))).to.be.revertedWithCustomError(coverage, "NotSigned");
      await coverage.connect(bandA).signGuarantee(1);
      await coverage.connect(tourOwner).signGuarantee(1);

      await expect(putIn(1, funder, $(400))).to.emit(coverage, "CoverageDeposited").withArgs(1, funder.address, $(400));
      await putIn(1, stranger, $(600));
      await expect(putIn(1, stranger, 1)).to.be.revertedWithCustomError(coverage, "ExceedsGuarantee");
      await expect(coverage.connect(stranger).depositCoverage(1, 0)).to.be.revertedWithCustomError(coverage, "ZeroAmount");
      expect((await coverage.getGuarantee(1)).deposited).to.equal($(1000));
      expect(await coverage.depositedBy(1, funder.address)).to.equal($(400));
      expect(await usdc.balanceOf(coverage.target)).to.equal($(1000));
      await expect(putIn(9, funder, 1)).to.be.revertedWithCustomError(coverage, "UnknownGuarantee");
    });

    it("can be taken back by whoever put it in, until the launch is cleared", async function () {
      await guarantee(tpaA, bandA, $(1000));
      await putIn(1, funder, $(700));
      await putIn(1, stranger, $(100));
      await expect(coverage.connect(stranger).withdrawCoverage(1, $(101))).to.be.revertedWithCustomError(coverage, "ExceedsDeposit");
      await expect(coverage.connect(agent).withdrawCoverage(1, 1)).to.be.revertedWithCustomError(coverage, "ExceedsDeposit");
      await expect(coverage.connect(stranger).withdrawCoverage(1, 0)).to.be.revertedWithCustomError(coverage, "ZeroAmount");
      const before = await usdc.balanceOf(funder.address);
      await expect(coverage.connect(funder).withdrawCoverage(1, $(200))).to.emit(coverage, "CoverageWithdrawn").withArgs(1, funder.address, $(200));
      expect(await usdc.balanceOf(funder.address)).to.equal(before + $(200));
      expect((await coverage.getGuarantee(1)).deposited).to.equal($(600));

      await putIn(1, funder, $(400));                                              // back to $1000
      await coverage.reconcileCoverage();
      expect(await coverage.launchCleared()).to.equal(true);
      await expect(coverage.connect(funder).withdrawCoverage(1, 1)).to.be.revertedWithCustomError(coverage, "CoverageLocked");
    });
  });

  // ─── WHAT A SHOW COUNTS FOR ─────────────────────────────────────────────
  describe("what a show is worth as cover", function () {
    it("is its guaranteed payment to this tour: contracted while the parties have not funded it, secured once they have", async function () {
      const b = await newShow("funded", { funded: false });
      expect(await coverage.showCover(b.show.target)).to.equal($(300));             // signed: counts, funded or not
      expect(await coverage.showSecured(b.show.target)).to.equal(0);                // but nothing is secured yet
      await fund(b, $(299));
      expect(await coverage.showCover(b.show.target)).to.equal($(300));
      expect(await coverage.showSecured(b.show.target)).to.equal(0);                // one dollar short of secured
      await fund(b, $(1));
      expect(await coverage.showCover(b.show.target)).to.equal($(300));
      expect(await coverage.showSecured(b.show.target)).to.equal($(300));
    });

    it("is never made secured by ticket sales alone: a cancelled show refunds them", async function () {
      const b = await newShow("tickets-only", { fixed: $(100), funded: false });
      const buyers = (await ethers.getSigners()).slice(10, 20);
      for (const w of buyers) {
        await usdc.mint(w.address, $(20));
        await usdc.connect(w).approve(b.ticket.target, $(20));
        await b.ticket.connect(w).buyTicket(0);
      }
      expect(await b.escrow.totalFunded()).to.be.gte($(100));                       // the show looks "funded" by tickets
      expect(await b.escrow.fundingNeed()).to.equal(0);
      expect(await b.escrow.partyDeposited()).to.equal(0);
      expect(await coverage.showCover(b.show.target)).to.equal($(100));             // contracted, as it was before the tickets
      expect(await coverage.showSecured(b.show.target)).to.equal(0);                // and not secured by them
    });

    it("counts every fixed payment to the module, and calls it secured only when the parties have funded all the show promises", async function () {
      const rules = [
        { to: module.target, kind: PayoutKind.FixedAmount, value: $(200), notBefore: t0 + 15 * ONE_DAY, isGuarantee: true },
        { to: bandB.address, kind: PayoutKind.FixedAmount, value: $(100), notBefore: t0 + 15 * ONE_DAY, isGuarantee: true },
      ];
      const b = await newShow("two-rules", { rules, funded: false });
      await fund(b, $(299));
      expect(await coverage.showCover(b.show.target)).to.equal($(200));
      expect(await coverage.showSecured(b.show.target)).to.equal(0);                // the other band's $100 is promised too
      await fund(b, $(1));
      expect(await coverage.showCover(b.show.target)).to.equal($(200));
      expect(await coverage.showSecured(b.show.target)).to.equal($(200));
    });

    it("is nothing for a show the settlement module does not know, or that does not pay it a fixed amount", async function () {
      const unknown = await createShow(sys.factory, promoter, showConfig(promoter, tourOwner, t0, {
        anchors: { termsHash: ethers.id("unknown") }, funding: [], tiers: [tier({ quantity: 10, priceUSDC: $(20) })],
        payoutRules: [{ to: module.target, kind: PayoutKind.FixedAmount, value: $(300), notBefore: t0 + 15 * ONE_DAY, isGuarantee: true }],
        sweep: { recipients: [promoter.address, module.target], bps: [4000, 6000], notBefore: showEnd },
      }));
      await unknown.show.connect(promoter).signTerms();
      await unknown.show.connect(tourOwner).signTerms();
      await fund(unknown, $(300));
      expect(await coverage.showCover(unknown.show.target)).to.equal(0);            // never registered with the module

      const sweepOnly = await newShow("sweep-only", { rules: [], funded: false });
      expect(await coverage.showCover(sweepOnly.show.target)).to.equal(0);          // a share of the sweep is not a guarantee
      expect(await coverage.showCover(stranger.address)).to.equal(0);
    });

    it("is nothing for a show that is cancelled, in dispute, or whose guarantee was already paid out", async function () {
      const cancelled = await newShow("cancelled");
      expect(await coverage.showCover(cancelled.show.target)).to.equal($(300));
      await cancelled.escrow.connect(tourOwner).cancel();
      expect(await coverage.showCover(cancelled.show.target)).to.equal(0);

      const disputed = await newShow("disputed");
      await disputed.escrow.connect(promoter).raiseDispute();
      expect(await disputed.show.status()).to.equal(3);
      expect(await coverage.showCover(disputed.show.target)).to.equal(0);

      const paid = await newShow("paid");
      await time.increaseTo(t0 + 15 * ONE_DAY);
      await paid.escrow.connect(stranger).executeAvailablePayouts();
      expect(await coverage.showCover(paid.show.target)).to.equal(0);               // already released to the module
    });

    it("loses only what was already released, when a show pays the module in two parts", async function () {
      const rules = [
        { to: module.target, kind: PayoutKind.FixedAmount, value: $(200), notBefore: t0 + 5 * ONE_DAY, isGuarantee: true },
        { to: module.target, kind: PayoutKind.FixedAmount, value: $(100), notBefore: t0 + 15 * ONE_DAY, isGuarantee: true },
      ];
      const b = await newShow("two-parts", { rules });
      expect(await coverage.showCover(b.show.target)).to.equal($(300));
      await time.increaseTo(t0 + 5 * ONE_DAY);
      await b.escrow.connect(stranger).executeAvailablePayouts();
      expect(await coverage.showCover(b.show.target)).to.equal($(100));
    });
  });

  // ─── RESERVING A SHOW ───────────────────────────────────────────────────
  describe("reserving a show's cover", function () {
    it("takes the tour side, a signed guarantee, a confirmed link from the guarantee's TPA, and a show that can cover it", async function () {
      const b = await newShow("r1");
      await coverage.connect(tourOwner).registerGuarantee(tpaA.target, $(1000), deadline, ZERO_ADDRESS);
      const edge = await link(tpaA, b);
      await expect(coverage.connect(tourOwner).reserveShow(1, b.show.target, edge, $(100))).to.be.revertedWithCustomError(coverage, "NotSigned");
      await coverage.connect(bandA).signGuarantee(1);
      await coverage.connect(tourOwner).signGuarantee(1);

      await expect(coverage.connect(stranger).reserveShow(1, b.show.target, edge, $(100))).to.be.revertedWithCustomError(coverage, "NotTourSide");
      await expect(coverage.connect(tourOwner).reserveShow(1, b.show.target, edge, 0)).to.be.revertedWithCustomError(coverage, "ZeroAmount");
      await expect(coverage.connect(tourOwner).reserveShow(7, b.show.target, edge, 1)).to.be.revertedWithCustomError(coverage, "UnknownGuarantee");
      await expect(coverage.connect(tourOwner).reserveShow(1, b.show.target, ZERO_BYTES32, $(100))).to.be.revertedWithCustomError(coverage, "WrongLink");
      await expect(coverage.connect(tourOwner).reserveShow(1, b.show.target, edge, $(301))).to.be.revertedWithCustomError(coverage, "ExceedsShowCover");
      await expect(coverage.connect(tourOwner).reserveShow(1, b.show.target, edge, $(100)))
        .to.emit(coverage, "ShowReserved").withArgs(1, b.show.target, $(100));
      expect(await coverage.reservedByShow(b.show.target)).to.equal($(100));
      expect((await coverage.getGuarantee(1)).reserved).to.equal($(100));
      expect((await coverage.getReservations(1)).map((r) => [r.show, r.amount])).to.deep.equal([[b.show.target, $(100)]]);
      expect(await coverage.getShows()).to.deep.equal([b.show.target]);
      await expect(coverage.connect(tourOwner).reserveShow(1, b.show.target, edge, $(50))).to.be.revertedWithCustomError(coverage, "AlreadyReserved");
    });

    it("refuses a link that is from another TPA, to another show, unconfirmed, or of the wrong kind", async function () {
      const b = await newShow("r2");
      const other = await newShow("r2-other");
      const id = await guarantee(tpaA, bandA, $(1000));

      await shell.connect(tourOwner).linkShowToTPA(tpaA.target, b.show.target, ZERO_BYTES32, "");
      const pending = edgeIdOf(tpaA.target, b.show.target, PARENTS);
      await expect(coverage.connect(tourOwner).reserveShow(id, b.show.target, pending, $(10))).to.be.revertedWithCustomError(coverage, "WrongLink");      // not confirmed yet
      await registry.connect(promoter).confirmEdge(pending);
      await registry.connect(tourOwner).confirmEdge(pending);
      await expect(coverage.connect(tourOwner).reserveShow(id, other.show.target, pending, $(10))).to.be.revertedWithCustomError(coverage, "WrongLink");        // link is to a different show

      const bLinked = await link(tpaB, b);
      await expect(coverage.connect(tourOwner).reserveShow(id, b.show.target, bLinked, $(10))).to.be.revertedWithCustomError(coverage, "WrongLink");           // link is from another TPA
      await coverage.connect(tourOwner).reserveShow(id, b.show.target, pending, $(10));
    });

    it("refuses a show that cannot cover anything", async function () {
      const sweepOnly = await newShow("r3", { rules: [], funded: false });
      const id = await guarantee(tpaA, bandA, $(1000));
      await expect(reserve(id, tpaA, sweepOnly, $(10))).to.be.revertedWithCustomError(coverage, "ShowNotEligible");
    });

    it("accepts a signed show that its parties have not funded yet", async function () {
      const unfunded = await newShow("r4", { funded: false });
      const id = await guarantee(tpaA, bandA, $(1000));
      await reserve(id, tpaA, unfunded, $(300));
      expect((await coverage.getReservations(id)).map((r) => r.amount)).to.deep.equal([$(300)]);
    });

    it("never counts a dollar of a show for two guarantees", async function () {
      const b = await newShow("double");
      const g1 = await guarantee(tpaA, bandA, $(1000));
      const g2 = await guarantee(tpaB, bandB, $(1000));
      await reserve(g1, tpaA, b, $(200));
      await expect(reserve(g2, tpaB, b, $(200))).to.be.revertedWithCustomError(coverage, "ExceedsShowCover");       // only $100 is left
      await reserve(g2, tpaB, b, $(100));
      expect(await coverage.reservedByShow(b.show.target)).to.equal($(300));
      const edge = edgeIdOf(tpaB.target, b.show.target, PARENTS);
      await expect(coverage.connect(tourOwner).reserveShow(g2, b.show.target, edge, 1)).to.be.revertedWithCustomError(coverage, "AlreadyReserved");
    });

    it("cannot reserve more than the guarantee needs", async function () {
      const b = await newShow("cap");
      const id = await guarantee(tpaA, bandA, $(250));
      await expect(reserve(id, tpaA, b, $(251))).to.be.revertedWithCustomError(coverage, "ExceedsGuarantee");
      await reserve(id, tpaA, b, $(250));
    });

    it("can be taken back by the tour side, and the cover is free again", async function () {
      const b = await newShow("release");
      const g1 = await guarantee(tpaA, bandA, $(1000));
      const g2 = await guarantee(tpaB, bandB, $(1000));
      await reserve(g1, tpaA, b, $(300));
      await expect(coverage.connect(stranger).releaseShow(g1, b.show.target)).to.be.revertedWithCustomError(coverage, "NotTourSide");
      await expect(coverage.connect(tourOwner).releaseShow(g2, b.show.target)).to.be.revertedWithCustomError(coverage, "NothingReserved");
      await expect(coverage.connect(tourOwner).releaseShow(g1, b.show.target)).to.emit(coverage, "ShowReleased").withArgs(g1, b.show.target, $(300));
      expect(await coverage.reservedByShow(b.show.target)).to.equal(0);
      expect((await coverage.getGuarantee(g1)).reserved).to.equal(0);
      expect(await coverage.getReservations(g1)).to.have.length(0);
      await reserve(g2, tpaB, b, $(300));                                            // now someone else can have it
    });

    it("is closed once the launch is cleared", async function () {
      const b = await newShow("closed");
      const g1 = await guarantee(tpaA, bandA, $(300));
      await reserve(g1, tpaA, b, $(300));
      await coverage.reconcileCoverage();
      expect(await coverage.launchCleared()).to.equal(true);
      await expect(coverage.connect(tourOwner).releaseShow(g1, b.show.target)).to.be.revertedWithCustomError(coverage, "AlreadyCleared");
      const g2tpa = tpaB;
      await expect(coverage.connect(tourOwner).registerGuarantee(g2tpa.target, $(1), deadline, ZERO_ADDRESS)).to.be.revertedWithCustomError(coverage, "AlreadyCleared");
      const b2 = await newShow("closed-2");
      const edge = await link(tpaA, b2);
      await expect(coverage.connect(tourOwner).reserveShow(g1, b2.show.target, edge, 1)).to.be.revertedWithCustomError(coverage, "AlreadyCleared");
    });
  });

  // ─── THE LEDGER ─────────────────────────────────────────────────────────
  describe("reconciling", function () {
    it("does not clear with nothing to cover, but a tour with no guarantees may start", async function () {
      expect(await coverage.launchReady()).to.equal(true);                           // nothing has to be covered
      await coverage.reconcileCoverage();
      expect(await coverage.launchCleared()).to.equal(false);
      expect(await coverage.requiredCoverage()).to.equal(0);
      expect(await coverage.launchReady()).to.equal(true);
    });

    it("does not clear a guarantee with no secured cover, and shows the exact gap", async function () {
      await guarantee(tpaA, bandA, $(20_000));
      await expect(coverage.reconcileCoverage()).to.emit(coverage, "TourCoverageUpdated").withArgs($(20_000), 0);
      expect(await coverage.launchCleared()).to.equal(false);
      expect(await coverage.launchReady()).to.equal(false);
      expect(await coverage.coverageGap()).to.equal($(20_000));

      await putIn(1, funder, $(6_000));
      await coverage.reconcileCoverage();
      expect(await coverage.launchCleared()).to.equal(false);                         // $14,000 secured of $20,000
      expect(await coverage.coverageGap()).to.equal($(14_000));
      expect((await coverage.getGuarantee(1)).covered).to.equal($(6_000));
    });

    it("clears when deposits and show cover together meet every guarantee", async function () {
      const a = await newShow("m-a");
      const b = await newShow("m-b");
      const g1 = await guarantee(tpaA, bandA, $(500));
      const g2 = await guarantee(tpaB, bandB, $(300));
      await reserve(g1, tpaA, a, $(300));
      await putIn(g1, funder, $(200));
      await reserve(g2, tpaB, b, $(300));
      await expect(coverage.reconcileCoverage()).to.emit(coverage, "LaunchCleared").withArgs($(800));
      expect(await coverage.launchCleared()).to.equal(true);
      expect(await coverage.coverageGap()).to.equal(0);
      expect(await coverage.launchReady()).to.equal(true);
      expect(await coverage.eligibleCoverage()).to.equal($(800));
    });

    it("does not clear when one of two guarantees is short, even if the other is over-secured", async function () {
      const a = await newShow("s-a");
      const g1 = await guarantee(tpaA, bandA, $(300));
      await guarantee(tpaB, bandB, $(300));
      await reserve(g1, tpaA, a, $(300));
      await putIn(2, funder, $(299));
      await coverage.reconcileCoverage();
      expect(await coverage.launchCleared()).to.equal(false);
      expect(await coverage.coverageGap()).to.equal($(1));
      await putIn(2, funder, $(1));
      await coverage.reconcileCoverage();
      expect(await coverage.launchCleared()).to.equal(true);
    });

    it("ignores a guarantee that is not signed by both sides", async function () {
      await coverage.connect(tourOwner).registerGuarantee(tpaA.target, $(5_000), deadline, ZERO_ADDRESS);
      await coverage.connect(bandA).signGuarantee(1);
      const g2 = await guarantee(tpaB, bandB, $(100));
      await putIn(g2, funder, $(100));
      await coverage.reconcileCoverage();
      expect(await coverage.requiredCoverage()).to.equal($(100));
      expect(await coverage.launchCleared()).to.equal(true);
    });

    it("cannot clear once a coverage deadline has passed, and the deposits can then be taken back", async function () {
      const g = await guarantee(tpaA, bandA, $(100), t0 + 2 * ONE_DAY);
      const g2 = await guarantee(tpaB, bandB, $(100), t0 + 9 * ONE_DAY);
      await putIn(g, funder, $(100));
      await putIn(g2, funder, $(100));
      await time.increaseTo(t0 + 3 * ONE_DAY);                                        // the first deadline has passed, the second has not
      await coverage.reconcileCoverage();
      expect(await coverage.launchCleared()).to.equal(false);
      expect(await coverage.coverageGap()).to.equal(0);                               // fully covered, but too late
      await coverage.connect(funder).withdrawCoverage(g, $(100));
    });

    it("clears right up to the deadline", async function () {
      const g = await guarantee(tpaA, bandA, $(100), t0 + 5 * ONE_DAY);
      await putIn(g, funder, $(100));
      await time.setNextBlockTimestamp(t0 + 5 * ONE_DAY);
      await coverage.reconcileCoverage();
      expect(await coverage.launchCleared()).to.equal(true);
    });

    it("keeps the launch cleared when a show is cancelled, but takes its cover away and shows the gap", async function () {
      const a = await newShow("c-a");
      const b = await newShow("c-b");
      const g1 = await guarantee(tpaA, bandA, $(300));
      const g2 = await guarantee(tpaB, bandB, $(300));
      await reserve(g1, tpaA, a, $(300));
      await reserve(g2, tpaB, b, $(300));
      await coverage.reconcileCoverage();
      expect(await coverage.launchCleared()).to.equal(true);

      await b.escrow.connect(tourOwner).cancel();
      await expect(coverage.reconcileCoverage())
        .to.emit(coverage, "ShowCoverageInvalidated").withArgs(g2, b.show.target, $(300))
        .and.to.emit(coverage, "TourCoverageUpdated").withArgs($(600), $(300));
      expect(await coverage.launchCleared()).to.equal(true);                          // it was cleared; the gap is what is new
      expect(await coverage.coverageGap()).to.equal($(300));
      expect((await coverage.getGuarantee(g2)).covered).to.equal(0);
      expect((await coverage.getGuarantee(g1)).covered).to.equal($(300));
      expect((await coverage.getGuarantee(g2)).amount).to.equal($(300));              // the guarantee itself is not reduced

      await putIn(g2, funder, $(300));                                                // replacement cover closes the gap
      await coverage.reconcileCoverage();
      expect(await coverage.coverageGap()).to.equal(0);
    });

    it("does not report the same lost cover twice", async function () {
      const a = await newShow("once");
      const g1 = await guarantee(tpaA, bandA, $(300));
      await reserve(g1, tpaA, a, $(300));
      await a.escrow.connect(tourOwner).cancel();
      await expect(coverage.reconcileCoverage()).to.emit(coverage, "ShowCoverageInvalidated");
      await expect(coverage.reconcileCoverage()).to.not.emit(coverage, "ShowCoverageInvalidated");
      expect(await coverage.invalidated(g1, a.show.target)).to.equal($(300));
    });

    it("gives a show's remaining cover to the guarantees that reserved it first", async function () {
      const rules = [
        { to: module.target, kind: PayoutKind.FixedAmount, value: $(200), notBefore: t0 + 5 * ONE_DAY, isGuarantee: true },
        { to: module.target, kind: PayoutKind.FixedAmount, value: $(100), notBefore: t0 + 15 * ONE_DAY, isGuarantee: true },
      ];
      const b = await newShow("order", { rules });
      const g1 = await guarantee(tpaA, bandA, $(1000));
      const g2 = await guarantee(tpaB, bandB, $(1000));
      await reserve(g1, tpaA, b, $(200));
      await reserve(g2, tpaB, b, $(100));
      await time.increaseTo(t0 + 5 * ONE_DAY);
      await b.escrow.connect(stranger).executeAvailablePayouts();                      // $200 released: $100 of cover is left
      await coverage.reconcileCoverage();
      expect((await coverage.getGuarantee(g1)).covered).to.equal($(100));              // first reservation takes what there is
      expect((await coverage.getGuarantee(g2)).covered).to.equal(0);
      expect(await coverage.eligibleCoverage()).to.equal($(100));
    });

    it("can be called by anyone, and caps a guarantee's cover at what it needs", async function () {
      const g = await guarantee(tpaA, bandA, $(100));
      await putIn(g, funder, $(100));
      await coverage.connect(stranger).reconcileCoverage();
      expect((await coverage.getGuarantee(g)).covered).to.equal($(100));
      expect(await coverage.eligibleCoverage()).to.equal($(100));
    });
  });

  // ─── MORE EDGES ─────────────────────────────────────────────────────────
  describe("edges", function () {
    it("only accepts the graph's parent link from the guarantee's TPA to the show", async function () {
      const b = await newShow("edge-kind");
      const id = await guarantee(tpaA, bandA, $(1000));
      await shell.connect(tourOwner).linkShowToTPA(tpaA.target, b.show.target, ZERO_BYTES32, "");
      const REFERENCES = 12;
      await registry.connect(tourOwner).registerEdge(tpaA.target, b.show.target, REFERENCES, ZERO_BYTES32, "");
      const other = edgeIdOf(tpaA.target, b.show.target, REFERENCES);
      if (!(await registry.isEdgeActive(other))) {
        await registry.connect(promoter).confirmEdge(other);
        await registry.connect(tourOwner).confirmEdge(other);
      }
      expect(await registry.isEdgeActive(other)).to.equal(true);
      await expect(coverage.connect(tourOwner).reserveShow(id, b.show.target, other, $(10))).to.be.revertedWithCustomError(coverage, "WrongLink");
    });

    it("keeps the rest of the reservations right when one is taken back", async function () {
      const a = await newShow("pop-a");
      const b = await newShow("pop-b");
      const c = await newShow("pop-c");
      const id = await guarantee(tpaA, bandA, $(1000));
      await reserve(id, tpaA, a, $(100));
      await reserve(id, tpaA, b, $(200));
      await reserve(id, tpaA, c, $(300));
      await coverage.connect(tourOwner).releaseShow(id, a.show.target);
      const left = (await coverage.getReservations(id)).map((r) => [r.show, r.amount]);
      expect(left).to.have.deep.members([[b.show.target, $(200)], [c.show.target, $(300)]]);
      expect(left).to.have.length(2);
      await coverage.reconcileCoverage();
      expect((await coverage.getGuarantee(id)).covered).to.equal($(500));
    });

    it("never counts more than a guarantee needs, however much is deposited and reserved for it", async function () {
      const b = await newShow("cap-cover");
      const id = await guarantee(tpaA, bandA, $(300));
      await putIn(id, funder, $(200));
      await reserve(id, tpaA, b, $(300));
      await coverage.reconcileCoverage();
      expect((await coverage.getGuarantee(id)).covered).to.equal($(300));
      expect(await coverage.eligibleCoverage()).to.equal($(300));
      expect(await coverage.coverageGap()).to.equal(0);
    });

    it("says no more about a show's lost cover once it is back, and records that it is", async function () {
      const rules = [
        { to: module.target, kind: PayoutKind.FixedAmount, value: $(200), notBefore: t0 + 5 * ONE_DAY, isGuarantee: true },
        { to: module.target, kind: PayoutKind.FixedAmount, value: $(100), notBefore: t0 + 15 * ONE_DAY, isGuarantee: true },
      ];
      const b = await newShow("restored", { rules });
      const g1 = await guarantee(tpaA, bandA, $(1000));
      const g2 = await guarantee(tpaB, bandB, $(1000));
      await reserve(g1, tpaA, b, $(200));
      await reserve(g2, tpaB, b, $(100));
      await time.increaseTo(t0 + 5 * ONE_DAY);
      await b.escrow.connect(stranger).executeAvailablePayouts();                      // $100 of cover is left: g1 takes it, g2 loses its $100
      await expect(coverage.reconcileCoverage()).to.emit(coverage, "ShowCoverageInvalidated").withArgs(g2, b.show.target, $(100));
      expect(await coverage.invalidated(g2, b.show.target)).to.equal($(100));

      await coverage.connect(tourOwner).releaseShow(g1, b.show.target);                // g1 steps aside: g2 now has its cover
      await expect(coverage.reconcileCoverage()).to.not.emit(coverage, "ShowCoverageInvalidated");
      expect(await coverage.invalidated(g2, b.show.target)).to.equal(0);
      expect((await coverage.getGuarantee(g2)).covered).to.equal($(100));
    });

    it("counts nothing from a show that expired, even while its escrow is still active", async function () {
      const b = await newShow("expired");
      expect(await coverage.showCover(b.show.target)).to.equal($(300));
      await time.increaseTo(showEnd + 1);
      await b.show.markExpired();
      expect(await b.show.status()).to.equal(6);
      expect(await b.escrow.status()).to.equal(0);
      expect(await coverage.showCover(b.show.target)).to.equal(0);
    });
  });

  // ─── CASH, SECURED AND CONTRACTED COVER ─────────────────────────────────
  describe("the three tiers of cover", function () {
    it("lets a signed show that nobody has funded clear the launch, and shows it as contracted", async function () {
      const b = await newShow("contracted", { funded: false });
      const id = await guarantee(tpaA, bandA, $(300));
      await reserve(id, tpaA, b, $(300));
      await coverage.reconcileCoverage();
      expect(await coverage.launchCleared()).to.equal(true);
      expect(await coverage.contractedCoverage()).to.equal($(300));
      expect(await coverage.securedCoverage()).to.equal(0);
      expect(await coverage.cashCoverage()).to.equal(0);
      const g = await coverage.getGuarantee(id);
      expect([g.coveredCash, g.coveredSecured, g.coveredContracted]).to.deep.equal([0n, 0n, $(300)]);
    });

    it("moves a show from contracted to secured once its parties fund it", async function () {
      const b = await newShow("becomes-secured", { funded: false });
      const id = await guarantee(tpaA, bandA, $(300));
      await reserve(id, tpaA, b, $(300));
      await coverage.reconcileCoverage();
      expect(await coverage.contractedCoverage()).to.equal($(300));
      await fund(b, $(300));
      await coverage.reconcileCoverage();
      expect(await coverage.securedCoverage()).to.equal($(300));
      expect(await coverage.contractedCoverage()).to.equal(0);
    });

    it("keeps the three apart, and takes a surplus away from the least real cover first", async function () {
      const a = await newShow("tier-a");                                           // funded: secured
      const b = await newShow("tier-b", { funded: false });                        // contracted
      const id = await guarantee(tpaA, bandA, $(500));
      await putIn(id, funder, $(100));                                             // cash $100
      await reserve(id, tpaA, a, $(300));                                          // secured $300
      await reserve(id, tpaA, b, $(200));                                          // contracted $200: $100 too much
      await coverage.reconcileCoverage();
      const g = await coverage.getGuarantee(id);
      expect([g.coveredCash, g.coveredSecured, g.coveredContracted]).to.deep.equal([$(100), $(300), $(100)]);
      expect(g.covered).to.equal($(500));
      expect(await coverage.cashCoverage()).to.equal($(100));
      expect(await coverage.securedCoverage()).to.equal($(300));
      expect(await coverage.contractedCoverage()).to.equal($(100));
      expect(await coverage.eligibleCoverage()).to.equal($(500));
    });

    it("loses contracted cover when the unfunded show is cancelled, and says so", async function () {
      const b = await newShow("lost", { funded: false });
      const id = await guarantee(tpaA, bandA, $(300));
      await reserve(id, tpaA, b, $(300));
      await coverage.reconcileCoverage();
      expect(await coverage.launchCleared()).to.equal(true);
      await b.escrow.connect(tourOwner).cancel();
      await expect(coverage.reconcileCoverage()).to.emit(coverage, "ShowCoverageInvalidated").withArgs(id, b.show.target, $(300));
      expect(await coverage.contractedCoverage()).to.equal(0);
      expect(await coverage.coverageGap()).to.equal($(300));
      expect(await coverage.launchCleared()).to.equal(true);                       // nothing automatic: no cancelling, no reducing
      expect((await coverage.getGuarantee(id)).amount).to.equal($(300));
    });
  });

  // ─── THE GUARANTOR ──────────────────────────────────────────────────────
  describe("a guarantor", function () {
    async function withGuarantor(amount = $(1000), g = funder) {
      await coverage.connect(tourOwner).registerGuarantee(tpaA.target, amount, deadline, g.address);
      return coverage.guaranteeCount();
    }

    it("is named when the guarantee is registered, and has to sign for the guarantee to count", async function () {
      const id = await withGuarantor();
      expect((await coverage.getGuarantee(id)).guarantor).to.equal(funder.address);
      await coverage.connect(bandA).signGuarantee(id);
      await coverage.connect(tourOwner).signGuarantee(id);
      await coverage.reconcileCoverage();
      expect(await coverage.requiredCoverage()).to.equal(0);                         // not yet: the guarantor has not signed
      await expect(putIn(id, stranger, $(1))).to.be.revertedWithCustomError(coverage, "NotSigned");

      await expect(coverage.connect(stranger).signGuarantee(id)).to.be.revertedWithCustomError(coverage, "NotAuthorized");
      await expect(coverage.connect(funder).signGuarantee(id)).to.emit(coverage, "GuarantorSigned").withArgs(id, funder.address);
      await coverage.reconcileCoverage();
      expect(await coverage.requiredCoverage()).to.equal($(1000));
    });

    it("is not required: a guarantee without one counts with two signatures", async function () {
      const id = await guarantee(tpaA, bandA, $(100));
      expect((await coverage.getGuarantee(id)).guarantor).to.equal(ZERO_ADDRESS);
      await coverage.reconcileCoverage();
      expect(await coverage.requiredCoverage()).to.equal($(100));
      await expect(coverage.connect(stranger).pullFromGuarantor(id)).to.be.revertedWithCustomError(coverage, "NoGuarantor");
    });

    it("cannot sign for someone else, and an agent of the guarantor cannot sign for it", async function () {
      const id = await withGuarantor();
      await expect(coverage.connect(agent).signGuarantee(id)).to.be.revertedWithCustomError(coverage, "NotAuthorized");
      expect((await coverage.getGuarantee(id)).signedByGuarantor).to.equal(false);
    });

    async function signedWithGuarantor(amount = $(1000)) {
      const id = await withGuarantor(amount);
      for (const who of [bandA, tourOwner, funder]) await coverage.connect(who).signGuarantee(id);
      return id;
    }

    it("is asked for the shortfall up to what it has approved and holds, and the rest is recorded as owed", async function () {
      const id = await signedWithGuarantor($(1000));
      await usdc.mint(funder.address, $(1000));
      await usdc.connect(funder).approve(coverage.target, $(400));
      await expect(coverage.connect(bandA).pullFromGuarantor(id))
        .to.emit(coverage, "GuarantorShortfall").withArgs(id, $(400), $(600));
      let g = await coverage.getGuarantee(id);
      expect(g.deposited).to.equal($(400));
      expect(g.covered).to.equal($(400));
      expect(g.guarantorOwed).to.equal($(600));
      expect(await usdc.balanceOf(funder.address)).to.equal($(600));
      expect(await usdc.balanceOf(coverage.target)).to.equal($(400));
      expect(await coverage.cashCoverage()).to.equal($(400));
      expect(await coverage.depositedBy(id, funder.address)).to.equal($(400));

      await usdc.connect(funder).approve(coverage.target, $(600));
      await expect(coverage.connect(tourOwner).pullFromGuarantor(id)).to.emit(coverage, "GuarantorShortfall").withArgs(id, $(600), 0);
      g = await coverage.getGuarantee(id);
      expect(g.covered).to.equal($(1000));
      expect(g.guarantorOwed).to.equal(0);
      await expect(coverage.connect(funder).pullFromGuarantor(id)).to.be.revertedWithCustomError(coverage, "NoShortfall");
    });

    it("is limited by what it holds as well as what it approved, and nothing happens when it has nothing", async function () {
      const id = await signedWithGuarantor($(1000));
      await usdc.mint(funder.address, $(250));
      await usdc.connect(funder).approve(coverage.target, $(1000));
      await expect(coverage.connect(funder).pullFromGuarantor(id)).to.emit(coverage, "GuarantorShortfall").withArgs(id, $(250), $(750));

      await usdc.connect(funder).approve(coverage.target, 0);
      await expect(coverage.connect(funder).pullFromGuarantor(id)).to.emit(coverage, "GuarantorShortfall").withArgs(id, 0, $(750));
      expect((await coverage.getGuarantee(id)).guarantorOwed).to.equal($(750));
      expect((await coverage.getGuarantee(id)).deposited).to.equal($(250));
    });

    it("is asked only for the part other cover does not already give", async function () {
      const id = await signedWithGuarantor($(1000));
      await putIn(id, stranger, $(700));
      await usdc.mint(funder.address, $(1000));
      await usdc.connect(funder).approve(coverage.target, $(1000));
      await coverage.connect(bandA).pullFromGuarantor(id);
      expect((await coverage.getGuarantee(id)).deposited).to.equal($(1000));
      expect(await usdc.balanceOf(funder.address)).to.equal($(700));                  // took only $300
    });

    it("can be asked for only by the tour side, the band or the guarantor, and only once the guarantee is signed", async function () {
      const id = await withGuarantor();
      await expect(coverage.connect(bandA).pullFromGuarantor(id)).to.be.revertedWithCustomError(coverage, "NotSigned");
      for (const who of [bandA, tourOwner, funder]) await coverage.connect(who).signGuarantee(id);
      await expect(coverage.connect(stranger).pullFromGuarantor(id)).to.be.revertedWithCustomError(coverage, "NotAuthorized");
      await expect(coverage.connect(promoter).pullFromGuarantor(id)).to.be.revertedWithCustomError(coverage, "NotAuthorized");
      await shell.connect(tourOwner).setOperator(agent.address, true);
      await coverage.connect(agent).pullFromGuarantor(id);                             // an operator of the tour may
    });

    it("works out the cover afresh before it asks, so cover that was never reconciled still counts", async function () {
      const b = await newShow("stale", { funded: false });
      const id = await signedWithGuarantor($(1000));
      await reserve(id, tpaA, b, $(300));                                              // $300 contracted, never reconciled
      await usdc.mint(funder.address, $(1000));
      await usdc.connect(funder).approve(coverage.target, $(1000));
      await coverage.connect(bandA).pullFromGuarantor(id);
      expect((await coverage.getGuarantee(id)).deposited).to.equal($(700));            // only the $700 that was lacking
      expect((await coverage.getGuarantee(id)).covered).to.equal($(1000));
    });

    it("records the shortfall as owed when the token refuses the transfer by reverting", async function () {
      await buildTour("MockBlockableERC20");
      const id = await signedWithGuarantor($(500));
      await usdc.mint(funder.address, $(500));
      await usdc.connect(funder).approve(coverage.target, $(500));
      await usdc.setBlocked(coverage.target, true);
      await expect(coverage.connect(bandA).pullFromGuarantor(id)).to.emit(coverage, "GuarantorShortfall").withArgs(id, 0, $(500));
      expect((await coverage.getGuarantee(id)).deposited).to.equal(0);
      expect(await usdc.balanceOf(funder.address)).to.equal($(500));
    });

    it("records the shortfall as owed when the token reports failure by returning false", async function () {
      await buildTour("MockFalseTransferFromERC20");
      const id = await signedWithGuarantor($(500));
      await usdc.mint(funder.address, $(500));
      await usdc.connect(funder).approve(coverage.target, $(500));
      await usdc.setFailTransferFrom(true);
      await expect(coverage.connect(bandA).pullFromGuarantor(id)).to.emit(coverage, "GuarantorShortfall").withArgs(id, 0, $(500));
      expect((await coverage.getGuarantee(id)).deposited).to.equal(0);
      expect((await coverage.getGuarantee(id)).guarantorOwed).to.equal($(500));
      await usdc.setFailTransferFrom(false);
      await coverage.connect(bandA).pullFromGuarantor(id);
      expect((await coverage.getGuarantee(id)).deposited).to.equal($(500));
    });

    it("clears the owed record once the guarantee is covered some other way", async function () {
      const id = await signedWithGuarantor($(500));
      await coverage.connect(bandA).pullFromGuarantor(id);                             // nothing approved: all $500 owed
      expect((await coverage.getGuarantee(id)).guarantorOwed).to.equal($(500));
      await putIn(id, stranger, $(500));
      await coverage.reconcileCoverage();
      expect((await coverage.getGuarantee(id)).guarantorOwed).to.equal(0);
    });

    it("lets the guarantor take back what was pulled from it before the launch is cleared, like any deposit", async function () {
      const id = await signedWithGuarantor($(500));
      await usdc.mint(funder.address, $(200));
      await usdc.connect(funder).approve(coverage.target, $(200));
      await coverage.connect(bandA).pullFromGuarantor(id);
      await coverage.connect(funder).withdrawCoverage(id, $(200));
      expect(await usdc.balanceOf(funder.address)).to.equal($(200));
      expect((await coverage.getGuarantee(id)).deposited).to.equal(0);
    });
  });

  // ─── A REFERENCE MODEL ──────────────────────────────────────────────────
  describe("against an independent model", function () {
    it("matches a plain re-computation over random tours", async function () {
      let seed = 12345;
      const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

      for (let trial = 0; trial < 6; trial++) {
        await buildTour();
        t0 = await time.latest();
        showEnd = t0 + 30 * ONE_DAY + 7_200;
        deadline = t0 + 20 * ONE_DAY;

        const tpas = [[tpaA, bandA], [tpaB, bandB], [tpaC, bandC]];
        const amounts = tpas.map(() => BigInt(100 + rnd(400)) * 1_000_000n);
        const ids = [];
        for (let i = 0; i < 3; i++) ids.push(await guarantee(tpas[i][0], tpas[i][1], amounts[i]));

        const shows = [];
        for (let s = 0; s < 3; s++) {
          const funded = rnd(2) === 0;
          shows.push({ b: await newShow(`rnd-${trial}-${s}`, { fixed: BigInt(100 + rnd(300)) * 1_000_000n, funded }), cover: 0n, funded });
        }
        for (const s of shows) s.cover = await coverage.showCover(s.b.show.target);

        const reservations = [];                                  // [guarantee index, show index, amount] in reservation order
        const deposits = [0n, 0n, 0n];
        for (let step = 0; step < 6; step++) {
          const gi = rnd(3), si = rnd(3);
          const left = shows[si].cover - reservations.filter((r) => r[1] === si).reduce((x, r) => x + r[2], 0n);
          const room = amounts[gi] - reservations.filter((r) => r[0] === gi).reduce((x, r) => x + r[2], 0n);
          const want = BigInt(1 + rnd(250)) * 1_000_000n;
          const amt = want < left ? (want < room ? want : room) : (left < room ? left : room);
          const dup = reservations.some((r) => r[0] === gi && r[1] === si);
          if (amt > 0n && !dup) {
            await reserve(ids[gi], tpas[gi][0], shows[si].b, amt);
            reservations.push([gi, si, amt]);
          }
          if (rnd(3) === 0) {
            const dep = BigInt(1 + rnd(150)) * 1_000_000n;
            if (deposits[gi] + dep <= amounts[gi]) { await putIn(ids[gi], funder, dep); deposits[gi] += dep; }
          }
        }

        const dead = new Set();
        for (let si = 0; si < 3; si++) if (rnd(2) === 0) { await shows[si].b.escrow.connect(tourOwner).cancel(); dead.add(si); }

        // the model: each show's pool, handed to reservations in the order they were made
        const min = (a, b) => (a < b ? a : b);
        const pool = shows.map((s, i) => (dead.has(i) ? 0n : s.cover));
        const secPool = shows.map((s, i) => (dead.has(i) || !s.funded ? 0n : s.cover));
        const covered = [0n, 0n, 0n];
        const tiers = [0n, 0n, 0n];                                                       // cash, secured, contracted totals
        for (let gi = 0; gi < 3; gi++) {
          let secured = 0n, contracted = 0n;
          for (const r of reservations.filter((x) => x[0] === gi)) {
            const take = min(r[2], pool[r[1]]); pool[r[1]] -= take;
            const sec = min(take, secPool[r[1]]); secPool[r[1]] -= sec;
            secured += sec; contracted += take - sec;
          }
          let need = amounts[gi];
          const cashC = min(deposits[gi], need); need -= cashC;
          const secC = min(secured, need); need -= secC;
          const conC = min(contracted, need);
          covered[gi] = cashC + secC + conC;
          tiers[0] += cashC; tiers[1] += secC; tiers[2] += conC;
        }
        const required = amounts.reduce((x, y) => x + y, 0n);
        const eligible = covered.reduce((x, y) => x + y, 0n);

        await coverage.reconcileCoverage();
        expect(await coverage.requiredCoverage(), `trial ${trial} required`).to.equal(required);
        expect(await coverage.eligibleCoverage(), `trial ${trial} eligible`).to.equal(eligible);
        for (let gi = 0; gi < 3; gi++) expect((await coverage.getGuarantee(ids[gi])).covered, `trial ${trial} g${gi}`).to.equal(covered[gi]);
        expect(await coverage.coverageGap()).to.equal(required - eligible);
        expect(await coverage.cashCoverage(), `trial ${trial} cash`).to.equal(tiers[0]);
        expect(await coverage.securedCoverage(), `trial ${trial} secured`).to.equal(tiers[1]);
        expect(await coverage.contractedCoverage(), `trial ${trial} contracted`).to.equal(tiers[2]);
      }
    });
  });
});
