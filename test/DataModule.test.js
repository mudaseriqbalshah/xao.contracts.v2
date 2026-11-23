// test/DataModule.test.js
// The on-chain side of a show's data discount: how each data funder receives data,
// the early-access reserve, two-of-three confirmation that a report went out, and
// paying buyers from the reserve when a show is cancelled after data was released.
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { ONE_DAY, tier, deploySystem, showConfig, createShow } = require("./helpers/show");

const $ = (n) => ethers.parseUnits(String(n), 6);
const ZERO_ADDRESS = ethers.ZeroAddress;
const GA = 0;
const TAX = 800, FEE = 200, GAS = $(1);
const NONE = { availableMask: 0, grantedMasks: [], commitment: ethers.ZeroHash };
const Mode = { None: 0, PostShow: 1, Early: 2 };
const CAP = $(100);

describe("Data module", function () {
  let sys, usdc, signers;
  let promoter, artist, fan, fan2, fan3, bandA, bandB, stranger, n1, n2, n3;
  let impl, factory;
  let t0, showEnd, deadline;

  const consent = (grants = [1, 1]) => ({ availableMask: 1, grantedMasks: grants, commitment: ethers.id("consent") });

  // A show with a data program funded by bandA and bandB (each capped at CAP), with its data module wired in.
  async function newShow(name, { sign = true, wire = true, maxDiscount = $(2) } = {}) {
    const b = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
      anchors: { termsHash: ethers.id(name) }, funding: [],
      tiers: [tier({ quantity: 100, priceUSDC: $(20) })],
      tickets: { discountsEnabled: true, salesTaxBPS: TAX, taxReceiver: promoter.address },
      sweep: { recipients: [promoter.address, artist.address, bandA.address, bandB.address], bps: [3000, 4000, 2000, 1000], notBefore: showEnd },
    }));
    await b.discounts.connect(promoter).configureDataProgram({
      maxDiscount, categoryCount: 1, allowedTypeMask: 1n, budget: 0, redemptionCap: 0, effectiveFrom: 0, effectiveTo: 0,
    });
    for (const f of [bandA, bandB]) {
      await b.discounts.connect(promoter).proposeFunder(1, f.address, 1);
      await b.discounts.connect(f).authorizeFunding(1, CAP);
    }
    if (wire) {
      await factory.connect(promoter).createModule(b.show.target, b.discounts.target, [n1.address, n2.address, n3.address], deadline);
      b.data = await ethers.getContractAt("DataModule", await factory.moduleOf(b.show.target));
      await b.discounts.connect(promoter).setDataGuard(b.data.target);
    }
    if (sign) {
      await b.show.connect(promoter).signTerms();
      await b.show.connect(artist).signTerms();
    }
    return b;
  }

  async function buy(b, who, c = consent()) {
    const price = (await b.ticket.tiers(GA)).priceUSDC;
    const [q, h] = await b.discounts.quote(who.address, [GA], [price], TAX, FEE, GAS, c);
    await usdc.mint(who.address, q.checkoutTotal);
    await usdc.connect(who).approve(b.ticket.target, q.checkoutTotal);
    return b.ticket.connect(who).buyTickets([GA], c, h, q.checkoutTotal);
  }

  async function reserve(b, funder, amount) {
    await usdc.mint(funder.address, amount);
    await usdc.connect(funder).approve(b.data.target, amount);
    return b.data.connect(funder).depositReserve(amount);
  }

  // both nodes say the same thing
  async function release(b, funder, wallets, id = ethers.id("report-1")) {
    await b.data.connect(n1).confirmRelease(funder.address, id, wallets.map((w) => w.address));
    return b.data.connect(n2).confirmRelease(funder.address, id, wallets.map((w) => w.address));
  }

  async function cancelShow(b) {
    await b.escrow.connect(artist).cancel();
    await b.escrow.connect(stranger).continueRefunds(10);
    await b.escrow.connect(stranger).finalizeCancellationPayout();
    expect(await b.show.status()).to.equal(5);
  }

  async function completeShow(b) {
    await time.increaseTo(showEnd);
    await b.escrow.connect(stranger).executeFinalSweep();
    expect(await b.show.status()).to.equal(4);
  }

  beforeEach(async function () {
    signers = await ethers.getSigners();
    [, promoter, artist, , fan, fan2, fan3, bandA, bandB, stranger] = signers;
    [n1, n2, n3] = signers.slice(10, 13);
    sys = await deploySystem();
    usdc = sys.usdc;
    t0 = await time.latest();
    showEnd = t0 + 30 * ONE_DAY + 7_200;
    deadline = t0 + 3 * ONE_DAY;
    impl = await (await ethers.getContractFactory("DataModule")).deploy();
    factory = await (await ethers.getContractFactory("DataModuleFactory")).deploy(impl.target);
  });

  // ─── THE FACTORY AND THE MODULE'S SET-UP ────────────────────────────────
  describe("set-up", function () {
    it("makes one module per show for a show party, and binds it to the show's coordinator and token", async function () {
      const b = await newShow("setup", { sign: false });
      expect(await b.data.show()).to.equal(b.show.target);
      expect(await b.data.coordinator()).to.equal(b.discounts.target);
      expect(await b.data.token()).to.equal(usdc.target);
      expect(await b.data.reserveDeadline()).to.equal(deadline);
      expect(await b.data.nodes(0)).to.equal(n1.address);
      expect(await b.data.nodes(2)).to.equal(n3.address);
      expect(await b.discounts.dataGuard()).to.equal(b.data.target);

      await expect(factory.connect(promoter).createModule(b.show.target, b.discounts.target, [n1.address, n2.address, n3.address], deadline))
        .to.be.revertedWithCustomError(factory, "AlreadyCreated");
      await expect(b.data.initialize(b.show.target, b.discounts.target, [n1.address, n2.address, n3.address], deadline))
        .to.be.revertedWithCustomError(b.data, "AlreadyInitialized");
    });

    it("refuses a stranger, a coordinator of another show, repeated or empty nodes and a past deadline", async function () {
      const b = await newShow("setup-bad", { wire: false, sign: false });
      const other = await newShow("setup-other", { wire: false, sign: false });
      const nodes = [n1.address, n2.address, n3.address];
      await expect(factory.connect(stranger).createModule(b.show.target, b.discounts.target, nodes, deadline)).to.be.revertedWithCustomError(factory, "NotAShowParty");
      await expect(factory.connect(promoter).createModule(b.show.target, other.discounts.target, nodes, deadline)).to.be.revertedWithCustomError(factory, "WrongCoordinator");
      await expect(factory.connect(promoter).createModule(b.show.target, b.discounts.target, [n1.address, n1.address, n3.address], deadline)).to.be.revertedWithCustomError(impl, "BadNodes");
      await expect(factory.connect(promoter).createModule(b.show.target, b.discounts.target, [n1.address, n2.address, n1.address], deadline)).to.be.revertedWithCustomError(impl, "BadNodes");
      await expect(factory.connect(promoter).createModule(b.show.target, b.discounts.target, [n1.address, n2.address, n2.address], deadline)).to.be.revertedWithCustomError(impl, "BadNodes");
      await expect(factory.connect(promoter).createModule(b.show.target, b.discounts.target, [ZERO_ADDRESS, n2.address, n3.address], deadline)).to.be.revertedWithCustomError(impl, "BadNodes");
      await expect(factory.connect(promoter).createModule(b.show.target, b.discounts.target, nodes, t0)).to.be.revertedWithCustomError(impl, "BadDeadline");
      await expect(impl.initialize(b.show.target, b.discounts.target, nodes, deadline)).to.be.revertedWithCustomError(impl, "AlreadyInitialized");
    });

    it("lets only the show side name the module, and only before the show is signed", async function () {
      const b = await newShow("guard", { sign: false });
      await expect(b.discounts.connect(stranger).setDataGuard(b.data.target)).to.be.revertedWithCustomError(b.discounts, "NotShowSide");
      await expect(b.discounts.connect(promoter).setDataGuard(fan.address)).to.be.revertedWithCustomError(b.discounts, "ZeroAddress");
      await b.discounts.connect(promoter).setDataGuard(ZERO_ADDRESS);
      expect(await b.discounts.dataGuard()).to.equal(ZERO_ADDRESS);
      await b.discounts.connect(promoter).setDataGuard(b.data.target);
      await b.show.connect(promoter).signTerms();
      await b.show.connect(artist).signTerms();
      await expect(b.discounts.connect(promoter).setDataGuard(ZERO_ADDRESS)).to.be.revertedWithCustomError(b.discounts, "ShowAlreadySigned");
    });

    it("needs a data program, and speaks only for funders on its roster", async function () {
      const b = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("no-program") }, funding: [],
        tiers: [tier({ quantity: 10, priceUSDC: $(20) })],
        tickets: { discountsEnabled: true, salesTaxBPS: TAX, taxReceiver: promoter.address },
      }));
      await factory.connect(promoter).createModule(b.show.target, b.discounts.target, [n1.address, n2.address, n3.address], deadline);
      const m = await ethers.getContractAt("DataModule", await factory.moduleOf(b.show.target));
      await expect(m.connect(bandA).setMode(Mode.PostShow)).to.be.revertedWithCustomError(m, "NoDataProgram");

      const c = await newShow("roster", { sign: false });
      await expect(c.data.connect(stranger).setMode(Mode.PostShow)).to.be.revertedWithCustomError(c.data, "NotFunderSigner");
      await expect(c.data.connect(stranger).depositReserve(1)).to.be.revertedWithCustomError(c.data, "NotFunderSigner");
      await expect(c.data.connect(stranger).withdrawReserve()).to.be.revertedWithCustomError(c.data, "NotFunderSigner");
    });
  });

  // ─── HOW A FUNDER RECEIVES DATA ─────────────────────────────────────────
  describe("choosing how to receive data", function () {
    it("lets a first choice be either, and the reserve requirement is the funder's cap", async function () {
      const b = await newShow("mode");
      expect(await b.data.requiredReserve(bandA.address)).to.equal(CAP);
      await expect(b.data.connect(bandA).setMode(Mode.None)).to.be.revertedWithCustomError(b.data, "WrongMode");
      await expect(b.data.connect(bandA).setMode(Mode.Early)).to.emit(b.data, "ModeSet").withArgs(bandA.address, Mode.Early);
      await expect(b.data.connect(bandB).setMode(Mode.PostShow)).to.emit(b.data, "ModeSet").withArgs(bandB.address, Mode.PostShow);
      expect(await b.data.modeOf(bandA.address)).to.equal(Mode.Early);
      expect(await b.data.modeOf(bandB.address)).to.equal(Mode.PostShow);
    });

    it("never goes back from EARLY, and cannot repeat the same choice", async function () {
      const b = await newShow("mode-lock");
      await b.data.connect(bandA).setMode(Mode.Early);
      await expect(b.data.connect(bandA).setMode(Mode.PostShow)).to.be.revertedWithCustomError(b.data, "ModeLocked");
      await expect(b.data.connect(bandA).setMode(Mode.Early)).to.be.revertedWithCustomError(b.data, "WrongMode");
      await b.data.connect(bandB).setMode(Mode.PostShow);
      await expect(b.data.connect(bandB).setMode(Mode.PostShow)).to.be.revertedWithCustomError(b.data, "WrongMode");
    });

    it("moves from POST_SHOW to EARLY only with the reserve in, and only before the show starts", async function () {
      const b = await newShow("mode-up");
      await b.data.connect(bandB).setMode(Mode.PostShow);
      await expect(b.data.connect(bandB).setMode(Mode.Early)).to.be.revertedWithCustomError(b.data, "ReserveMissing");
      await reserve(b, bandB, CAP - 1n);
      await expect(b.data.connect(bandB).setMode(Mode.Early)).to.be.revertedWithCustomError(b.data, "ReserveMissing");   // one unit short
      await reserve(b, bandB, 1n);
      await b.data.connect(bandB).setMode(Mode.Early);
      expect(await b.data.modeOf(bandB.address)).to.equal(Mode.Early);

      const c = await newShow("mode-late");
      await c.data.connect(bandB).setMode(Mode.PostShow);
      await reserve(c, bandB, CAP);
      await time.increaseTo(Number(await c.show.showStartTime()));
      await expect(c.data.connect(bandB).setMode(Mode.Early)).to.be.revertedWithCustomError(c.data, "ShowStarted");
    });
  });

  // ─── THE RESERVE ────────────────────────────────────────────────────────
  describe("the reserve", function () {
    it("is put in by the funder's signer until the deadline, and not after", async function () {
      const b = await newShow("reserve");
      await expect(reserve(b, bandA, $(40))).to.emit(b.data, "ReserveDeposited").withArgs(bandA.address, $(40), $(40));
      await reserve(b, bandA, $(60));
      expect(await b.data.reserveOf(bandA.address)).to.equal($(100));
      expect(await usdc.balanceOf(b.data.target)).to.equal($(100));
      await expect(b.data.connect(bandA).depositReserve(0)).to.be.revertedWithCustomError(b.data, "ZeroAmount");

      await time.increaseTo(deadline + 1);
      await usdc.mint(bandA.address, $(1));
      await usdc.connect(bandA).approve(b.data.target, $(1));
      await expect(b.data.connect(bandA).depositReserve($(1))).to.be.revertedWithCustomError(b.data, "DeadlinePassed");
    });

    it("accepts a deposit exactly at the deadline", async function () {
      const b = await newShow("reserve-edge");
      await usdc.mint(bandA.address, $(1));
      await usdc.connect(bandA).approve(b.data.target, $(1));
      await time.setNextBlockTimestamp(deadline);
      await b.data.connect(bandA).depositReserve($(1));
      expect(await b.data.reserveOf(bandA.address)).to.equal($(1));
    });

    it("is returned in full when the show is completed, and not before", async function () {
      const b = await newShow("reserve-back");
      await reserve(b, bandA, CAP);
      await expect(b.data.connect(bandA).withdrawReserve()).to.be.revertedWithCustomError(b.data, "NotFinished");
      await completeShow(b);
      const before = await usdc.balanceOf(bandA.address);
      await expect(b.data.connect(bandA).withdrawReserve()).to.emit(b.data, "ReserveWithdrawn").withArgs(bandA.address, CAP);
      expect(await usdc.balanceOf(bandA.address)).to.equal(before + CAP);
      expect(await b.data.reserveOf(bandA.address)).to.equal(0);
      await expect(b.data.connect(bandA).withdrawReserve()).to.be.revertedWithCustomError(b.data, "ZeroAmount");
    });
  });

  // ─── WHO IS BACKED ──────────────────────────────────────────────────────
  describe("which funders the coordinator counts", function () {
    it("counts POST_SHOW funders, counts EARLY funders only with their cap in reserve, and nobody who has not chosen", async function () {
      const b = await newShow("backed");
      expect(await b.data.funderBacked(bandA.address)).to.equal(false);              // has not chosen
      await b.data.connect(bandA).setMode(Mode.Early);
      expect(await b.data.funderBacked(bandA.address)).to.equal(false);              // chose EARLY, no reserve
      await reserve(b, bandA, CAP - 1n);
      expect(await b.data.funderBacked(bandA.address)).to.equal(false);
      await reserve(b, bandA, 1n);
      expect(await b.data.funderBacked(bandA.address)).to.equal(true);
      await b.data.connect(bandB).setMode(Mode.PostShow);
      expect(await b.data.funderBacked(bandB.address)).to.equal(true);
      expect(await b.data.funderBacked(stranger.address)).to.equal(false);
    });

    it("gives a buyer's discount only for the funders that are backed", async function () {
      const b = await newShow("backed-quote");
      const price = (await b.ticket.tiers(GA)).priceUSDC;
      const quoted = async (w) => (await b.discounts.quote(w.address, [GA], [price], TAX, FEE, GAS, consent()))[0].discounts.totalDiscount;
      expect(await quoted(fan)).to.equal(0);                                          // nobody has chosen

      await b.data.connect(bandB).setMode(Mode.PostShow);
      expect(await quoted(fan)).to.equal($(1));                                       // only bandB's cell: $2 split in two cells

      await b.data.connect(bandA).setMode(Mode.Early);
      expect(await quoted(fan)).to.equal($(1));                                       // bandA has not put its reserve in
      await reserve(b, bandA, CAP);
      expect(await quoted(fan)).to.equal($(2));                                       // both in
    });

    it("charges only the funders that were backed when the buyer bought, and records each one's share", async function () {
      const b = await newShow("share");
      await b.data.connect(bandB).setMode(Mode.PostShow);
      await b.data.connect(bandA).setMode(Mode.Early);                                // not backed yet
      await buy(b, fan);
      expect(await b.discounts.dataShare(fan.address, bandB.address)).to.equal($(1));
      expect(await b.discounts.dataShare(fan.address, bandA.address)).to.equal(0);
      expect(await b.discounts.funderDebit(bandA.address)).to.equal(0);

      await reserve(b, bandA, CAP);
      await buy(b, fan2);
      expect(await b.discounts.dataShare(fan2.address, bandA.address)).to.equal($(1));
      expect(await b.discounts.dataShare(fan2.address, bandB.address)).to.equal($(1));
      expect(await b.discounts.funderDebit(bandA.address)).to.equal($(1));
    });

    it("treats a data module that cannot answer as 'not backed'", async function () {
      const b = await newShow("broken-guard", { sign: false });
      const dead = await (await ethers.getContractFactory("MockERC20")).deploy("X", "X", 6);   // has code, has no funderBacked
      await b.discounts.connect(promoter).setDataGuard(dead.target);
      await b.show.connect(promoter).signTerms();
      await b.show.connect(artist).signTerms();
      const price = (await b.ticket.tiers(GA)).priceUSDC;
      const [q] = await b.discounts.quote(fan.address, [GA], [price], TAX, FEE, GAS, consent());
      expect(q.discounts.totalDiscount).to.equal(0);
    });
  });

  // ─── CONFIRMING THAT A REPORT WENT OUT ──────────────────────────────────
  describe("reports", function () {
    let b;
    beforeEach(async function () {
      b = await newShow("report");
      await b.data.connect(bandA).setMode(Mode.Early);
      await reserve(b, bandA, CAP);
      await b.data.connect(bandB).setMode(Mode.PostShow);
      await buy(b, fan);
      await buy(b, fan2);
    });

    it("is recorded when two of the three nodes say so, and not before", async function () {
      const id = ethers.id("r1");
      const ws = [fan.address, fan2.address];
      await expect(b.data.connect(n1).confirmRelease(bandA.address, id, ws)).to.emit(b.data, "ReleaseConfirmed");
      expect(await b.data.released(bandA.address, fan.address)).to.equal(false);
      await expect(b.data.connect(n3).confirmRelease(bandA.address, id, ws))
        .to.emit(b.data, "ReportReleased").withArgs(id, bandA.address, fan.address)
        .and.to.emit(b.data, "ReportReleased").withArgs(id, bandA.address, fan2.address);
      expect(await b.data.released(bandA.address, fan.address)).to.equal(true);
      expect(await b.data.released(bandA.address, fan2.address)).to.equal(true);
      expect(await b.data.owedOf(bandA.address)).to.equal($(2));
    });

    it("is not recorded by one node saying it twice, or by nodes that say different things", async function () {
      const id = ethers.id("r2");
      await b.data.connect(n1).confirmRelease(bandA.address, id, [fan.address]);
      await b.data.connect(n1).confirmRelease(bandA.address, id, [fan.address]);
      const h = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes32", "address[]"], [bandA.address, id, [fan.address]]));
      expect(await b.data.confirmations(h)).to.equal(1);
      expect(await b.data.released(bandA.address, fan.address)).to.equal(false);

      await b.data.connect(n2).confirmRelease(bandA.address, id, [fan.address, fan2.address]);      // a different list
      await b.data.connect(n3).confirmRelease(bandA.address, ethers.id("other"), [fan.address]);     // a different report
      expect(await b.data.released(bandA.address, fan.address)).to.equal(false);
    });

    it("lets a third node's confirmation of a recorded report pass without doing anything", async function () {
      const id = ethers.id("r3");
      await release(b, bandA, [fan], id);
      await b.data.connect(n3).confirmRelease(bandA.address, id, [fan.address]);
      expect(await b.data.owedOf(bandA.address)).to.equal($(1));
    });

    it("can be confirmed by the nodes only, with a list that is neither empty nor too long", async function () {
      await expect(b.data.connect(stranger).confirmRelease(bandA.address, ethers.id("x"), [fan.address])).to.be.revertedWithCustomError(b.data, "NotANode");
      await expect(b.data.connect(promoter).confirmRelease(bandA.address, ethers.id("x"), [fan.address])).to.be.revertedWithCustomError(b.data, "NotANode");
      await expect(b.data.connect(n1).confirmRelease(bandA.address, ethers.id("x"), [])).to.be.revertedWithCustomError(b.data, "NothingToRelease");
      await expect(b.data.connect(n1).confirmRelease(bandA.address, ethers.id("x"), Array(101).fill(fan.address))).to.be.revertedWithCustomError(b.data, "TooManyWallets");
    });

    it("skips a wallet that was already released, but refuses one the funder was never charged for", async function () {
      await release(b, bandA, [fan], ethers.id("a"));
      await release(b, bandA, [fan, fan2], ethers.id("b"));                           // fan again: skipped, not counted twice
      expect(await b.data.owedOf(bandA.address)).to.equal($(2));

      await expect(release(b, bandA, [fan3], ethers.id("c"))).to.be.revertedWithCustomError(b.data, "NotAllowedNow");   // fan3 shared nothing
      expect(await b.data.released(bandA.address, fan3.address)).to.equal(false);
    });

    it("goes only to a funder that is entitled to it: the one that was charged, and is EARLY or the show is over", async function () {
      expect(await b.data.canRelease(bandA.address, fan.address)).to.equal(true);
      expect(await b.data.canRelease(bandA.address, fan3.address)).to.equal(false);        // no claim
      expect(await b.data.canRelease(bandB.address, fan.address)).to.equal(false);          // POST_SHOW: not until the show is completed
      expect(await b.data.canRelease(stranger.address, fan.address)).to.equal(false);       // not a funder

      await expect(release(b, bandB, [fan])).to.be.revertedWithCustomError(b.data, "NotAllowedNow");
      await completeShow(b);
      expect(await b.data.canRelease(bandB.address, fan.address)).to.equal(true);
      await release(b, bandB, [fan]);
      expect(await b.data.released(bandB.address, fan.address)).to.equal(true);
      expect(await b.data.canRelease(bandB.address, fan.address)).to.equal(false);           // already released
    });

    it("stops once the show is cancelled", async function () {
      await cancelShow(b);
      expect(await b.data.canRelease(bandA.address, fan.address)).to.equal(false);
      await expect(release(b, bandA, [fan])).to.be.revertedWithCustomError(b.data, "NotAllowedNow");
    });

    it("is not offered to a funder that has not chosen how to receive data", async function () {
      const c = await newShow("no-choice");
      await buy(c, fan);                                                                  // nobody is backed: no claim
      expect(await c.data.canRelease(bandA.address, fan.address)).to.equal(false);
    });
  });

  // ─── MORE EDGES ─────────────────────────────────────────────────────────
  describe("edges", function () {
    it("keeps an EARLY funder entitled to its reports after the show, even once it has taken its reserve back", async function () {
      const b = await newShow("early-after");
      await b.data.connect(bandA).setMode(Mode.Early);
      await reserve(b, bandA, CAP);
      await buy(b, fan);
      await buy(b, fan2);
      await release(b, bandA, [fan], ethers.id("1"));
      await completeShow(b);
      await b.data.connect(bandA).withdrawReserve();
      expect(await b.data.funderBacked(bandA.address)).to.equal(false);
      expect(await b.data.canRelease(bandA.address, fan2.address)).to.equal(true);
      await release(b, bandA, [fan2], ethers.id("2"));
      expect(await b.data.released(bandA.address, fan2.address)).to.equal(true);
    });

    it("does not let a funder go back to 'not chosen'", async function () {
      const b = await newShow("no-reset");
      await b.data.connect(bandB).setMode(Mode.PostShow);
      await expect(b.data.connect(bandB).setMode(Mode.None)).to.be.revertedWithCustomError(b.data, "WrongMode");
      expect(await b.data.modeOf(bandB.address)).to.equal(Mode.PostShow);
    });

    it("counts every data funder when the show has no data module", async function () {
      const b = await newShow("no-guard", { wire: false });
      const price = (await b.ticket.tiers(GA)).priceUSDC;
      const [q] = await b.discounts.quote(fan.address, [GA], [price], TAX, FEE, GAS, consent());
      expect(q.discounts.totalDiscount).to.equal($(2));
    });

    it("treats a show that expired like a cancelled one: buyers are paid and the rest of the reserve can go back", async function () {
      const b = await newShow("expired");
      await b.data.connect(bandA).setMode(Mode.Early);
      await reserve(b, bandA, CAP);
      await buy(b, fan);
      await release(b, bandA, [fan]);
      await time.increaseTo(showEnd + 1);
      await b.show.markExpired();
      expect(await b.show.status()).to.equal(6);

      expect(await b.data.canRelease(bandA.address, fan.address)).to.equal(false);
      await b.data.compensate(bandA.address, fan.address);
      const before = await usdc.balanceOf(bandA.address);
      await b.data.connect(bandA).withdrawReserve();
      expect(await usdc.balanceOf(bandA.address)).to.equal(before + CAP - $(1));
    });

    it("lets an org funder be spoken for by its owners and admins, and pays the reserve back to the org", async function () {
      const [owner, admin, operator] = signers.slice(13, 16);
      const ROLE = { ADMIN: ethers.id("ROLE_ADMIN"), OWNER: ethers.id("ROLE_OWNER"), OPERATOR: ethers.id("ROLE_OPERATOR") };
      const GRANT = { ADMIN: ethers.id("ADMIN_GRANT"), OWNER: ethers.id("OWNER_GRANT"), OPERATOR: ethers.id("OPERATOR_GRANT") };
      const wImpl = await (await ethers.getContractFactory("MiniOrgWallet")).deploy();
      const gImpl = await (await ethers.getContractFactory("MiniOrgGrant")).deploy();
      const of = await (await ethers.getContractFactory("MiniOrgFactory")).deploy(wImpl.target, gImpl.target, sys.registry.target);
      const salt = ethers.id("data-band");
      const orgAddress = await of.predictMiniOrg(owner.address, salt);

      const b = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("org-data") }, funding: [],
        tiers: [tier({ quantity: 10, priceUSDC: $(20) })],
        tickets: { discountsEnabled: true, salesTaxBPS: TAX, taxReceiver: promoter.address },
        sweep: { recipients: [promoter.address, artist.address, orgAddress], bps: [3000, 5000, 2000], notBefore: showEnd },
      }));
      const made = await (await of.connect(owner).createMiniOrg(salt, ZERO_ADDRESS, [owner.address], ethers.ZeroHash, "")).wait();
      const parse = (r, n) => of.interface.parseLog(r.logs.find((l) => l.address === of.target && of.interface.parseLog(l)?.name === n));
      const org = await ethers.getContractAt("MiniOrgWallet", parse(made, "MiniOrgCreated").args.org);
      const attach = async (type, user, role) => {
        const rr = await (await of.connect(owner).createGrant(org.target, type, 0, 0, ethers.ZeroHash, "", [{ user: user.address, role, expiresAt: 0 }])).wait();
        await org.connect(owner).addGrant(parse(rr, "GrantCreated").args.grant);
      };
      await attach(GRANT.ADMIN, admin, ROLE.ADMIN);
      await attach(GRANT.OPERATOR, operator, ROLE.OPERATOR);
      await attach(GRANT.OWNER, owner, ROLE.OWNER);

      await b.discounts.connect(promoter).configureDataProgram({ maxDiscount: $(2), categoryCount: 1, allowedTypeMask: 1n, budget: 0, redemptionCap: 0, effectiveFrom: 0, effectiveTo: 0 });
      await b.discounts.connect(promoter).proposeFunder(1, org.target, 1);
      await b.discounts.connect(admin).authorizeFunding(1, CAP);
      await factory.connect(promoter).createModule(b.show.target, b.discounts.target, [n1.address, n2.address, n3.address], deadline);
      const m = await ethers.getContractAt("DataModule", await factory.moduleOf(b.show.target));
      await b.discounts.connect(promoter).setDataGuard(m.target);
      await b.show.connect(promoter).signTerms();
      await b.show.connect(artist).signTerms();

      await expect(m.connect(operator).setMode(Mode.PostShow)).to.be.revertedWithCustomError(m, "NotFunderSigner");
      await expect(m.connect(stranger).setMode(Mode.PostShow)).to.be.revertedWithCustomError(m, "NotFunderSigner");
      await m.connect(admin).setMode(Mode.Early);
      await usdc.mint(owner.address, CAP);
      await usdc.connect(owner).approve(m.target, CAP);
      await m.connect(owner).depositReserve(CAP);
      expect(await m.reserveOf(org.target)).to.equal(CAP);
      expect(await m.funderBacked(org.target)).to.equal(true);

      await completeShow(b);
      await expect(m.connect(operator).withdrawReserve()).to.be.revertedWithCustomError(m, "NotFunderSigner");
      const orgBefore = await usdc.balanceOf(org.target);
      const adminBefore = await usdc.balanceOf(admin.address);
      await m.connect(admin).withdrawReserve();
      expect(await usdc.balanceOf(org.target)).to.equal(orgBefore + CAP);
      expect(await usdc.balanceOf(admin.address)).to.equal(adminBefore);
    });
  });

  // ─── A CANCELLED SHOW ───────────────────────────────────────────────────
  describe("a cancelled show", function () {
    let b;
    beforeEach(async function () {
      b = await newShow("cancel");
      await b.data.connect(bandA).setMode(Mode.Early);
      await reserve(b, bandA, CAP);
      await b.data.connect(bandB).setMode(Mode.PostShow);
      await buy(b, fan);
      await buy(b, fan2);
    });

    it("pays each buyer the discount the funder gave, for the reports that were released, out of the reserve", async function () {
      await release(b, bandA, [fan]);                                                      // fan's report went out, fan2's did not
      await cancelShow(b);

      const before = await usdc.balanceOf(fan.address);
      await expect(b.data.compensate(bandA.address, fan.address)).to.emit(b.data, "Compensated").withArgs(bandA.address, fan.address, $(1));
      expect(await usdc.balanceOf(fan.address)).to.equal(before + $(1));
      expect(await b.data.reserveOf(bandA.address)).to.equal(CAP - $(1));
      expect(await b.data.owedOf(bandA.address)).to.equal(0);

      await expect(b.data.compensate(bandA.address, fan.address)).to.be.revertedWithCustomError(b.data, "AlreadyPaid");
      await expect(b.data.compensate(bandA.address, fan2.address)).to.be.revertedWithCustomError(b.data, "NotReleased");     // never released
      await expect(b.data.compensate(bandB.address, fan.address)).to.be.revertedWithCustomError(b.data, "NotReleased");       // POST_SHOW: nothing was delivered
    });

    it("pays nothing before the show is cancelled, or when it is completed", async function () {
      await release(b, bandA, [fan]);
      await expect(b.data.compensate(bandA.address, fan.address)).to.be.revertedWithCustomError(b.data, "NotFinished");
      await completeShow(b);
      await expect(b.data.compensate(bandA.address, fan.address)).to.be.revertedWithCustomError(b.data, "NotFinished");
    });

    it("keeps what is still owed to buyers when the funder asks for its reserve back", async function () {
      await release(b, bandA, [fan, fan2]);
      await cancelShow(b);
      const before = await usdc.balanceOf(bandA.address);
      await b.data.connect(bandA).withdrawReserve();
      expect(await usdc.balanceOf(bandA.address)).to.equal(before + CAP - $(2));           // $2 stays for the two buyers
      expect(await b.data.reserveOf(bandA.address)).to.equal($(2));

      await b.data.compensate(bandA.address, fan.address);
      await b.data.compensate(bandA.address, fan2.address);
      expect(await b.data.reserveOf(bandA.address)).to.equal(0);
      expect(await usdc.balanceOf(b.data.target)).to.equal(0);
      await expect(b.data.connect(bandA).withdrawReserve()).to.be.revertedWithCustomError(b.data, "ZeroAmount");
    });

    it("gives a funder with nothing released its whole reserve back", async function () {
      await cancelShow(b);
      const before = await usdc.balanceOf(bandA.address);
      await b.data.connect(bandA).withdrawReserve();
      expect(await usdc.balanceOf(bandA.address)).to.equal(before + CAP);
    });

    it("can always pay every buyer, whatever was released: the reserve covers the funder's cap", async function () {
      const wallets = [fan, fan2, fan3, stranger, promoter, artist];
      for (const w of wallets.slice(2)) await buy(b, w);
      await release(b, bandA, wallets);
      const owed = await b.data.owedOf(bandA.address);
      expect(owed).to.equal(await b.discounts.funderDebit(bandA.address));
      expect(owed).to.be.lte(await b.data.reserveOf(bandA.address));
      await cancelShow(b);
      for (const w of wallets) await b.data.compensate(bandA.address, w.address);
      expect(await b.data.reserveOf(bandA.address)).to.equal(CAP - owed);
    });
  });

  // ─── MONEY NEVER LEAKS ──────────────────────────────────────────────────
  describe("money held", function () {
    it("always equals the reserves that are held, over deposits, compensation and withdrawals", async function () {
      const b = await newShow("conservation");
      await b.data.connect(bandA).setMode(Mode.Early);
      await b.data.connect(bandB).setMode(Mode.Early);
      await reserve(b, bandA, CAP);
      await reserve(b, bandB, CAP + $(7));
      const buyers = [fan, fan2, fan3];
      for (const w of buyers) await buy(b, w);
      await release(b, bandA, buyers, ethers.id("1"));
      await release(b, bandB, [fan, fan3], ethers.id("2"));
      await cancelShow(b);

      const held = async () => (await b.data.reserveOf(bandA.address)) + (await b.data.reserveOf(bandB.address));
      expect(await usdc.balanceOf(b.data.target)).to.equal(await held());
      await b.data.compensate(bandA.address, fan.address);
      expect(await usdc.balanceOf(b.data.target)).to.equal(await held());
      await b.data.connect(bandB).withdrawReserve();
      expect(await usdc.balanceOf(b.data.target)).to.equal(await held());
      await b.data.compensate(bandB.address, fan3.address);
      await b.data.compensate(bandB.address, fan.address);
      expect(await b.data.reserveOf(bandB.address)).to.equal(0);
      await b.data.compensate(bandA.address, fan2.address);
      await b.data.compensate(bandA.address, fan3.address);
      await b.data.connect(bandA).withdrawReserve();
      expect(await usdc.balanceOf(b.data.target)).to.equal(0);
      expect(await held()).to.equal(0);
    });
  });
});
