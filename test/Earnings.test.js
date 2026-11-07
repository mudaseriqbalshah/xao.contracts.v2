// test/Earnings.test.js
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time }   = require("@nomicfoundation/hardhat-network-helpers");
const {
  USDC, ONE_DAY, MAX_UINT64, PayoutKind, Resolution, TICKET_PRICE,
  tier, deploySystem, showConfig, createShow,
} = require("./helpers/show");

// The same numbering StandingAgreement uses for its splits (both import IEarnings.sol).
const Stream = { Guarantee: 0, TicketRevenue: 1, MerchRevenue: 2, BarRevenue: 3, SponsorshipRevenue: 4, Other: 5 };
const ALL_STREAMS = Object.values(Stream);

describe("Earnings ledger", function () {
  let sys, usdc, promoter, artist, treasury, band, fan, stranger;
  let t0, showEnd;

  async function earned(escrow, who) {
    const out = {};
    for (const [name, s] of Object.entries(Stream)) out[name] = await escrow.earnedBy(who.address, s);
    return out;
  }

  async function total(escrow, who) {
    let sum = 0n;
    for (const s of ALL_STREAMS) sum += await escrow.earnedBy(who.address, s);
    return sum;
  }

  async function signBoth(b, a, c) {
    await b.show.connect(a).signTerms();
    await b.show.connect(c).signTerms();
  }

  async function deposit(b, amount, who = promoter) {
    await usdc.mint(who.address, amount);
    await usdc.connect(who).approve(b.escrow.target, amount);
    await b.escrow.connect(who).deposit(amount);
  }

  // The default sweep pays the venue 40% and the artist 60%; the artist's guarantee is $500.
  async function newShow(name, overrides = {}) {
    const b = await createShow(sys.factory, promoter, showConfig(promoter, artist, t0, {
      anchors: { termsHash: ethers.id(name) },
      funding: [],
      tiers: [tier({ quantity: 100 })],
      ...overrides,
    }));
    await signBoth(b, promoter, artist);
    return b;
  }

  beforeEach(async function () {
    [, promoter, artist, treasury, band, fan, stranger] = await ethers.getSigners();
    sys = await deploySystem();
    usdc = sys.usdc;
    t0 = await time.latest();
    showEnd = t0 + 30 * ONE_DAY + 7_200;
  });

  it("is available through the shared IEarningsSource interface", async function () {
    const b = await newShow("interface");
    const asSource = await ethers.getContractAt("IEarningsSource", b.escrow.target);
    expect(await asSource.earnedBy(artist.address, Stream.Guarantee)).to.equal(0);
  });

  it("records a guarantee payout under Guarantee, and emits it", async function () {
    const b = await newShow("guarantee");
    await deposit(b, USDC(1_000));
    await time.increaseTo(t0 + 15 * ONE_DAY);

    await expect(b.escrow.connect(stranger).executeAvailablePayouts())
      .to.emit(b.escrow, "Earned").withArgs(artist.address, Stream.Guarantee, USDC(500));

    const e = await earned(b.escrow, artist);
    expect(e.Guarantee).to.equal(USDC(500));
    expect(e.Other).to.equal(0);
    expect(e.TicketRevenue).to.equal(0);
  });

  it("records a payout rule that is not a guarantee under Other", async function () {
    const b = await newShow("bonus", {
      payoutRules: [{ to: artist.address, kind: PayoutKind.FixedAmount, value: USDC(100), notBefore: 0, isGuarantee: false }],
    });
    await deposit(b, USDC(300));
    await b.escrow.connect(stranger).executeAvailablePayouts();

    const e = await earned(b.escrow, artist);
    expect(e.Other).to.equal(USDC(100));
    expect(e.Guarantee).to.equal(0);
  });

  it("records each sweep share as TicketRevenue, exactly what was paid, remainder included", async function () {
    const b = await newShow("sweep");
    const amount = ethers.parseUnits("1000.000003", 6);      // does not split evenly
    await deposit(b, amount);
    await time.increaseTo(showEnd);

    // Pay-outs are due: the guarantee first, then the sweep splits what is left 40/60.
    await b.escrow.connect(stranger).executeFinalSweep();

    const leftover = amount - USDC(500);
    const venueShare = leftover * 4_000n / 10_000n;
    const artistShare = leftover - venueShare;               // the last recipient takes the remainder

    expect(await b.escrow.earnedBy(promoter.address, Stream.TicketRevenue)).to.equal(venueShare);
    expect(await b.escrow.earnedBy(artist.address, Stream.TicketRevenue)).to.equal(artistShare);
    expect(await b.escrow.earnedBy(artist.address, Stream.Guarantee)).to.equal(USDC(500));

    // What the ledger says they earned is what they were paid.
    expect(await total(b.escrow, artist)).to.equal(await usdc.balanceOf(artist.address));
    expect(await total(b.escrow, promoter)).to.equal(await usdc.balanceOf(promoter.address));
  });

  it("does not record the protocol fee, ticket refunds or a deposit as earnings", async function () {
    const b = await newShow("not-earnings");
    await deposit(b, USDC(1_000));                           // the owner moving money in
    await usdc.mint(fan.address, TICKET_PRICE * 2n);
    await usdc.connect(fan).approve(b.ticket.target, TICKET_PRICE * 2n);
    await b.ticket.connect(fan).buyTicket(0);
    await b.ticket.connect(fan).buyTicket(0);

    expect(await total(b.escrow, promoter)).to.equal(0);     // a deposit is not income

    await time.increaseTo(showEnd);
    await b.escrow.connect(stranger).executeFinalSweep();    // pays Xao's 2% to the treasury
    expect(await usdc.balanceOf(treasury.address)).to.be.gt(0);
    expect(await total(b.escrow, treasury)).to.equal(0);
    expect(await total(b.escrow, fan)).to.equal(0);
  });

  it("records resale royalties paid out after completion under Other", async function () {
    const b = await newShow("late");
    await time.increaseTo(showEnd);
    await b.escrow.connect(stranger).executeFinalSweep();

    await usdc.mint(b.escrow.target, USDC(10));
    await b.escrow.connect(stranger).distributeLateFunds();

    expect(await b.escrow.earnedBy(promoter.address, Stream.Other)).to.equal(USDC(4));
    expect(await b.escrow.earnedBy(artist.address, Stream.Other)).to.equal(USDC(6));
  });

  it("records what the parties get when a show is cancelled, but not buyers' refunds or the treasury's cut", async function () {
    const b = await newShow("cancelled", {
      cancelRules: [{ notAfter: MAX_UINT64, payBpsToPartyA: 5_000, payBpsToPartyB: 4_000, treasuryBps: 1_000 }],
    });
    await deposit(b, USDC(1_000));
    await usdc.mint(fan.address, TICKET_PRICE);
    await usdc.connect(fan).approve(b.ticket.target, TICKET_PRICE);
    await b.ticket.connect(fan).buyTicket(0);

    await b.escrow.connect(artist).cancel();
    await b.escrow.connect(stranger).continueRefunds(5);
    await b.escrow.connect(stranger).finalizeCancellationPayout();

    expect(await b.escrow.earnedBy(promoter.address, Stream.Other)).to.equal(USDC(500));
    expect(await b.escrow.earnedBy(artist.address, Stream.Other)).to.equal(USDC(400));
    expect(await usdc.balanceOf(treasury.address)).to.be.gte(USDC(100));
    expect(await total(b.escrow, treasury)).to.equal(0);
    expect(await total(b.escrow, fan)).to.equal(0);
  });

  it("records what a party gets when a dispute is settled in its favour under Other", async function () {
    const b = await newShow("dispute");
    await deposit(b, USDC(300));
    await b.escrow.connect(artist).raiseDispute();
    await b.escrow.connect(artist).resolveDispute(Resolution.ReleaseToPartyB);
    await b.escrow.connect(promoter).resolveDispute(Resolution.ReleaseToPartyB);

    expect(await b.escrow.earnedBy(artist.address, Stream.Other)).to.equal(USDC(300));
    expect(await total(b.escrow, promoter)).to.equal(0);
  });

  it("still records a payment the token refused, and claiming it later adds nothing", async function () {
    const bsys = await deploySystem("MockBlockableERC20");
    const token = bsys.usdc;
    const b = await createShow(bsys.factory, promoter, showConfig(promoter, artist, t0, {
      anchors: { termsHash: ethers.id("blocked") }, funding: [],
    }));
    await signBoth(b, promoter, artist);
    await token.mint(promoter.address, USDC(1_000));
    await token.connect(promoter).approve(b.escrow.target, USDC(1_000));
    await b.escrow.connect(promoter).deposit(USDC(1_000));

    await token.setBlocked(artist.address, true);
    await time.increaseTo(showEnd);
    await b.escrow.connect(stranger).executeFinalSweep();

    expect(await token.balanceOf(artist.address)).to.equal(0);
    expect(await b.escrow.unclaimed(artist.address)).to.equal(USDC(800));
    expect(await b.escrow.earnedBy(artist.address, Stream.Guarantee)).to.equal(USDC(500));
    expect(await b.escrow.earnedBy(artist.address, Stream.TicketRevenue)).to.equal(USDC(300));

    await token.setBlocked(artist.address, false);
    await b.escrow.connect(artist).claim();
    expect(await token.balanceOf(artist.address)).to.equal(USDC(800));
    expect(await total(b.escrow, artist)).to.equal(USDC(800));    // unchanged by the claim
  });

  it("records an opener's pay in its own escrow, and money moved between linked escrows is not an earning", async function () {
    const main = await newShow("main-with-opener", {
      payoutRules: [{ to: artist.address, kind: PayoutKind.FixedAmount, value: USDC(50), notBefore: showEnd, isGuarantee: true }],
      sweep: { recipients: [promoter.address], bps: [10_000], notBefore: showEnd },
    });
    const opener = await createShow(sys.factory, promoter, showConfig(promoter, band, t0, {
      tickets: { ticketsEnabled: false },
      anchors: { termsHash: ethers.id("opener") },
      funding: [],
      payoutRules: [{ to: band.address, kind: PayoutKind.FixedAmount, value: USDC(20), notBefore: showEnd, isGuarantee: true }],
      sweep: { recipients: [promoter.address], bps: [10_000], notBefore: showEnd },
    }));
    await signBoth(opener, promoter, band);
    await main.escrow.connect(promoter).linkAgreement(opener.escrow.target);

    await usdc.mint(fan.address, TICKET_PRICE * 4n);
    await usdc.connect(fan).approve(main.ticket.target, TICKET_PRICE * 4n);
    for (let i = 0; i < 4; i++) await main.ticket.connect(fan).buyTicket(0);
    await main.escrow.allocate();

    await time.increaseTo(showEnd);
    await opener.escrow.connect(stranger).executeAvailablePayouts();   // collects from the main escrow, pays the band
    await main.escrow.connect(stranger).executeFinalSweep();

    expect(await opener.escrow.earnedBy(band.address, Stream.Guarantee)).to.equal(USDC(20));
    expect(await main.escrow.earnedBy(artist.address, Stream.Guarantee)).to.equal(USDC(50));
    // The main escrow moved $20 into the opener's escrow. That is not income for anyone.
    expect(await total(main.escrow, { address: opener.escrow.target })).to.equal(0);
    expect(await total(opener.escrow, { address: opener.escrow.target })).to.equal(0);
    // The venue earned the rest of the ticket money from the main escrow, as TicketRevenue.
    expect(await main.escrow.earnedBy(promoter.address, Stream.TicketRevenue)).to.be.gt(0);
  });

  it("never records anything for streams that nothing pays yet", async function () {
    const b = await newShow("other-streams");
    await deposit(b, USDC(1_000));
    await time.increaseTo(showEnd);
    await b.escrow.connect(stranger).executeFinalSweep();
    for (const s of [Stream.MerchRevenue, Stream.BarRevenue, Stream.SponsorshipRevenue]) {
      expect(await b.escrow.earnedBy(artist.address, s)).to.equal(0);
      expect(await b.escrow.earnedBy(promoter.address, s)).to.equal(0);
    }
  });
});
