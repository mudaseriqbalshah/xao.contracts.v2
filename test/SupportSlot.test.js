// test/SupportSlot.test.js
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time }   = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const {
  USDC, ONE_DAY, ZERO_BYTES32, ZERO_ADDRESS, ShowStatus, EscrowStatus, PayoutKind,
  EdgeType, EdgeStatus, edgeIdOf, deploySystem, showConfig, createShow,
} = require("./helpers/show");

const SlotStatus = { Draft: 0, Signed: 1, Active: 2, InDispute: 3, Completed: 4, Cancelled: 5 };
const Ruling     = { None: 0, NoBreach: 1, BreachBySupport: 2, BreachByOrganizer: 3 };
const TERMS_HASH = ethers.id("support-slot-terms");
const GUARANTEE  = USDC(500);

function slotInit(organizer, band, bundle, usdc, overrides = {}) {
  return {
    partyA: organizer.address,
    partyB: band.address,
    parentShow: bundle.show.target,
    parentEscrow: bundle.escrow.target,
    guaranteeAmount: GUARANTEE,
    payoutToken: usdc.target,
    termsHash: TERMS_HASH,
    termsCID: "ipfs://slot-terms",
    ...overrides,
  };
}

async function deploySlotFactory() {
  const impl = await (await ethers.getContractFactory("SupportSlotAgreement")).deploy();
  await impl.waitForDeployment();
  const factory = await (await ethers.getContractFactory("SupportSlotFactory")).deploy(impl.target);
  await factory.waitForDeployment();
  return { impl, factory };
}

async function createSlot(factory, organizer, init) {
  const receipt = await (await factory.connect(organizer).createSupportSlot(init)).wait();
  const log = receipt.logs
    .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((l) => l && l.name === "SupportSlotCreated");
  return ethers.getContractAt("SupportSlotAgreement", log.args.slot);
}

