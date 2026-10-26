// test/Openers.test.js
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time }   = require("@nomicfoundation/hardhat-network-helpers");
const {
  USDC, ONE_DAY, MAX_UINT64, ShowStatus, EscrowStatus, PayoutKind, EdgeStatus,
  TICKET_PRICE, tier, edgeIdOf, deploySystem, showConfig, createShow,
} = require("./helpers/show");

const CHILD_OF = 1;
const PARENTS  = 2;
const CancelReason = { Manual: 0, MissedFunding: 1, ParentEnded: 2 };

const NET    = USDC(48);    // what one ticket adds to the escrow's free money
const GUAR_H = USDC(500);   // the headliner's guarantee
const GUAR_1 = USDC(200);   // first opener
const GUAR_2 = USDC(100);   // second opener

describe("Openers", function () {
  let sys, usdc;
  let owner, promoter, artist, treasury, band, band2, fan, stranger;
  let t0, showEnd, main, op1, op2;

  function mainConfig(name = "main-show") {
    return showConfig(promoter, artist, t0, {
      anchors: { termsHash: ethers.id(name) },
      tiers: [tier({ quantity: 100 })],
      funding: [],
      payoutRules: [{ to: artist.address, kind: PayoutKind.FixedAmount, value: GUAR_H, notBefore: showEnd, isGuarantee: true }],
      sweep: { recipients: [promoter.address], bps: [10_000], notBefore: showEnd },
      cancelRules: [{ notAfter: MAX_UINT64, payBpsToPartyA: 10_000, payBpsToPartyB: 0, treasuryBps: 0 }],
    });
  }

  // An opener is the same kind of agreement as the headliner's, without tickets.
  function openerConfig(organizer, act, name, guarantee, overrides = {}) {
    return showConfig(organizer, act, t0, {
      tickets: { ticketsEnabled: false },
      anchors: { termsHash: ethers.id(name) },
      funding: [{ byTime: t0 + 25 * ONE_DAY, minFunded: guarantee }],
      payoutRules: [{ to: act.address, kind: PayoutKind.FixedAmount, value: guarantee, notBefore: showEnd, isGuarantee: true }],
      sweep: { recipients: [organizer.address], bps: [10_000], notBefore: showEnd },
      cancelRules: [{ notAfter: MAX_UINT64, payBpsToPartyA: 10_000, payBpsToPartyB: 0, treasuryBps: 0 }],
      ...overrides,
    });
  }

  async function signBoth(b, a, c) {
    await b.show.connect(a).signTerms();
    await b.show.connect(c).signTerms();
  }

  async function newOpener(name, act, guarantee, overrides = {}, sign = true) {
    const b = await createShow(sys.factory, promoter, openerConfig(promoter, act, name, guarantee, overrides));
    if (sign) await signBoth(b, promoter, act);
    return b;
  }

  async function buy(n) {
    for (let i = 0; i < n; i++) {
      await usdc.mint(fan.address, TICKET_PRICE);
      await usdc.connect(fan).approve(main.ticket.target, TICKET_PRICE);
      await main.ticket.connect(fan).buyTicket(0);
    }
  }

  async function deposit(b, signer, amount) {
    await usdc.mint(signer.address, amount);
    await usdc.connect(signer).approve(b.escrow.target, amount);
    await b.escrow.connect(signer).deposit(amount);
  }

  beforeEach(async function () {
    [owner, promoter, artist, treasury, band, band2, fan, stranger] = await ethers.getSigners();
    sys = await deploySystem();
    usdc = sys.usdc;

    t0 = await time.latest();
    showEnd = t0 + 30 * ONE_DAY + 7_200;
    main = await createShow(sys.factory, promoter, mainConfig());
    await signBoth(main, promoter, artist);
    op1 = await newOpener("opener-1", band, GUAR_1);
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("Linking an opener", function () {
    it("lets only the organizer link, and attaches the two escrows to each other", async function () {
      await expect(main.escrow.connect(artist).linkAgreement(op1.escrow.target))
        .to.be.revertedWithCustomError(main.escrow, "NotOrganizer");
      await expect(main.escrow.connect(stranger).linkAgreement(op1.escrow.target))
        .to.be.revertedWithCustomError(main.escrow, "NotOrganizer");

      await expect(main.escrow.connect(promoter).linkAgreement(op1.escrow.target))
        .to.emit(main.escrow, "AgreementLinked").withArgs(op1.escrow.target)
        .and.to.emit(op1.escrow, "AttachedToParent").withArgs(main.escrow.target);

      expect(await main.escrow.getLinkedAgreements()).to.deep.equal([op1.escrow.target]);
      expect(await op1.escrow.parentEscrow()).to.equal(main.escrow.target);
    });

    it("accepts only a real escrow from the same factory with the same organizer", async function () {
      await expect(main.escrow.connect(promoter).linkAgreement(stranger.address))
        .to.be.revertedWithCustomError(main.escrow, "NotAnAgreementEscrow");

      // An escrow from another factory is not accepted.
      const other = await deploySystem();
      const foreign = await createShow(other.factory, promoter, openerConfig(promoter, band2, "foreign", GUAR_2));
      await expect(main.escrow.connect(promoter).linkAgreement(foreign.escrow.target))
        .to.be.revertedWithCustomError(main.escrow, "NotAnAgreementEscrow");

      // Someone else's agreement, with a different organizer, is not accepted.
      const theirs = await createShow(sys.factory, artist, openerConfig(artist, band2, "theirs", GUAR_2));
      await expect(main.escrow.connect(promoter).linkAgreement(theirs.escrow.target))
        .to.be.revertedWithCustomError(main.escrow, "AgreementMismatch");
    });

    it("rejects linking itself or the same agreement twice", async function () {
      await expect(main.escrow.connect(promoter).linkAgreement(main.escrow.target))
        .to.be.revertedWithCustomError(main.escrow, "AlreadyLinked");
      await main.escrow.connect(promoter).linkAgreement(op1.escrow.target);
      await expect(main.escrow.connect(promoter).linkAgreement(op1.escrow.target))
        .to.be.revertedWithCustomError(main.escrow, "AlreadyLinked");
    });

    it("keeps the structure flat: one parent, no openers of an opener, and a parent cannot become a child", async function () {
      await main.escrow.connect(promoter).linkAgreement(op1.escrow.target);

      const main2 = await createShow(sys.factory, promoter, mainConfig("second-main"));
      await expect(main2.escrow.connect(promoter).linkAgreement(op1.escrow.target))
        .to.be.revertedWithCustomError(op1.escrow, "ParentAlreadySet");
      await expect(main2.escrow.connect(promoter).linkAgreement(main.escrow.target))
        .to.be.revertedWithCustomError(main.escrow, "HasLinkedAgreements");

      const spare = await newOpener("spare", band2, GUAR_2);
      await expect(op1.escrow.connect(promoter).linkAgreement(spare.escrow.target))
        .to.be.revertedWithCustomError(op1.escrow, "HasParent");
    });

    it("limits how many openers one show can have", async function () {
      expect(await main.escrow.MAX_LINKED()).to.equal(20);
      for (let i = 0; i < 20; i++) {
        const o = await newOpener("many-" + i, band2, GUAR_2, {}, false);
        await main.escrow.connect(promoter).linkAgreement(o.escrow.target);
      }
      const extra = await newOpener("one-too-many", band2, GUAR_2, {}, false);
      await expect(main.escrow.connect(promoter).linkAgreement(extra.escrow.target))
        .to.be.revertedWithCustomError(main.escrow, "TooManyLinked");
    });

    it("only works while the show escrow is open and not frozen", async function () {
      await main.escrow.connect(artist).raiseDispute();
      await expect(main.escrow.connect(promoter).linkAgreement(op1.escrow.target))
        .to.be.revertedWithCustomError(main.escrow, "Frozen");
    });

    it("does not work once the show is cancelled", async function () {
      await main.escrow.connect(promoter).cancel();
      await expect(main.escrow.connect(promoter).linkAgreement(op1.escrow.target))
        .to.be.revertedWithCustomError(main.escrow, "NotActive");
    });

    it("lets the venue register the parent and child links in the graph, live at once", async function () {
      await sys.registry.connect(promoter).registerEdges([
        { from: main.show.target, to: op1.show.target, edgeType: PARENTS, metaHash: ethers.ZeroHash, metaCID: "" },
        { from: op1.show.target, to: main.show.target, edgeType: CHILD_OF, metaHash: ethers.ZeroHash, metaCID: "" },
      ]);
      expect(await sys.registry.edgeStatus(edgeIdOf(main.show.target, op1.show.target, PARENTS)))
        .to.equal(EdgeStatus.Active);
      expect(await sys.registry.edgeStatus(edgeIdOf(op1.show.target, main.show.target, CHILD_OF)))
        .to.equal(EdgeStatus.Active);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("Ticket money pays the guarantees", function () {
    beforeEach(async function () {
      await main.escrow.connect(promoter).linkAgreement(op1.escrow.target);
    });

    it("covers the headliner's own guarantee before any opener gets anything", async function () {
      await buy(10);                                   // 480, less than the 500 the headliner is owed
      await main.escrow.connect(stranger).allocate();
      expect(await main.escrow.earmarkOf(op1.escrow.target)).to.equal(0);

      await buy(5);                                    // 720
      await expect(main.escrow.connect(stranger).allocate())
        .to.emit(main.escrow, "Earmarked").withArgs(op1.escrow.target, GUAR_1);
      expect(await main.escrow.earmarkOf(op1.escrow.target)).to.equal(GUAR_1);
      expect(await main.escrow.totalEarmarked()).to.equal(GUAR_1);
      expect(await main.escrow.distributable()).to.equal(USDC(720) - GUAR_1);
      // The money has not moved, it is only set aside.
      expect(await usdc.balanceOf(main.escrow.target)).to.equal(USDC(15 * 49));
      expect(await usdc.balanceOf(op1.escrow.target)).to.equal(0);
    });

    it("fills the openers in the order they were added", async function () {
      op2 = await newOpener("opener-2", band2, GUAR_2);
      await main.escrow.connect(promoter).linkAgreement(op2.escrow.target);
      expect(await main.escrow.getLinkedAgreements()).to.deep.equal([op1.escrow.target, op2.escrow.target]);

      await buy(15);                                   // 720: 220 over the headliner's 500
      await main.escrow.allocate();
      expect(await main.escrow.earmarkOf(op1.escrow.target)).to.equal(GUAR_1);
      expect(await main.escrow.earmarkOf(op2.escrow.target)).to.equal(USDC(20));

      await buy(2);
      await main.escrow.allocate();
      expect(await main.escrow.earmarkOf(op1.escrow.target)).to.equal(GUAR_1);
      expect(await main.escrow.earmarkOf(op2.escrow.target)).to.equal(GUAR_2);
      // 816 free, 300 set aside for the openers. What is left is the headliner's 500, still unpaid, plus 16.
      expect(await main.escrow.distributable()).to.equal(USDC(17 * 48) - GUAR_1 - GUAR_2);
      expect(await main.escrow.distributable()).to.equal(GUAR_H + USDC(16));
    });

    it("never takes money the headliner is still owed", async function () {
      await buy(12);                                   // 576
      await main.escrow.allocate();
      expect(await main.escrow.earmarkOf(op1.escrow.target)).to.equal(USDC(76));
      expect(await main.escrow.distributable()).to.equal(GUAR_H);   // exactly what the headliner is owed
    });

    it("reaches the openers sooner when the venue has paid in the headliner's guarantee", async function () {
      op2 = await newOpener("opener-2", band2, GUAR_2);
      await main.escrow.connect(promoter).linkAgreement(op2.escrow.target);
      await deposit(main, promoter, GUAR_H);
      await buy(5);                                    // 240 on top of the deposit

      await main.escrow.allocate();
      expect(await main.escrow.earmarkOf(op1.escrow.target)).to.equal(GUAR_1);
      expect(await main.escrow.earmarkOf(op2.escrow.target)).to.equal(USDC(40));
    });

    it("counts what the opener's own parties have paid in toward its guarantee", async function () {
      await deposit(op1, promoter, USDC(130));
      await deposit(op1, band, USDC(20));
      expect(await op1.escrow.fundingNeed()).to.equal(USDC(50));
      expect(await op1.escrow.requiredFunding()).to.equal(GUAR_1);

      await buy(12);
      await main.escrow.allocate();
      expect(await main.escrow.earmarkOf(op1.escrow.target)).to.equal(USDC(50));
    });

    it("earmarks nothing for an opener that is fully funded, and anyone may ask", async function () {
      await deposit(op1, promoter, GUAR_1);
      expect(await op1.escrow.fundingNeed()).to.equal(0);
      await buy(17);
      await main.escrow.connect(stranger).allocate();
      expect(await main.escrow.earmarkOf(op1.escrow.target)).to.equal(0);
    });

    it("does nothing while the show escrow is frozen, and carries on once it is not", async function () {
      await buy(17);
      await main.escrow.connect(artist).raiseDispute();
      await main.escrow.allocate();
      expect(await main.escrow.earmarkOf(op1.escrow.target)).to.equal(0);

      await time.increase(30 * ONE_DAY);
      await main.escrow.finalizeDisputeTimeout();
      await main.escrow.allocate();
      expect(await main.escrow.earmarkOf(op1.escrow.target)).to.equal(GUAR_1);
    });

    it("lets the venue add an opener late, after tickets are sold, without touching the headliner", async function () {
      op2 = await newOpener("late-opener", band2, GUAR_2);
      await buy(17);
      await main.escrow.connect(promoter).linkAgreement(op2.escrow.target);
      await main.escrow.allocate();
      expect(await main.escrow.earmarkOf(op1.escrow.target)).to.equal(GUAR_1);
      expect(await main.escrow.earmarkOf(op2.escrow.target)).to.equal(GUAR_2);
      // 816 free, 300 set aside for the openers. What is left is the headliner's 500, still unpaid, plus 16.
      expect(await main.escrow.distributable()).to.equal(USDC(17 * 48) - GUAR_1 - GUAR_2);
      expect(await main.escrow.distributable()).to.equal(GUAR_H + USDC(16));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("An opener collects its guarantee and is paid", function () {
    beforeEach(async function () {
      await main.escrow.connect(promoter).linkAgreement(op1.escrow.target);
    });

    it("pays everyone from the ticket money and leaves the venue what is left", async function () {
      await buy(17);                                   // 850 paid, 816 free, 17 held for Xao
      await main.escrow.allocate();
      expect(await usdc.balanceOf(op1.escrow.target)).to.equal(0);

      await time.increaseTo(showEnd);

      await expect(op1.escrow.connect(stranger).executeAvailablePayouts())
        .to.emit(op1.escrow, "FundedFromParent").withArgs(GUAR_1)
        .and.to.emit(main.escrow, "EarmarkSettled").withArgs(op1.escrow.target, GUAR_1)
        .and.to.emit(op1.escrow, "PayoutExecuted").withArgs(0, band.address, GUAR_1);
      expect(await usdc.balanceOf(band.address)).to.equal(GUAR_1);
      expect(await op1.escrow.totalFunded()).to.equal(GUAR_1);

      await main.escrow.connect(stranger).executeAvailablePayouts();
      expect(await usdc.balanceOf(artist.address)).to.equal(GUAR_H);

      await main.escrow.connect(stranger).executeFinalSweep();
      await op1.escrow.connect(stranger).executeFinalSweep();

      expect(await usdc.balanceOf(treasury.address)).to.equal(USDC(34));      // $1 gas + 2% on 17 tickets
      expect(await usdc.balanceOf(promoter.address)).to.equal(USDC(116));     // 816 - 500 - 200
      expect(await usdc.balanceOf(main.escrow.target)).to.equal(0);
      expect(await usdc.balanceOf(op1.escrow.target)).to.equal(0);
      expect(await main.show.status()).to.equal(ShowStatus.Completed);
      expect(await op1.show.status()).to.equal(ShowStatus.Completed);
      // Every dollar is accounted for: 850 paid by fans.
      expect(
        (await usdc.balanceOf(treasury.address)) + (await usdc.balanceOf(promoter.address)) +
        (await usdc.balanceOf(artist.address)) + (await usdc.balanceOf(band.address))
      ).to.equal(USDC(850));
    });

    it("keeps the opener's money for it even if the final sweep runs first", async function () {
      await buy(17);
      await time.increaseTo(showEnd);

      await main.escrow.connect(stranger).executeFinalSweep();     // nobody paid out first
      expect(await usdc.balanceOf(artist.address)).to.equal(GUAR_H);
      expect(await usdc.balanceOf(promoter.address)).to.equal(USDC(116));

      await op1.escrow.connect(stranger).executeAvailablePayouts();   // still collects from a completed show
      expect(await usdc.balanceOf(band.address)).to.equal(GUAR_1);
    });

    it("collects early with pullFromParent, but pays the band only at its payout time", async function () {
      await buy(17);
      await main.escrow.allocate();

      await expect(op1.escrow.connect(stranger).pullFromParent())
        .to.emit(op1.escrow, "FundedFromParent").withArgs(GUAR_1);
      expect(await usdc.balanceOf(op1.escrow.target)).to.equal(GUAR_1);
      expect(await main.escrow.earmarkOf(op1.escrow.target)).to.equal(0);

      await op1.escrow.executeAvailablePayouts();
      expect(await usdc.balanceOf(band.address)).to.equal(0);          // not due yet

      await time.increaseTo(showEnd);
      await op1.escrow.executeAvailablePayouts();
      expect(await usdc.balanceOf(band.address)).to.equal(GUAR_1);

      // A second pull finds nothing more to collect.
      await op1.escrow.pullFromParent();
      expect(await op1.escrow.totalFunded()).to.equal(GUAR_1);
    });

    it("is met by the venue paying in what the tickets did not cover", async function () {
      await buy(12);                                   // only 76 over the headliner's guarantee
      await main.escrow.allocate();
      expect(await op1.escrow.fundingNeed()).to.equal(USDC(124));   // 200 less the 76 earmarked

      await deposit(op1, promoter, USDC(124));
      expect(await op1.escrow.fundingNeed()).to.equal(0);

      await time.increaseTo(showEnd);
      await op1.escrow.executeAvailablePayouts();
      expect(await usdc.balanceOf(band.address)).to.equal(GUAR_1);
      expect(await main.escrow.earmarkOf(op1.escrow.target)).to.equal(0);
    });

    it("is not held up by a dispute on the main show", async function () {
      await buy(17);
      await main.escrow.allocate();
      await main.escrow.connect(artist).raiseDispute();
      expect(await main.show.isFrozen()).to.equal(true);

      await op1.escrow.connect(stranger).pullFromParent();
      expect(await usdc.balanceOf(op1.escrow.target)).to.equal(GUAR_1);
    });

    it("lets only a linked agreement collect or give back what is earmarked", async function () {
      await expect(main.escrow.connect(stranger).settleLinked(1))
        .to.be.revertedWithCustomError(main.escrow, "InsufficientEarmark");
      await main.escrow.connect(stranger).releaseEarmark();      // nothing to give back, no effect
      expect(await main.escrow.totalEarmarked()).to.equal(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("Funding deadlines and cancellation", function () {
    beforeEach(async function () {
      await main.escrow.connect(promoter).linkAgreement(op1.escrow.target);
    });

    it("cancels an opener nobody funded by its deadline, and the main show carries on", async function () {
      await time.increaseTo(t0 + 26 * ONE_DAY);
      await expect(op1.escrow.connect(stranger).cancelForMissedFunding(0))
        .to.emit(op1.escrow, "RefundingStarted").withArgs(CancelReason.MissedFunding, 10_000, 0);

      expect(await op1.show.status()).to.equal(ShowStatus.Cancelled);
      expect(await main.show.status()).to.equal(ShowStatus.Signed);
      expect(await main.escrow.status()).to.equal(EscrowStatus.Active);
      await op1.escrow.finalizeCancellationPayout();
      expect(await op1.escrow.status()).to.equal(EscrowStatus.Completed);
    });

    it("counts ticket money earmarked for the opener as funded", async function () {
      await buy(17);                                   // nobody has asked for the allocation yet
      await time.increaseTo(t0 + 26 * ONE_DAY);
      await expect(op1.escrow.connect(stranger).cancelForMissedFunding(0))
        .to.be.revertedWithCustomError(op1.escrow, "MilestoneNotMissed");
    });

    it("counts the venue's own top-up toward the deadline", async function () {
      await deposit(op1, promoter, GUAR_1);
      await time.increaseTo(t0 + 26 * ONE_DAY);
      await expect(op1.escrow.connect(stranger).cancelForMissedFunding(0))
        .to.be.revertedWithCustomError(op1.escrow, "MilestoneNotMissed");
    });

    it("does not count money the main show set aside for its openers as its own", async function () {
      // A main show with a funding deadline of its own: 550 must be its own by day 20.
      const withDeadline = mainConfig("main-with-deadline");
      withDeadline.funding = [{ byTime: t0 + 20 * ONE_DAY, minFunded: USDC(550) }];
      const m = await createShow(sys.factory, promoter, withDeadline);
      await signBoth(m, promoter, artist);

      const o = await newOpener("deadline-opener", band2, GUAR_2);
      await m.escrow.connect(promoter).linkAgreement(o.escrow.target);
      await usdc.mint(promoter.address, GUAR_H + GUAR_2);
      await usdc.connect(promoter).approve(m.escrow.target, GUAR_H + GUAR_2);
      await m.escrow.connect(promoter).deposit(GUAR_H + GUAR_2);   // 600 paid in
      await m.escrow.allocate();                                   // 100 of it earmarked for the opener
      expect(await m.escrow.earmarkOf(o.escrow.target)).to.equal(GUAR_2);

      // 600 was paid in, which is over 550, but 100 of it is set aside for the opener.
      // Only 500 is the main show's own, so the deadline is missed.
      await time.increaseTo(t0 + 21 * ONE_DAY);
      await expect(m.escrow.connect(stranger).cancelForMissedFunding(0))
        .to.emit(m.escrow, "RefundingStarted");
    });

    it("hands back what was earmarked when an opener is cancelled", async function () {
      await buy(17);
      await main.escrow.allocate();
      expect(await main.escrow.earmarkOf(op1.escrow.target)).to.equal(GUAR_1);

      await expect(op1.escrow.connect(band).cancel())
        .to.emit(main.escrow, "EarmarkReleased").withArgs(op1.escrow.target, GUAR_1);
      expect(await main.escrow.earmarkOf(op1.escrow.target)).to.equal(0);
      expect(await main.escrow.totalEarmarked()).to.equal(0);

      await time.increaseTo(showEnd);
      await main.escrow.connect(stranger).executeFinalSweep();
      expect(await usdc.balanceOf(artist.address)).to.equal(GUAR_H);
      expect(await usdc.balanceOf(promoter.address)).to.equal(USDC(816) - GUAR_H);   // the venue gets it back
    });

    it("cancels the openers when the main show is cancelled, after ticket buyers are refunded", async function () {
      await buy(17);
      await main.escrow.allocate();

      await expect(op1.escrow.connect(stranger).cancelIfParentEnded())
        .to.be.revertedWithCustomError(op1.escrow, "ParentNotEnded");
      await expect(main.escrow.connect(stranger).cancelIfParentEnded())
        .to.be.revertedWithCustomError(main.escrow, "NoParent");

      await main.escrow.connect(promoter).cancel();
      // The opener's earmark no longer stands in the way of the refunds.
      expect(await main.escrow.earmarksVoid()).to.equal(true);
      expect(await main.escrow.earmarkOf(op1.escrow.target)).to.equal(0);

      await main.escrow.connect(stranger).continueRefunds(17);
      expect(await usdc.balanceOf(fan.address)).to.equal(USDC(17 * 49));
      // Collecting from a cancelled parent finds nothing, and does not revert.
      await op1.escrow.connect(stranger).pullFromParent();
      expect(await usdc.balanceOf(op1.escrow.target)).to.equal(0);

      await expect(op1.escrow.connect(stranger).cancelIfParentEnded())
        .to.emit(op1.escrow, "RefundingStarted").withArgs(CancelReason.ParentEnded, 10_000, 0);
      expect(await op1.show.status()).to.equal(ShowStatus.Cancelled);

      await main.escrow.finalizeCancellationPayout();
      await op1.escrow.finalizeCancellationPayout();
      expect(await usdc.balanceOf(main.escrow.target)).to.equal(0);
      expect(await usdc.balanceOf(band.address)).to.equal(0);
    });

    it("refuses to collect earmarked money once the main show was cancelled", async function () {
      await buy(17);
      await main.escrow.allocate();
      await main.escrow.connect(promoter).cancel();
      await expect(main.escrow.connect(stranger).settleLinked(1))
        .to.be.revertedWithCustomError(main.escrow, "EarmarksVoid");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("Disputes stay separate", function () {
    beforeEach(async function () {
      await main.escrow.connect(promoter).linkAgreement(op1.escrow.target);
    });

    it("a dispute on an opener does not freeze the main show", async function () {
      await op1.escrow.connect(band).raiseDispute();
      expect(await op1.show.isFrozen()).to.equal(true);
      expect(await main.show.isFrozen()).to.equal(false);
      await buy(1);                                    // tickets are still on sale
    });

    it("a dispute on the main show does not freeze an opener", async function () {
      await main.escrow.connect(artist).raiseDispute();
      expect(await main.show.isFrozen()).to.equal(true);
      expect(await op1.show.isFrozen()).to.equal(false);
      await deposit(op1, promoter, USDC(10));
    });

    it("each agreement can be disputed only until its own end time", async function () {
      await time.increaseTo(showEnd + 1);
      await expect(op1.escrow.connect(band).raiseDispute())
        .to.be.revertedWithCustomError(op1.escrow, "DisputeWindowClosed");
    });
  });
});