describe("Support slots", function () {
  let sys, slotImpl, slotFactory;
  let owner, promoter, artist, treasury, band, band2, stranger, fan;
  let t0, cfg, bundle, usdc, show, escrow, slot;

  async function signShow() {
    await show.connect(promoter).signTerms();
    await show.connect(artist).signTerms();
  }

  async function signSlot(s = slot) {
    await s.connect(promoter).sign();
    await s.connect(band).sign();
  }

  async function deposit(amount) {
    await usdc.mint(promoter.address, amount);
    await usdc.connect(promoter).approve(escrow.target, amount);
    await escrow.connect(promoter).deposit(amount);
  }

  // Both parties of the show approve the same reservation.
  async function reserve(s, amount) {
    await escrow.connect(promoter).reserveForSubordinate(s.target, amount);
    await escrow.connect(artist).reserveForSubordinate(s.target, amount);
  }

  async function fundDirect(amount, s = slot) {
    await usdc.mint(promoter.address, amount);
    await usdc.connect(promoter).approve(s.target, amount);
    await s.connect(promoter).fundDirect(amount);
  }

  async function completeShow() {
    await time.increaseTo(cfg.dates.showEndTime);
    await escrow.connect(stranger).executeFinalSweep();
  }

  beforeEach(async function () {
    [owner, promoter, artist, treasury, band, band2, stranger, fan] = await ethers.getSigners();
    sys = await deploySystem();
    usdc = sys.usdc;
    ({ impl: slotImpl, factory: slotFactory } = await deploySlotFactory());

    t0  = await time.latest();
    cfg = showConfig(promoter, artist, t0, { funding: [] });
    bundle = await createShow(sys.factory, promoter, cfg);
    ({ show, escrow } = bundle);
    slot = await createSlot(slotFactory, promoter, slotInit(promoter, band, bundle, usdc));
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("SupportSlotFactory", function () {
    it("rejects a zero implementation", async function () {
      const F = await ethers.getContractFactory("SupportSlotFactory");
      await expect(F.deploy(ZERO_ADDRESS)).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("lets only the organizer create the slot, and records it", async function () {
      await expect(slotFactory.connect(band).createSupportSlot(slotInit(promoter, band, bundle, usdc)))
        .to.be.revertedWithCustomError(slotFactory, "NotOrganizer");

      expect(await slotFactory.getSlotCount()).to.equal(1);
      expect(await slotFactory.getSlotsOfShow(show.target)).to.deep.equal([slot.target]);
      expect(await slotFactory.getUserSlots(promoter.address)).to.deep.equal([slot.target]);
      expect(await slotFactory.getUserSlots(band.address)).to.deep.equal([slot.target]);
    });

    it("stores the terms and starts as a Draft", async function () {
      expect(await slot.partyA()).to.equal(promoter.address);
      expect(await slot.partyB()).to.equal(band.address);
      expect(await slot.parentShow()).to.equal(show.target);
      expect(await slot.parentEscrow()).to.equal(escrow.target);
      expect(await slot.guaranteeAmount()).to.equal(GUARANTEE);
      expect(await slot.payoutToken()).to.equal(usdc.target);
      expect(await slot.termsHash()).to.equal(TERMS_HASH);
      expect(await slot.status()).to.equal(SlotStatus.Draft);
    });

    it("cannot be initialized twice, and the implementation is locked", async function () {
      const init = slotInit(promoter, band, bundle, usdc);
      await expect(slot.initialize(init)).to.be.revertedWithCustomError(slot, "AlreadyInitialized");
      await expect(slotImpl.initialize(init)).to.be.revertedWithCustomError(slotImpl, "AlreadyInitialized");
    });

    it("rejects invalid slots", async function () {
      const bad = (overrides) =>
        slotFactory.connect(promoter).createSupportSlot(slotInit(promoter, band, bundle, usdc, overrides));

      await expect(bad({ partyB: ZERO_ADDRESS })).to.be.revertedWithCustomError(slotImpl, "ZeroAddress");
      await expect(bad({ partyB: promoter.address })).to.be.revertedWithCustomError(slotImpl, "SamePartyOnBothSides");
      await expect(bad({ guaranteeAmount: 0 })).to.be.revertedWithCustomError(slotImpl, "ZeroGuarantee");
      await expect(bad({ termsHash: ZERO_BYTES32 })).to.be.revertedWithCustomError(slotImpl, "ZeroTermsHash");

      const otherToken = await (await ethers.getContractFactory("MockERC20")).deploy("Other", "OTH", 6);
      await expect(bad({ payoutToken: otherToken.target })).to.be.revertedWithCustomError(slotImpl, "TokenMismatch");

      const other = showConfig(promoter, artist, t0, {
        funding: [], anchors: { termsHash: ethers.id("other-show") },
      });
      const otherBundle = await createShow(sys.factory, promoter, other);
      await expect(bad({ parentEscrow: otherBundle.escrow.target }))
        .to.be.revertedWithCustomError(slotImpl, "EscrowNotOfShow");
    });

    it("is a graph node whose parties are the organizer and the band", async function () {
      expect(await sys.registry.getRequiredConfirmersForNode(slot.target))
        .to.deep.equal([promoter.address, band.address]);
    });

    it("is linked under its show by the organizer, and the show's parties confirm", async function () {
      const PARENTS = 2;
      const id = edgeIdOf(show.target, slot.target, PARENTS);
      // The organizer is a party on the show here, so the link is live at once.
      await sys.registry.connect(promoter).registerEdge(show.target, slot.target, PARENTS, ZERO_BYTES32, "");
      expect(await sys.registry.edgeStatus(id)).to.equal(EdgeStatus.Active);

      // An organizer who is not on the show has to wait for the show's parties.
      const outsiderSlot = await createSlot(slotFactory, band2, slotInit(band2, band, bundle, usdc));
      const id2 = edgeIdOf(show.target, outsiderSlot.target, PARENTS);
      await sys.registry.connect(band2).registerEdge(show.target, outsiderSlot.target, PARENTS, ZERO_BYTES32, "");
      expect(await sys.registry.edgeStatus(id2)).to.equal(EdgeStatus.Pending);
      await sys.registry.connect(promoter).confirmEdge(id2);
      await sys.registry.connect(artist).confirmEdge(id2);
      expect(await sys.registry.edgeStatus(id2)).to.equal(EdgeStatus.Active);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("Signing", function () {
    it("is Signed once both parties have signed", async function () {
      await slot.connect(promoter).sign();
      expect(await slot.status()).to.equal(SlotStatus.Draft);
      await slot.connect(band).sign();
      expect(await slot.status()).to.equal(SlotStatus.Signed);
    });

    it("rejects a non-party, a second signature, or signing once Signed", async function () {
      await expect(slot.connect(stranger).sign()).to.be.revertedWithCustomError(slot, "NotAParty");
      await slot.connect(promoter).sign();
      await expect(slot.connect(promoter).sign()).to.be.revertedWithCustomError(slot, "AlreadySigned");
      await slot.connect(band).sign();
      await expect(slot.connect(band).sign()).to.be.revertedWithCustomError(slot, "NotDraft");
    });

    it("cannot be signed once the parent show has ended", async function () {
      await signShow();
      await completeShow();
      await expect(slot.connect(promoter).sign()).to.be.revertedWithCustomError(slot, "ParentShowEnded");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("Funding from the parent escrow", function () {
    beforeEach(async function () {
      await signShow();
      await signSlot();
      await deposit(USDC(1_000));
    });

    it("earmarks money only after every party of the show approves the same amount", async function () {
      await expect(escrow.connect(promoter).reserveForSubordinate(slot.target, GUARANTEE))
        .to.emit(escrow, "ReservationApproved").withArgs(slot.target, GUARANTEE, promoter.address);
      expect(await escrow.reservedFor(slot.target)).to.equal(0);
      expect(await slot.fundedFromParent()).to.equal(0);

      // A different amount does not count as the same approval.
      await escrow.connect(artist).reserveForSubordinate(slot.target, USDC(400));
      expect(await escrow.reservedFor(slot.target)).to.equal(0);

      await expect(escrow.connect(artist).reserveForSubordinate(slot.target, GUARANTEE))
        .to.emit(escrow, "Reserved").withArgs(slot.target, GUARANTEE)
        .and.to.emit(slot, "FundedFromParent").withArgs(GUARANTEE)
        .and.to.emit(slot, "Activated");

      expect(await escrow.reservedFor(slot.target)).to.equal(GUARANTEE);
      expect(await escrow.totalReserved()).to.equal(GUARANTEE);
      expect(await slot.fundedFromParent()).to.equal(GUARANTEE);
      expect(await slot.status()).to.equal(SlotStatus.Active);
      // The money did not move.
      expect(await escrow.escrowBalance()).to.equal(USDC(1_000));
      expect(await escrow.distributable()).to.equal(USDC(500));
    });

    it("needs a fresh approval from both parties for each further reservation", async function () {
      const s2 = await createSlot(slotFactory, promoter,
        slotInit(promoter, band2, bundle, usdc, { termsHash: ethers.id("slot-2"), guaranteeAmount: USDC(200) }));
      await s2.connect(promoter).sign();
      await s2.connect(band2).sign();

      await reserve(s2, USDC(100));
      await escrow.connect(promoter).reserveForSubordinate(s2.target, USDC(100));   // approves a new one
      expect(await escrow.reservedFor(s2.target)).to.equal(USDC(100));              // not reserved again
      await escrow.connect(artist).reserveForSubordinate(s2.target, USDC(100));
      expect(await escrow.reservedFor(s2.target)).to.equal(USDC(200));
    });

    it("needs only the one approval for a single-party show", async function () {
      const solo = showConfig(promoter, null, t0, {
        funding: [], anchors: { termsHash: ethers.id("solo-show") },
        payoutRules: [{ to: promoter.address, kind: PayoutKind.FixedAmount, value: 1, notBefore: t0 + ONE_DAY, isGuarantee: false }],
      });
      const b = await createShow(sys.factory, promoter, solo);
      await b.show.connect(promoter).signTerms();
      await usdc.mint(promoter.address, USDC(600));
      await usdc.connect(promoter).approve(b.escrow.target, USDC(600));
      await b.escrow.connect(promoter).deposit(USDC(600));

      const s = await createSlot(slotFactory, promoter, slotInit(promoter, band, b, usdc));
      await s.connect(promoter).sign();
      await s.connect(band).sign();
      await b.escrow.connect(promoter).reserveForSubordinate(s.target, GUARANTEE);
      expect(await b.escrow.reservedFor(s.target)).to.equal(GUARANTEE);
    });

    it("rejects an outsider, an unknown slot, more than the escrow has free, or more than the guarantee", async function () {
      await expect(escrow.connect(stranger).reserveForSubordinate(slot.target, GUARANTEE))
        .to.be.revertedWithCustomError(escrow, "NotAParty");
      await expect(escrow.connect(promoter).reserveForSubordinate(slot.target, 0))
        .to.be.revertedWithCustomError(escrow, "ZeroAmount");

      // A slot that belongs to a different show's escrow is not accepted.
      const other = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
        funding: [], anchors: { termsHash: ethers.id("another-show") },
      }));
      const foreign = await createSlot(slotFactory, promoter, slotInit(promoter, band, other, usdc));
      await expect(escrow.connect(promoter).reserveForSubordinate(foreign.target, USDC(100)))
        .to.be.revertedWithCustomError(escrow, "NotASubordinate");

      // More than the free balance.
      const big = await createSlot(slotFactory, promoter,
        slotInit(promoter, band2, bundle, usdc, { termsHash: ethers.id("big"), guaranteeAmount: USDC(5_000) }));
      await big.connect(promoter).sign();
      await big.connect(band2).sign();
      await escrow.connect(promoter).reserveForSubordinate(big.target, USDC(1_500));
      await expect(escrow.connect(artist).reserveForSubordinate(big.target, USDC(1_500)))
        .to.be.revertedWithCustomError(escrow, "InsufficientFundsToReserve");

      // More than the guarantee.
      await escrow.connect(promoter).reserveForSubordinate(slot.target, USDC(600));
      await expect(escrow.connect(artist).reserveForSubordinate(slot.target, USDC(600)))
        .to.be.revertedWithCustomError(slot, "OverFunded");
    });

    it("rejects reserving for an unsigned slot or while the escrow is frozen", async function () {
      const draft = await createSlot(slotFactory, promoter,
        slotInit(promoter, band2, bundle, usdc, { termsHash: ethers.id("draft") }));
      await escrow.connect(promoter).reserveForSubordinate(draft.target, USDC(100));
      await expect(escrow.connect(artist).reserveForSubordinate(draft.target, USDC(100)))
        .to.be.revertedWithCustomError(draft, "NotSignedOrActive");

      await escrow.connect(artist).raiseDispute();
      await expect(escrow.connect(promoter).reserveForSubordinate(slot.target, USDC(100)))
        .to.be.revertedWithCustomError(escrow, "Frozen");
    });

    it("lets only the parent escrow report a reservation to the slot", async function () {
      await expect(slot.connect(promoter).onReserved(USDC(100)))
        .to.be.revertedWithCustomError(slot, "NotParentEscrow");
    });

    it("keeps earmarked money away from payouts, the sweep and late distribution", async function () {
      // 1000 in escrow, 500 earmarked: a 600 payout rule cannot be met.
      const rules = showConfig(promoter, artist, t0, {
        funding: [], anchors: { termsHash: ethers.id("rules-show") },
        payoutRules: [{ to: artist.address, kind: PayoutKind.FixedAmount, value: USDC(600), notBefore: 0, isGuarantee: true }],
      });
      const b = await createShow(sys.factory, promoter, rules);
      await b.show.connect(promoter).signTerms();
      await b.show.connect(artist).signTerms();
      await usdc.mint(promoter.address, USDC(1_000));
      await usdc.connect(promoter).approve(b.escrow.target, USDC(1_000));
      await b.escrow.connect(promoter).deposit(USDC(1_000));

      const s = await createSlot(slotFactory, promoter, slotInit(promoter, band, b, usdc));
      await s.connect(promoter).sign();
      await s.connect(band).sign();
      await b.escrow.connect(promoter).reserveForSubordinate(s.target, GUARANTEE);
      await b.escrow.connect(artist).reserveForSubordinate(s.target, GUARANTEE);

      await expect(b.escrow.connect(stranger).executeAvailablePayouts())
        .to.emit(b.escrow, "PayoutSkipped").withArgs(0, USDC(600), USDC(500));

      await time.increaseTo(cfg.dates.showEndTime);
      await b.escrow.connect(stranger).executeFinalSweep();
      expect(await usdc.balanceOf(b.escrow.target)).to.equal(GUARANTEE);   // only the earmark is left
      expect(await b.escrow.reservedFor(s.target)).to.equal(GUARANTEE);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("Funding directly", function () {
    beforeEach(async function () {
      await signShow();
    });

    it("is only open to the organizer once the slot is signed", async function () {
      await usdc.mint(promoter.address, GUARANTEE);
      await usdc.connect(promoter).approve(slot.target, GUARANTEE);
      await expect(slot.connect(promoter).fundDirect(GUARANTEE))
        .to.be.revertedWithCustomError(slot, "NotSignedOrActive");

      await signSlot();
      await expect(slot.connect(band).fundDirect(GUARANTEE)).to.be.revertedWithCustomError(slot, "NotOrganizer");
      await expect(slot.connect(promoter).fundDirect(0)).to.be.revertedWithCustomError(slot, "ZeroAmount");
      await expect(slot.connect(promoter).fundDirect(GUARANTEE + 1n)).to.be.revertedWithCustomError(slot, "OverFunded");
    });

    it("moves the organizer's money into the slot and activates it when funded", async function () {
      await signSlot();
      await fundDirect(USDC(200));
      expect(await slot.fundedDirect()).to.equal(USDC(200));
      expect(await slot.status()).to.equal(SlotStatus.Signed);
      expect(await slot.isFunded()).to.equal(false);

      await usdc.mint(promoter.address, USDC(300));
      await usdc.connect(promoter).approve(slot.target, USDC(300));
      await expect(slot.connect(promoter).fundDirect(USDC(300)))
        .to.emit(slot, "FundedDirect").withArgs(USDC(300))
        .and.to.emit(slot, "Activated");
      expect(await usdc.balanceOf(slot.target)).to.equal(GUARANTEE);
      expect(await slot.totalFunded()).to.equal(GUARANTEE);
      expect(await slot.status()).to.equal(SlotStatus.Active);
    });

    it("can be funded partly from each source", async function () {
      await signSlot();
      await deposit(USDC(1_000));
      await reserve(slot, USDC(300));
      expect(await slot.status()).to.equal(SlotStatus.Signed);
      await fundDirect(USDC(200));
      expect(await slot.status()).to.equal(SlotStatus.Active);
      expect(await slot.fundedFromParent()).to.equal(USDC(300));
      expect(await slot.fundedDirect()).to.equal(USDC(200));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("Payout", function () {
    beforeEach(async function () {
      await signShow();
      await signSlot();
      await deposit(USDC(1_000));
      await reserve(slot, USDC(300));
      await fundDirect(USDC(200));
    });

    it("pays the band when the show completes, from the earmark and the direct money", async function () {
      await expect(slot.connect(stranger).executePayout()).to.be.revertedWithCustomError(slot, "NotYetPayable");

      await completeShow();
      await expect(slot.connect(stranger).executePayout())
        .to.emit(slot, "PayoutExecuted").withArgs(GUARANTEE)
        .and.to.emit(escrow, "SubordinateSettled").withArgs(slot.target, band.address, USDC(300));

      expect(await usdc.balanceOf(band.address)).to.equal(GUARANTEE);
      expect(await usdc.balanceOf(slot.target)).to.equal(0);
      expect(await escrow.reservedFor(slot.target)).to.equal(0);
      expect(await escrow.totalReserved()).to.equal(0);
      expect(await slot.status()).to.equal(SlotStatus.Completed);
      expect(await slot.fundedFromParent()).to.equal(0);

      await expect(slot.connect(stranger).executePayout()).to.be.revertedWithCustomError(slot, "NotActive");
    });

    it("does not pay a slot that is not fully funded", async function () {
      const s2 = await createSlot(slotFactory, promoter,
        slotInit(promoter, band2, bundle, usdc, { termsHash: ethers.id("unfunded") }));
      await s2.connect(promoter).sign();
      await s2.connect(band2).sign();
      await completeShow();
      await expect(s2.connect(stranger).executePayout()).to.be.revertedWithCustomError(s2, "NotActive");
    });

    it("pays whoever the ruling says it is owed, without waiting for the show", async function () {
      await slot.connect(band).raiseDispute();
      await expect(slot.connect(stranger).executePayout()).to.be.revertedWithCustomError(slot, "NotActive");
      await slot.connect(band).resolveDispute(Ruling.NoBreach);
      await slot.connect(promoter).resolveDispute(Ruling.NoBreach);
      expect(await slot.ruling()).to.equal(Ruling.NoBreach);

      await slot.connect(stranger).executePayout();
      expect(await usdc.balanceOf(band.address)).to.equal(GUARANTEE);
    });

    it("still pays the band when the organizer was the one in breach", async function () {
      await slot.connect(promoter).raiseDispute();
      await slot.connect(promoter).resolveDispute(Ruling.BreachByOrganizer);
      await expect(slot.connect(band).resolveDispute(Ruling.BreachByOrganizer))
        .to.emit(slot, "DisputeResolved").withArgs(anyValue, true, promoter.address);
      await slot.connect(stranger).executePayout();
      expect(await usdc.balanceOf(band.address)).to.equal(GUARANTEE);
    });

    it("is not held up by a dispute on the parent show", async function () {
      await escrow.connect(artist).raiseDispute();
      expect(await show.isFrozen()).to.equal(true);

      await slot.connect(promoter).raiseDispute();
      await slot.connect(promoter).resolveDispute(Ruling.NoBreach);
      await slot.connect(band).resolveDispute(Ruling.NoBreach);
      await slot.connect(stranger).executePayout();
      expect(await usdc.balanceOf(band.address)).to.equal(GUARANTEE);
    });

    it("does not pay a slot whose show was cancelled", async function () {
      await slot.connect(promoter).raiseDispute();
      await slot.connect(promoter).resolveDispute(Ruling.NoBreach);
      await slot.connect(band).resolveDispute(Ruling.NoBreach);
      await escrow.connect(promoter).cancel();
      await expect(slot.connect(stranger).executePayout()).to.be.revertedWithCustomError(slot, "ParentShowCancelled");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("Dispute", function () {
    beforeEach(async function () {
      await signShow();
      await signSlot();
      await deposit(USDC(1_000));
      await reserve(slot, USDC(300));
      await fundDirect(USDC(200));
    });

    it("freezes the slot and stays open while the parties disagree", async function () {
      await expect(slot.connect(stranger).raiseDispute()).to.be.revertedWithCustomError(slot, "NotAParty");
      await expect(slot.connect(promoter).resolveDispute(Ruling.NoBreach))
        .to.be.revertedWithCustomError(slot, "NotInDispute");

      await expect(slot.connect(band).raiseDispute()).to.emit(slot, "DisputeOpened");
      expect(await slot.status()).to.equal(SlotStatus.InDispute);
      await expect(slot.connect(promoter).raiseDispute()).to.be.revertedWithCustomError(slot, "NotSignedOrActive");

      await expect(slot.connect(promoter).resolveDispute(Ruling.None))
        .to.be.revertedWithCustomError(slot, "InvalidRuling");
      await slot.connect(promoter).resolveDispute(Ruling.BreachBySupport);
      await slot.connect(band).resolveDispute(Ruling.NoBreach);
      expect(await slot.status()).to.equal(SlotStatus.InDispute);

      await slot.connect(band).resolveDispute(Ruling.BreachBySupport);   // a vote can change
      expect(await slot.status()).to.equal(SlotStatus.Cancelled);
    });

    it("returns the money when the band was in breach: earmark to the escrow, direct to the organizer", async function () {
      const before = await usdc.balanceOf(promoter.address);
      await slot.connect(promoter).raiseDispute();
      await slot.connect(promoter).resolveDispute(Ruling.BreachBySupport);
      await expect(slot.connect(band).resolveDispute(Ruling.BreachBySupport))
        .to.emit(slot, "DisputeResolved").withArgs(anyValue, true, band.address)
        .and.to.emit(escrow, "ReservationReleased").withArgs(slot.target, USDC(300))
        .and.to.emit(slot, "Cancelled");

      expect(await escrow.reservedFor(slot.target)).to.equal(0);
      expect(await escrow.distributable()).to.equal(USDC(1_000));
      expect((await usdc.balanceOf(promoter.address)) - before).to.equal(USDC(200));
      expect(await usdc.balanceOf(band.address)).to.equal(0);
      expect(await slot.status()).to.equal(SlotStatus.Cancelled);
    });

    it("returns to where it was after a ruling that pays the band", async function () {
      await slot.connect(promoter).raiseDispute();
      await slot.connect(promoter).resolveDispute(Ruling.NoBreach);
      await slot.connect(band).resolveDispute(Ruling.NoBreach);
      expect(await slot.status()).to.equal(SlotStatus.Active);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("Cancellation", function () {
    it("lets either party walk away before the slot is signed", async function () {
      await expect(slot.connect(stranger).cancel()).to.be.revertedWithCustomError(slot, "NotAParty");
      await expect(slot.connect(band).cancel()).to.emit(slot, "Cancelled");
      expect(await slot.status()).to.equal(SlotStatus.Cancelled);
      await expect(slot.connect(promoter).cancel()).to.be.revertedWithCustomError(slot, "NotDraft");
    });

    describe("once signed and funded", function () {
      beforeEach(async function () {
        await signShow();
        await signSlot();
        await deposit(USDC(1_000));
        await reserve(slot, USDC(300));
        await fundDirect(USDC(200));
      });

      it("needs both parties to agree, and sends the funding back", async function () {
        await expect(slot.connect(stranger).agreeToCancel()).to.be.revertedWithCustomError(slot, "NotAParty");
        await slot.connect(band).agreeToCancel();
        expect(await slot.status()).to.equal(SlotStatus.Active);
        await expect(slot.connect(band).agreeToCancel()).to.be.revertedWithCustomError(slot, "AlreadyAgreedToCancel");

        const before = await usdc.balanceOf(promoter.address);
        await expect(slot.connect(promoter).agreeToCancel()).to.emit(slot, "Cancelled");
        expect(await slot.status()).to.equal(SlotStatus.Cancelled);
        expect(await escrow.distributable()).to.equal(USDC(1_000));
        expect((await usdc.balanceOf(promoter.address)) - before).to.equal(USDC(200));
      });

      it("is cancelled by anyone when the parent show is cancelled, after buyers are refunded first", async function () {
        await expect(slot.connect(stranger).cancelIfParentEnded())
          .to.be.revertedWithCustomError(slot, "ParentShowNotEnded");

        await usdc.mint(fan.address, USDC(50));
        await usdc.connect(fan).approve(bundle.ticket.target, USDC(50));
        await bundle.ticket.connect(fan).buyTicket(0);

        await escrow.connect(promoter).cancel();
        // Earmarks are void once the show is cancelled, so the money is not stuck behind the slot.
        expect(await escrow.reservationsVoid()).to.equal(true);
        // 1000 deposited + 49 from the ticket, minus the 1 held for XAO.
        expect(await escrow.distributable()).to.equal(USDC(1_048));
        await expect(escrow.connect(promoter).reserveForSubordinate(slot.target, 1))
          .to.be.revertedWithCustomError(escrow, "NotActive");

        const before = await usdc.balanceOf(promoter.address);
        await slot.connect(stranger).cancelIfParentEnded();
        expect(await slot.status()).to.equal(SlotStatus.Cancelled);
        expect((await usdc.balanceOf(promoter.address)) - before).to.equal(USDC(200));

        // The ticket buyer is refunded first, then the rest is split by the cancel rule.
        await escrow.connect(stranger).continueRefunds(10);
        expect(await usdc.balanceOf(fan.address)).to.equal(USDC(49));
        await escrow.connect(stranger).finalizeCancellationPayout();
        expect(await usdc.balanceOf(escrow.target)).to.equal(0);
      });

      it("is cancelled when the parent show expired, releasing its earmark", async function () {
        await time.increaseTo(cfg.dates.showEndTime + 1);
        await show.connect(stranger).markExpired();
        await slot.connect(stranger).cancelIfParentEnded();
        expect(await slot.status()).to.equal(SlotStatus.Cancelled);
        expect(await escrow.reservedFor(slot.target)).to.equal(0);
        expect(await escrow.distributable()).to.equal(USDC(1_000));
      });

      it("cannot be cancelled again once it is paid out", async function () {
        await completeShow();
        await slot.connect(stranger).executePayout();
        await expect(slot.connect(stranger).cancelIfParentEnded())
          .to.be.revertedWithCustomError(slot, "NotSignedOrActive");
        await expect(slot.connect(promoter).agreeToCancel())
          .to.be.revertedWithCustomError(slot, "NotSignedOrActive");
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("Escrow protections", function () {
    beforeEach(async function () {
      await signShow();
      await deposit(USDC(1_000));
    });

    it("does not let a contract that only claims to be a subordinate take earmarked money", async function () {
      const fake = await (await ethers.getContractFactory("MockSubordinate")).deploy(show.target, escrow.target);
      await fake.waitForDeployment();

      // One show party approving it is not enough to earmark anything.
      await escrow.connect(promoter).reserveForSubordinate(fake.target, USDC(900));
      expect(await escrow.reservedFor(fake.target)).to.equal(0);
      await expect(fake.drain(promoter.address, USDC(900)))
        .to.be.revertedWithCustomError(escrow, "InsufficientReservation");
      expect(await escrow.escrowBalance()).to.equal(USDC(1_000));
    });

    it("lets a party take back its approval before the other party completes the reservation", async function () {
      await signSlot();
      await escrow.connect(promoter).reserveForSubordinate(slot.target, GUARANTEE);
      await expect(escrow.connect(promoter).revokeReservationApproval(slot.target, GUARANTEE))
        .to.emit(escrow, "ReservationApprovalRevoked").withArgs(slot.target, GUARANTEE, promoter.address);
      await expect(escrow.connect(stranger).revokeReservationApproval(slot.target, GUARANTEE))
        .to.be.revertedWithCustomError(escrow, "NotAParty");

      // The artist's approval alone no longer completes it.
      await escrow.connect(artist).reserveForSubordinate(slot.target, GUARANTEE);
      expect(await escrow.reservedFor(slot.target)).to.equal(0);
      await escrow.connect(promoter).reserveForSubordinate(slot.target, GUARANTEE);
      expect(await escrow.reservedFor(slot.target)).to.equal(GUARANTEE);
    });

    it("only releases or settles what was earmarked for the caller", async function () {
      await expect(escrow.connect(stranger).settleSubordinate(stranger.address, 1))
        .to.be.revertedWithCustomError(escrow, "InsufficientReservation");
      await expect(escrow.connect(stranger).settleSubordinate(ZERO_ADDRESS, 1))
        .to.be.revertedWithCustomError(escrow, "ZeroRecipient");
      await expect(escrow.connect(stranger).releaseReservation(1))
        .to.be.revertedWithCustomError(escrow, "InsufficientReservation");
    });

    it("voids earmarks when the show is cancelled, so settling is refused", async function () {
      await signSlot();
      await reserve(slot, USDC(300));
      await escrow.connect(promoter).cancel();
      await expect(escrow.connect(stranger).settleSubordinate(stranger.address, 1))
        .to.be.revertedWithCustomError(escrow, "ReservationsVoid");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("Payments the token refuses", function () {
    it("holds a blocked band's payout for it to claim, from both the slot and the escrow", async function () {
      const bsys = await deploySystem("MockBlockableERC20");
      const bcfg = showConfig(promoter, artist, t0, { funding: [] });
      const b = await createShow(bsys.factory, promoter, bcfg);
      await b.show.connect(promoter).signTerms();
      await b.show.connect(artist).signTerms();
      const token = bsys.usdc;

      const s = await createSlot(slotFactory, promoter, slotInit(promoter, band, b, token));
      await s.connect(promoter).sign();
      await s.connect(band).sign();

      await token.mint(promoter.address, USDC(1_000));
      await token.connect(promoter).approve(b.escrow.target, USDC(1_000));
      await b.escrow.connect(promoter).deposit(USDC(1_000));
      await b.escrow.connect(promoter).reserveForSubordinate(s.target, USDC(300));
      await b.escrow.connect(artist).reserveForSubordinate(s.target, USDC(300));
      await token.mint(promoter.address, USDC(200));
      await token.connect(promoter).approve(s.target, USDC(200));
      await s.connect(promoter).fundDirect(USDC(200));

      await token.setBlocked(band.address, true);
      await time.increaseTo(bcfg.dates.showEndTime);
      await b.escrow.connect(stranger).executeFinalSweep();
      await expect(s.connect(stranger).executePayout())
        .to.emit(s, "PaymentHeld").withArgs(band.address, USDC(200))
        .and.to.emit(b.escrow, "PaymentHeld").withArgs(band.address, USDC(300));
      expect(await token.balanceOf(band.address)).to.equal(0);

      await expect(s.connect(band).claim()).to.be.revertedWithCustomError(s, "TransferFailed");
      await token.setBlocked(band.address, false);
      await s.connect(band).claim();
      await b.escrow.connect(band).claim();
      expect(await token.balanceOf(band.address)).to.equal(GUARANTEE);
      await expect(s.connect(band).claim()).to.be.revertedWithCustomError(s, "NothingToClaim");
    });
  });
});
