// test/ShowContract.test.js
"use strict";

const { expect }  = require("chai");
const { ethers }  = require("hardhat");
const { time }    = require("@nomicfoundation/hardhat-network-helpers");

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const USDC_DEC      = 6;
const USDC          = (n) => ethers.parseUnits(String(n), USDC_DEC);
const ONE_DAY       = 86_400;
const ZERO_BYTES32  = ethers.ZeroHash;

const PartyRole = { PROMOTER: 0, ARTIST: 1, VENUE: 2, BOOKING_AGENT: 3, PRODUCTION: 4, OTHER: 5 };
const Status    = { DRAFT: 0, PROPOSED: 1, COUNTER_PROPOSED: 2, APPROVED: 3, ACTIVE: 4, COMPLETED: 5, CANCELLED: 6, DISPUTED: 7 };

// ─── DEPLOY HELPERS ───────────────────────────────────────────────────────────

async function deployUSDC() {
  const F    = await ethers.getContractFactory("MockERC20");
  const usdc = await F.deploy("USD Coin", "USDC", USDC_DEC);
  await usdc.waitForDeployment();
  return usdc;
}

async function deployShow(signers, opts = {}) {
  const [, p1, p2, treasury] = signers;
  const usdc = opts.usdc || await deployUSDC();
  const now  = await time.latest();

  const datesConfig = {
    announcementDate: now,
    eventStartDate:   now + 30 * ONE_DAY,
    eventEndDate:     now + 30 * ONE_DAY,
    loadInTime:       now + 30 * ONE_DAY - 3_600,
    doorsTime:        now + 30 * ONE_DAY - 1_800,
    startTime:        now + 30 * ONE_DAY,
    endTime:          now + 30 * ONE_DAY + 7_200,
    setTime:          now + 30 * ONE_DAY,
    setLengthMinutes: 60,
    ...opts.dates,
  };

  const p1Config = { wallet: p1.address, role: PartyRole.PROMOTER, xaoUsername: "promoter1" };
  const locConfig = { venueName: "Test Venue", venueAddress: "123 Main St", radiusMiles: 50, radiusDays: 7 };
  const tickConfig = {
    ticketsEnabled: opts.ticketsEnabled !== undefined ? opts.ticketsEnabled : true,
    totalCapacity:  opts.totalCapacity  ?? 1_000,
    salesTaxBPS:    opts.salesTaxBPS    ?? 800,
  };
  const finConfig = {
    guaranteeUSDC:   opts.guaranteeUSDC   !== undefined ? opts.guaranteeUSDC   : USDC(1_000),
    guaranteePctBPS: opts.guaranteePctBPS !== undefined ? opts.guaranteePctBPS : 0,
    backendBPS:  2_000,
    barSplitBPS: 0,
    merchSplitBPS: 0,
  };
  const promoConfig = {
    eventName:       opts.eventName || "Test Show",
    flyerDNSLink:    "ipns://test",
    flyerCIDHash:    ethers.zeroPadValue("0x01", 32),
    riderIPFSCID:    "Qmrider",
    contractLegal:   "Standard legal",
    ticketLegal:     "Ticket legal",
    contractCIDHash: ethers.zeroPadValue("0x02", 32),
  };

  const Factory = await ethers.getContractFactory("ShowContract");
  const show = await Factory.deploy(
    p1Config,
    p2.address,
    PartyRole.ARTIST,
    datesConfig,
    locConfig,
    tickConfig,
    finConfig,
    promoConfig,
    usdc.target,
    treasury.address
  );
  await show.waitForDeployment();
  return { show, usdc, p1, p2, treasury, now, datesConfig };
}

async function signBoth(show, p1, p2) {
  await show.connect(p1).sign();
  await show.connect(p2).sign();
}

async function getTicketContract(show) {
  const filter = show.filters.TicketCollectionDeployed();
  const events = await show.queryFilter(filter);
  const ticketAddr = events[0].args.ticketContract;
  return ethers.getContractAt("XAOTicket", ticketAddr);
}

// Default tier for XAOTicket tests
const DEFAULT_TIER = {
  ticketType:      2,          // GENERAL_ADMISSION
  customName:      "",
  priceUSDC:       USDC(10),
  quantity:        100,
  onSaleTimestamp: 0,          // immediately on sale
  party1ResaleBPS: 5_000,
  party2ResaleBPS: 3_000,
  resellerBPS:     2_000,
};

async function addDefaultTier(ticket, p1, overrides = {}) {
  const t = { ...DEFAULT_TIER, ...overrides };
  return ticket.connect(p1).addTier(
    t.ticketType, t.customName, t.priceUSDC,
    t.quantity,   t.onSaleTimestamp,
    t.party1ResaleBPS, t.party2ResaleBPS, t.resellerBPS
  );
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

describe("ShowContractFactory", function () {
  let signers, factory, usdc;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    usdc    = await deployUSDC();

    const F = await ethers.getContractFactory("ShowContractFactory");
    factory = await F.deploy();
    await factory.waitForDeployment();
  });

  it("deploys a ShowContract and returns its address", async function () {
    const [, p1, p2, treasury] = signers;
    const now = await time.latest();

    const p1Cfg = { wallet: p1.address, role: 0, xaoUsername: "p1" };
    const dates = {
      announcementDate: now, eventStartDate: now + ONE_DAY, eventEndDate: now + ONE_DAY,
      loadInTime: now + ONE_DAY - 3600, doorsTime: now + ONE_DAY - 1800,
      startTime: now + ONE_DAY, endTime: now + ONE_DAY + 7200, setTime: now + ONE_DAY, setLengthMinutes: 60,
    };
    const loc   = { venueName: "V", venueAddress: "A", radiusMiles: 0, radiusDays: 0 };
    const tick  = { ticketsEnabled: false, totalCapacity: 500, salesTaxBPS: 0 };
    const fin   = { guaranteeUSDC: USDC(100), guaranteePctBPS: 0, backendBPS: 0, barSplitBPS: 0, merchSplitBPS: 0 };
    const promo = {
      eventName: "Show", flyerDNSLink: "", flyerCIDHash: ZERO_BYTES32,
      riderIPFSCID: "", contractLegal: "", ticketLegal: "", contractCIDHash: ZERO_BYTES32,
    };

    const tx = await factory.create(p1Cfg, p2.address, 1, dates, loc, tick, fin, promo, usdc.target, treasury.address);
    const receipt = await tx.wait();
    const ev = receipt.logs
      .map(l => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find(e => e?.name === "ShowContractCreated");

    expect(ev).to.not.be.null;
    expect(ev.args.party1Wallet).to.equal(p1.address);
    expect(ev.args.party2Wallet).to.equal(p2.address);
  });

  it("increments getContractCount()", async function () {
    const [, p1, p2, treasury] = signers;
    const now = await time.latest();
    const p1Cfg = { wallet: p1.address, role: 0, xaoUsername: "p1" };
    const dates = {
      announcementDate: now, eventStartDate: now + ONE_DAY, eventEndDate: now + ONE_DAY,
      loadInTime: 0, doorsTime: 0, startTime: 0, endTime: 0, setTime: 0, setLengthMinutes: 0,
    };
    const loc   = { venueName: "", venueAddress: "", radiusMiles: 0, radiusDays: 0 };
    const tick  = { ticketsEnabled: false, totalCapacity: 100, salesTaxBPS: 0 };
    const fin   = { guaranteeUSDC: 0, guaranteePctBPS: 0, backendBPS: 0, barSplitBPS: 0, merchSplitBPS: 0 };
    const promo = { eventName: "", flyerDNSLink: "", flyerCIDHash: ZERO_BYTES32, riderIPFSCID: "", contractLegal: "", ticketLegal: "", contractCIDHash: ZERO_BYTES32 };
    const args = [p1Cfg, p2.address, 1, dates, loc, tick, fin, promo, usdc.target, treasury.address];

    await (await factory.create(...args)).wait();
    await (await factory.create(...args)).wait();
    expect(await factory.getContractCount()).to.equal(2n);
  });

  it("tracks contracts in getUserContracts for both parties", async function () {
    const [, p1, p2, treasury] = signers;
    const now = await time.latest();
    const p1Cfg = { wallet: p1.address, role: 0, xaoUsername: "p1" };
    const dates = { announcementDate: now, eventStartDate: now + ONE_DAY, eventEndDate: 0, loadInTime: 0, doorsTime: 0, startTime: 0, endTime: 0, setTime: 0, setLengthMinutes: 0 };
    const loc   = { venueName: "", venueAddress: "", radiusMiles: 0, radiusDays: 0 };
    const tick  = { ticketsEnabled: false, totalCapacity: 100, salesTaxBPS: 0 };
    const fin   = { guaranteeUSDC: 0, guaranteePctBPS: 0, backendBPS: 0, barSplitBPS: 0, merchSplitBPS: 0 };
    const promo = { eventName: "", flyerDNSLink: "", flyerCIDHash: ZERO_BYTES32, riderIPFSCID: "", contractLegal: "", ticketLegal: "", contractCIDHash: ZERO_BYTES32 };
    const tx = await factory.create(p1Cfg, p2.address, 1, dates, loc, tick, fin, promo, usdc.target, treasury.address);
    const receipt = await tx.wait();
    const ev = receipt.logs
      .map(l => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find(e => e?.name === "ShowContractCreated");
    const addr = ev.args.contractAddr;
    expect(await factory.getUserContracts(p1.address)).to.include(addr);
    expect(await factory.getUserContracts(p2.address)).to.include(addr);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ShowContract — Initial State", function () {
  let signers, ctx;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    ctx = await deployShow(signers);
  });

  it("sets party1 address and role", async function () {
    const { show, p1 } = ctx;
    const party = await show.party1();
    expect(party.wallet).to.equal(p1.address);
    expect(party.role).to.equal(PartyRole.PROMOTER);
  });

  it("sets party2 address and role", async function () {
    const { show, p2 } = ctx;
    const party = await show.party2();
    expect(party.wallet).to.equal(p2.address);
    expect(party.role).to.equal(PartyRole.ARTIST);
  });

  it("starts in DRAFT status", async function () {
    expect(await ctx.show.status()).to.equal(Status.DRAFT);
  });

  it("isFinalized is false on deploy", async function () {
    expect(await ctx.show.isFinalized()).to.equal(false);
  });

  it("party1 has ADMIN_ROLE", async function () {
    const { show, p1 } = ctx;
    const ADMIN_ROLE = await show.ADMIN_ROLE();
    expect(await show.hasRole(ADMIN_ROLE, p1.address)).to.equal(true);
  });

  it("reverts if guaranteeUSDC and guaranteePctBPS are both non-zero", async function () {
    const [, p1, p2, treasury] = signers;
    const usdc = await deployUSDC();
    const now  = await time.latest();
    const Factory = await ethers.getContractFactory("ShowContract");

    const p1Cfg = { wallet: p1.address, role: 0, xaoUsername: "" };
    const dates = { announcementDate: now, eventStartDate: now + ONE_DAY, eventEndDate: 0, loadInTime: 0, doorsTime: 0, startTime: 0, endTime: 0, setTime: 0, setLengthMinutes: 0 };
    const loc   = { venueName: "", venueAddress: "", radiusMiles: 0, radiusDays: 0 };
    const tick  = { ticketsEnabled: false, totalCapacity: 100, salesTaxBPS: 0 };
    const fin   = { guaranteeUSDC: USDC(100), guaranteePctBPS: 3_000, backendBPS: 0, barSplitBPS: 0, merchSplitBPS: 0 };
    const promo = { eventName: "", flyerDNSLink: "", flyerCIDHash: ZERO_BYTES32, riderIPFSCID: "", contractLegal: "", ticketLegal: "", contractCIDHash: ZERO_BYTES32 };

    await expect(
      Factory.deploy(p1Cfg, p2.address, 1, dates, loc, tick, fin, promo, usdc.target, treasury.address)
    ).to.be.revertedWith("Guarantee: use flat or pct, not both");
  });

  it("allows guaranteeUSDC only", async function () {
    expect(await ctx.show.guaranteeUSDC()).to.equal(USDC(1_000));
    expect(await ctx.show.guaranteePctBPS()).to.equal(0n);
  });

  it("stores eventName, venueName, dates correctly", async function () {
    const { show, datesConfig } = ctx;
    expect(await show.eventName()).to.equal("Test Show");
    expect(await show.venueName()).to.equal("Test Venue");
    expect(await show.endTime()).to.equal(datesConfig.endTime);
    expect(await show.doorsTime()).to.equal(datesConfig.doorsTime);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ShowContract — Signing", function () {
  let signers, ctx;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    ctx = await deployShow(signers);
  });

  it("party1 sign → status PROPOSED", async function () {
    await ctx.show.connect(ctx.p1).sign();
    expect(await ctx.show.status()).to.equal(Status.PROPOSED);
  });

  it("party1 sign sets hasSigned", async function () {
    await ctx.show.connect(ctx.p1).sign();
    expect(await ctx.show.hasSigned(ctx.p1.address)).to.equal(true);
  });

  it("third party cannot sign", async function () {
    const stranger = signers[5];
    await expect(ctx.show.connect(stranger).sign()).to.be.revertedWith("Not a party");
  });

  it("party1 cannot sign twice", async function () {
    await ctx.show.connect(ctx.p1).sign();
    await expect(ctx.show.connect(ctx.p1).sign()).to.be.revertedWith("Already signed");
  });

  it("both sign → status APPROVED + isFinalized = true", async function () {
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    expect(await ctx.show.status()).to.equal(Status.APPROVED);
    expect(await ctx.show.isFinalized()).to.equal(true);
  });

  it("emits ContractFinalized with contractCIDHash", async function () {
    const cid = await ctx.show.contractCIDHash();
    await ctx.show.connect(ctx.p1).sign();
    await expect(ctx.show.connect(ctx.p2).sign())
      .to.emit(ctx.show, "ContractFinalized")
      .withArgs(await ctx.show.getAddress(), cid);
  });

  it("deploys XAOTicket when ticketsEnabled = true", async function () {
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    const ticket = await ctx.show.ticketCollection();
    expect(ticket).to.not.equal(ethers.ZeroAddress);
  });

  it("emits TicketCollectionDeployed", async function () {
    await ctx.show.connect(ctx.p1).sign();
    await expect(ctx.show.connect(ctx.p2).sign())
      .to.emit(ctx.show, "TicketCollectionDeployed");
  });

  it("does NOT deploy XAOTicket when ticketsEnabled = false", async function () {
    ctx = await deployShow(signers, { ticketsEnabled: false });
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    expect(await ctx.show.ticketCollection()).to.equal(ethers.ZeroAddress);
  });

  it("cannot sign when CANCELLED", async function () {
    await ctx.show.connect(ctx.p1).cancelContract();
    await expect(ctx.show.connect(ctx.p1).sign()).to.be.revertedWith("Terminal or disputed state");
  });

  it("already-signed party cannot sign again after finalization", async function () {
    // After signBoth, hasSigned[p1]=true → "Already signed" is hit first (expected behaviour)
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    await expect(ctx.show.connect(ctx.p1).sign()).to.be.revertedWith("Already signed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ShowContract — updateContractCID", function () {
  let signers, ctx;
  const NEW_CID = ethers.zeroPadValue("0xdeadbeef", 32);

  beforeEach(async function () {
    signers = await ethers.getSigners();
    ctx = await deployShow(signers);
    // Fund both parties with USDC for edit fees
    await ctx.usdc.mint(ctx.p1.address, USDC(100));
    await ctx.usdc.mint(ctx.p2.address, USDC(100));
    await ctx.usdc.connect(ctx.p1).approve(await ctx.show.getAddress(), USDC(100));
    await ctx.usdc.connect(ctx.p2).approve(await ctx.show.getAddress(), USDC(100));
  });

  it("party1 can update CID in DRAFT (charges $1 USDC)", async function () {
    const before = await ctx.usdc.balanceOf(ctx.treasury.address);
    await ctx.show.connect(ctx.p1).updateContractCID(NEW_CID);
    const after = await ctx.usdc.balanceOf(ctx.treasury.address);
    expect(after - before).to.equal(USDC(1));
    expect(await ctx.show.contractCIDHash()).to.equal(NEW_CID);
  });

  it("party2 can update CID in DRAFT", async function () {
    await ctx.show.connect(ctx.p2).updateContractCID(NEW_CID);
    expect(await ctx.show.contractCIDHash()).to.equal(NEW_CID);
  });

  it("third party cannot update CID", async function () {
    await expect(
      ctx.show.connect(signers[5]).updateContractCID(NEW_CID)
    ).to.be.revertedWith("Not a party");
  });

  it("reverts if contract is finalized", async function () {
    await ctx.usdc.mint(ctx.p1.address, USDC(1_000));
    await ctx.usdc.connect(ctx.p1).approve(await ctx.show.getAddress(), USDC(1_000));
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    await expect(
      ctx.show.connect(ctx.p1).updateContractCID(NEW_CID)
    ).to.be.revertedWith("Already finalized");
  });

  it("party2 update while PROPOSED → COUNTER_PROPOSED, resets party1 signature", async function () {
    await ctx.show.connect(ctx.p1).sign();
    expect(await ctx.show.status()).to.equal(Status.PROPOSED);

    await ctx.show.connect(ctx.p2).updateContractCID(NEW_CID);
    expect(await ctx.show.status()).to.equal(Status.COUNTER_PROPOSED);
    expect(await ctx.show.hasSigned(ctx.p1.address)).to.equal(false);
  });

  it("party1 update while COUNTER_PROPOSED → PROPOSED, resets party2 signature", async function () {
    // Correct path to COUNTER_PROPOSED:
    // 1. party1 signs → PROPOSED
    await ctx.show.connect(ctx.p1).sign();
    // 2. party2 updates CID → COUNTER_PROPOSED, party1 sig reset
    await ctx.show.connect(ctx.p2).updateContractCID(NEW_CID);
    expect(await ctx.show.status()).to.equal(Status.COUNTER_PROPOSED);
    expect(await ctx.show.hasSigned(ctx.p1.address)).to.equal(false);

    // 3. party2 signs → hasSigned[p2]=true (status stays COUNTER_PROPOSED, p1 still needs to sign)
    await ctx.show.connect(ctx.p2).sign();
    expect(await ctx.show.hasSigned(ctx.p2.address)).to.equal(true);

    // 4. party1 updates CID while COUNTER_PROPOSED → PROPOSED, party2 sig reset
    await ctx.show.connect(ctx.p1).updateContractCID(ethers.zeroPadValue("0x03", 32));
    expect(await ctx.show.status()).to.equal(Status.PROPOSED);
    expect(await ctx.show.hasSigned(ctx.p2.address)).to.equal(false);
  });

  it("emits ContractUpdated", async function () {
    await expect(ctx.show.connect(ctx.p1).updateContractCID(NEW_CID))
      .to.emit(ctx.show, "ContractUpdated")
      .withArgs(await ctx.show.getAddress(), NEW_CID, ctx.p1.address);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ShowContract — cancelContract", function () {
  let signers, ctx;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    ctx = await deployShow(signers);
  });

  it("party1 can cancel", async function () {
    await ctx.show.connect(ctx.p1).cancelContract();
    expect(await ctx.show.status()).to.equal(Status.CANCELLED);
  });

  it("party2 can cancel", async function () {
    await ctx.show.connect(ctx.p2).cancelContract();
    expect(await ctx.show.status()).to.equal(Status.CANCELLED);
  });

  it("emits ContractCancelled", async function () {
    await expect(ctx.show.connect(ctx.p1).cancelContract())
      .to.emit(ctx.show, "ContractCancelled")
      .withArgs(ctx.p1.address);
  });

  it("cannot cancel twice", async function () {
    await ctx.show.connect(ctx.p1).cancelContract();
    await expect(ctx.show.connect(ctx.p2).cancelContract())
      .to.be.revertedWith("Terminal state");
  });

  it("third party cannot cancel", async function () {
    await expect(ctx.show.connect(signers[5]).cancelContract())
      .to.be.revertedWith("Not a party");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ShowContract — raiseDispute", function () {
  let signers, ctx;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    ctx = await deployShow(signers);
    await signBoth(ctx.show, ctx.p1, ctx.p2);
  });

  it("party1 can raise dispute", async function () {
    await ctx.show.connect(ctx.p1).raiseDispute();
    expect(await ctx.show.status()).to.equal(Status.DISPUTED);
  });

  it("party2 can raise dispute", async function () {
    await ctx.show.connect(ctx.p2).raiseDispute();
    expect(await ctx.show.status()).to.equal(Status.DISPUTED);
  });

  it("emits DisputeOpened", async function () {
    await expect(ctx.show.connect(ctx.p1).raiseDispute())
      .to.emit(ctx.show, "DisputeOpened")
      .withArgs(await ctx.show.getAddress(), ctx.p1.address);
  });

  it("third party cannot raise dispute", async function () {
    await expect(ctx.show.connect(signers[5]).raiseDispute())
      .to.be.revertedWith("Not a party");
  });

  it("reverts if not finalized", async function () {
    ctx = await deployShow(signers);
    await expect(ctx.show.connect(ctx.p1).raiseDispute())
      .to.be.revertedWith("Not finalized");
  });

  it("reverts if already CANCELLED", async function () {
    ctx = await deployShow(signers);
    await ctx.show.connect(ctx.p1).cancelContract();
    await expect(ctx.show.connect(ctx.p1).raiseDispute())
      .to.be.revertedWith("Not finalized");
  });

  it("reverts if already DISPUTED", async function () {
    await ctx.show.connect(ctx.p1).raiseDispute();
    await expect(ctx.show.connect(ctx.p2).raiseDispute())
      .to.be.revertedWith("Invalid state for dispute");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ShowContract — resolveDispute", function () {
  let signers, ctx;

  async function setupDispute(opts = {}) {
    signers = await ethers.getSigners();
    ctx = await deployShow(signers, { ticketsEnabled: false, ...opts });
    const showAddr = await ctx.show.getAddress();

    // Mint and deposit some escrow
    await ctx.usdc.mint(ctx.p1.address, USDC(5_000));
    await ctx.usdc.connect(ctx.p1).approve(showAddr, USDC(5_000));
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    await ctx.show.connect(ctx.p1).depositGuarantee(USDC(2_000));

    await ctx.show.connect(ctx.p1).raiseDispute();
    expect(await ctx.show.status()).to.equal(Status.DISPUTED);
  }

  it("reverts if not DISPUTED", async function () {
    signers = await ethers.getSigners();
    ctx = await deployShow(signers, { ticketsEnabled: false });
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    await expect(ctx.show.connect(ctx.p1).resolveDispute(true))
      .to.be.revertedWith("Not disputed");
  });

  it("party1 vote alone does not resolve", async function () {
    await setupDispute();
    await ctx.show.connect(ctx.p1).resolveDispute(true);
    expect(await ctx.show.status()).to.equal(Status.DISPUTED);
  });

  it("both vote releaseToParty2=true → COMPLETED, party2 receives escrow", async function () {
    await setupDispute();
    const p2Before = await ctx.usdc.balanceOf(ctx.p2.address);
    await ctx.show.connect(ctx.p1).resolveDispute(true);
    await ctx.show.connect(ctx.p2).resolveDispute(true);

    expect(await ctx.show.status()).to.equal(Status.COMPLETED);
    expect(await ctx.show.escrowBalance()).to.equal(0n);
    const p2After = await ctx.usdc.balanceOf(ctx.p2.address);
    expect(p2After - p2Before).to.equal(USDC(2_000));
  });

  it("both vote releaseToParty2=false → COMPLETED, party1 receives escrow", async function () {
    await setupDispute();
    const p1Before = await ctx.usdc.balanceOf(ctx.p1.address);
    await ctx.show.connect(ctx.p1).resolveDispute(false);
    await ctx.show.connect(ctx.p2).resolveDispute(false);

    expect(await ctx.show.status()).to.equal(Status.COMPLETED);
    const p1After = await ctx.usdc.balanceOf(ctx.p1.address);
    expect(p1After - p1Before).to.equal(USDC(2_000));
  });

  it("reverts when parties disagree", async function () {
    await setupDispute();
    await ctx.show.connect(ctx.p1).resolveDispute(true);
    await expect(ctx.show.connect(ctx.p2).resolveDispute(false))
      .to.be.revertedWith("Parties disagree on resolution");
  });

  it("party cannot vote twice", async function () {
    await setupDispute();
    await ctx.show.connect(ctx.p1).resolveDispute(true);
    await expect(ctx.show.connect(ctx.p1).resolveDispute(true))
      .to.be.revertedWith("Already voted");
  });

  it("emits DisputeResolved on agreement", async function () {
    await setupDispute();
    await ctx.show.connect(ctx.p1).resolveDispute(false);
    await expect(ctx.show.connect(ctx.p2).resolveDispute(false))
      .to.emit(ctx.show, "DisputeResolved")
      .withArgs(await ctx.show.getAddress(), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ShowContract — Escrow", function () {
  let signers, ctx;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    ctx = await deployShow(signers, { ticketsEnabled: false });
    await ctx.usdc.mint(ctx.p1.address, USDC(10_000));
    await ctx.usdc.connect(ctx.p1).approve(await ctx.show.getAddress(), USDC(10_000));
  });

  it("reverts depositGuarantee before finalization", async function () {
    await expect(ctx.show.connect(ctx.p1).depositGuarantee(USDC(100)))
      .to.be.revertedWith("Not finalized");
  });

  it("party1 can deposit after finalization", async function () {
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    await ctx.show.connect(ctx.p1).depositGuarantee(USDC(500));
    expect(await ctx.show.escrowBalance()).to.equal(USDC(500));
  });

  it("party2 can deposit after finalization", async function () {
    await ctx.usdc.mint(ctx.p2.address, USDC(500));
    await ctx.usdc.connect(ctx.p2).approve(await ctx.show.getAddress(), USDC(500));
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    await ctx.show.connect(ctx.p2).depositGuarantee(USDC(200));
    expect(await ctx.show.escrowBalance()).to.equal(USDC(200));
  });

  it("depositGuarantee reverts when DISPUTED (escrow frozen)", async function () {
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    await ctx.show.connect(ctx.p1).raiseDispute();
    await expect(ctx.show.connect(ctx.p1).depositGuarantee(USDC(100)))
      .to.be.revertedWith("Escrow frozen");
  });

  it("creditRevenue reverts from non-ticketCollection", async function () {
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    await expect(ctx.show.connect(ctx.p1).creditRevenue(USDC(100)))
      .to.be.revertedWith("Not ticket contract");
  });

  it("withdrawEscrow works after COMPLETED", async function () {
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    await ctx.show.connect(ctx.p1).depositGuarantee(USDC(1_000));

    // Fast-forward past endTime and mark completed
    await time.increaseTo(ctx.datesConfig.endTime + 1);
    await ctx.show.connect(ctx.p1).markCompleted();

    const before = await ctx.usdc.balanceOf(ctx.p2.address);
    await ctx.show.connect(ctx.p1).withdrawEscrow(ctx.p2.address, USDC(500));
    expect(await ctx.usdc.balanceOf(ctx.p2.address) - before).to.equal(USDC(500));
    expect(await ctx.show.escrowBalance()).to.equal(USDC(500));
  });

  it("withdrawEscrow reverts when not COMPLETED", async function () {
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    await ctx.show.connect(ctx.p1).depositGuarantee(USDC(1_000));
    await expect(ctx.show.connect(ctx.p1).withdrawEscrow(ctx.p2.address, USDC(500)))
      .to.be.revertedWith("Not completed");
  });

  it("markCompleted reverts before endTime", async function () {
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    await expect(ctx.show.connect(ctx.p1).markCompleted())
      .to.be.revertedWith("Show not ended yet");
  });

  it("markCompleted works at/after endTime", async function () {
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    await time.increaseTo(ctx.datesConfig.endTime + 1);
    await ctx.show.connect(ctx.p1).markCompleted();
    expect(await ctx.show.status()).to.equal(Status.COMPLETED);
  });

  it("only party1 can call markCompleted", async function () {
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    await time.increaseTo(ctx.datesConfig.endTime + 1);
    await expect(ctx.show.connect(ctx.p2).markCompleted()).to.be.revertedWith("Not party1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ShowContract — Payment Schedules", function () {
  let signers, ctx;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    ctx = await deployShow(signers, { ticketsEnabled: false });
  });

  it("party1 can add party1Deposits before finalization", async function () {
    const now = await time.latest();
    await ctx.show.connect(ctx.p1).addParty1Deposit(now + ONE_DAY, 5_000, USDC(500));
    const deps = await ctx.show.getParty1Deposits();
    expect(deps.length).to.equal(1);
    expect(deps[0].usdcAmount).to.equal(USDC(500));
  });

  it("party1 can add party2Payouts before finalization", async function () {
    const now = await time.latest();
    await ctx.show.connect(ctx.p1).addParty2Payout(now + ONE_DAY, 10_000, USDC(1_000));
    const pays = await ctx.show.getParty2Payouts();
    expect(pays[0].pctBPS).to.equal(10_000n);
  });

  it("cannot add schedules after finalization", async function () {
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    const now = await time.latest();
    await expect(ctx.show.connect(ctx.p1).addParty1Deposit(now + ONE_DAY, 5_000, USDC(500)))
      .to.be.revertedWith("Already finalized");
  });

  it("party2 cannot add payment schedules", async function () {
    const now = await time.latest();
    await expect(ctx.show.connect(ctx.p2).addParty1Deposit(now + ONE_DAY, 5_000, USDC(500)))
      .to.be.revertedWith("Not party1");
  });

  it("cancellation refund entries are stored correctly", async function () {
    const now = await time.latest();
    await ctx.show.connect(ctx.p1).addParty1CancellationRefund(now + 7 * ONE_DAY, 5_000, USDC(500));
    const refs = await ctx.show.getParty1CancellationRefunds();
    expect(refs[0].refundPctBPS).to.equal(5_000n);
    expect(refs[0].refundUSDC).to.equal(USDC(500));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("XAOTicket — Deployment & Initial State", function () {
  let signers, ctx, ticket;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    ctx     = await deployShow(signers, { ticketsEnabled: true });
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    ticket  = await getTicketContract(ctx.show);
  });

  it("showContract address is set correctly", async function () {
    expect(await ticket.showContract()).to.equal(await ctx.show.getAddress());
  });

  it("party1 has ADMIN_ROLE on ticket contract", async function () {
    const ADMIN_ROLE = await ticket.ADMIN_ROLE();
    expect(await ticket.hasRole(ADMIN_ROLE, ctx.p1.address)).to.equal(true);
  });

  it("tierCount starts at 0", async function () {
    expect(await ticket.tierCount()).to.equal(0n);
  });

  it("supports ERC1155 interface", async function () {
    expect(await ticket.supportsInterface("0xd9b67a26")).to.equal(true); // ERC1155
  });

  it("supports ERC2981 interface", async function () {
    expect(await ticket.supportsInterface("0x2a55205a")).to.equal(true); // ERC2981
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("XAOTicket — Tier Management", function () {
  let signers, ctx, ticket;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    ctx     = await deployShow(signers, { ticketsEnabled: true });
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    ticket  = await getTicketContract(ctx.show);
  });

  it("ADMIN_ROLE can add a tier", async function () {
    await addDefaultTier(ticket, ctx.p1);
    expect(await ticket.tierCount()).to.equal(1n);
  });

  it("non-ADMIN cannot add a tier", async function () {
    const stranger = signers[5];
    await expect(
      ticket.connect(stranger).addTier(2, "", USDC(10), 100, 0, 5000, 3000, 2000)
    ).to.be.reverted;
  });

  it("reverts if resale BPS do not sum to 10000", async function () {
    await expect(
      ticket.connect(ctx.p1).addTier(2, "", USDC(10), 100, 0, 5_000, 3_000, 1_999)
    ).to.be.revertedWith("Resale BPS must sum to 10000");
  });

  it("reverts on zero quantity", async function () {
    await expect(
      ticket.connect(ctx.p1).addTier(2, "", USDC(10), 0, 0, 5_000, 3_000, 2_000)
    ).to.be.revertedWith("Zero quantity");
  });

  it("tier data is stored correctly", async function () {
    await addDefaultTier(ticket, ctx.p1, { customName: "Floor" });
    const tier = await ticket.getTier(0);
    expect(tier.priceUSDC).to.equal(USDC(10));
    expect(tier.quantity).to.equal(100n);
    expect(tier.party1ResaleBPS).to.equal(5_000n);
    expect(tier.party2ResaleBPS).to.equal(3_000n);
    expect(tier.resellerBPS).to.equal(2_000n);
  });

  it("COMP type (free) can be added", async function () {
    await ticket.connect(ctx.p1).addTier(0, "Comp", 0, 50, 0, 0, 0, 10_000);
    const tier = await ticket.getTier(0);
    expect(tier.ticketType).to.equal(0n); // COMP
    expect(tier.priceUSDC).to.equal(0n);
  });

  it("emits TierAdded", async function () {
    await expect(addDefaultTier(ticket, ctx.p1))
      .to.emit(ticket, "TierAdded")
      .withArgs(0n, 2n, USDC(10), 100n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("XAOTicket — Buy Ticket", function () {
  let signers, ctx, ticket, buyer, showAddr;
  const PRICE = USDC(10);

  beforeEach(async function () {
    signers = await ethers.getSigners();
    ctx     = await deployShow(signers, { ticketsEnabled: true, totalCapacity: 5 });
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    ticket  = await getTicketContract(ctx.show);
    showAddr = await ctx.show.getAddress();
    buyer   = signers[6];

    await addDefaultTier(ticket, ctx.p1, { quantity: 3 });

    // Fund buyer
    await ctx.usdc.mint(buyer.address, USDC(1_000));
    await ctx.usdc.connect(buyer).approve(await ticket.getAddress(), USDC(1_000));
  });

  it("successfully mints a ticket to buyer", async function () {
    await ticket.connect(buyer).buyTicket(0);
    expect(await ticket.balanceOf(buyer.address, 0)).to.equal(1n);
  });

  it("increments tier.sold and totalSold", async function () {
    await ticket.connect(buyer).buyTicket(0);
    const tier = await ticket.getTier(0);
    expect(tier.sold).to.equal(1n);
    expect(await ticket.totalSold()).to.equal(1n);
  });

  it("emits TicketSold", async function () {
    await expect(ticket.connect(buyer).buyTicket(0))
      .to.emit(ticket, "TicketSold")
      .withArgs(0n, 0n, buyer.address, PRICE);
  });

  it("sends 2% xaoFee + $1 gas to treasury", async function () {
    const before = await ctx.usdc.balanceOf(ctx.treasury.address);
    await ticket.connect(buyer).buyTicket(0);
    const after = await ctx.usdc.balanceOf(ctx.treasury.address);
    const xaoFee = PRICE * 200n / 10_000n;
    const gas    = USDC(1);
    expect(after - before).to.equal(xaoFee + gas);
  });

  it("sends net (gross - fees) to ShowContract escrow", async function () {
    const before = await ctx.show.escrowBalance();
    await ticket.connect(buyer).buyTicket(0);
    const after = await ctx.show.escrowBalance();
    const xaoFee = PRICE * 200n / 10_000n;
    const expectedNet = PRICE - xaoFee - USDC(1);
    expect(after - before).to.equal(expectedNet);
  });

  it("reverts buyTicket before onSaleTimestamp", async function () {
    const future = (await time.latest()) + 7 * ONE_DAY;
    await ticket.connect(ctx.p1).addTier(2, "", USDC(5), 100, future, 5_000, 3_000, 2_000);
    await expect(ticket.connect(buyer).buyTicket(1)).to.be.revertedWith("Not on sale yet");
  });

  it("reverts when tier is sold out", async function () {
    await ticket.connect(buyer).buyTicket(0);
    await ticket.connect(buyer).buyTicket(0);
    await ticket.connect(buyer).buyTicket(0);
    await expect(ticket.connect(buyer).buyTicket(0)).to.be.revertedWith("Sold out");
  });

  it("reverts when totalCapacity is reached (across tiers)", async function () {
    // Capacity = 5 ; tier0 has 3 tickets already added; add tier1 with 10 qty
    await ticket.connect(ctx.p1).addTier(2, "", USDC(5), 10, 0, 5_000, 3_000, 2_000);
    await ctx.usdc.connect(buyer).approve(await ticket.getAddress(), USDC(10_000));

    // Buy 3 from tier0 (capacity now 3/5)
    for (let i = 0; i < 3; i++) await ticket.connect(buyer).buyTicket(0);
    // Buy 2 more from tier1 (capacity now 5/5)
    for (let i = 0; i < 2; i++) await ticket.connect(buyer).buyTicket(1);
    // One more should hit capacity
    await expect(ticket.connect(buyer).buyTicket(1)).to.be.revertedWith("Capacity reached");
  });

  it("COMP ticket (priceUSDC=0) mints without USDC transfer", async function () {
    await ticket.connect(ctx.p1).addTier(0, "Comp", 0, 50, 0, 0, 0, 10_000);
    const before = await ctx.usdc.balanceOf(buyer.address);
    await ticket.connect(buyer).buyTicket(1); // tierId 1 is the COMP tier
    expect(await ctx.usdc.balanceOf(buyer.address)).to.equal(before);
    expect(await ticket.balanceOf(buyer.address, 0)).to.equal(1n);
  });

  it("reverts on invalid tierId", async function () {
    await expect(ticket.connect(buyer).buyTicket(999)).to.be.revertedWith("Invalid tierId");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("XAOTicket — Scanning", function () {
  let signers, ctx, ticket, scanner, buyer;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    ctx     = await deployShow(signers, { ticketsEnabled: true });
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    ticket  = await getTicketContract(ctx.show);
    scanner = signers[7];
    buyer   = signers[6];

    const SCANNER_ROLE = await ticket.SCANNER_ROLE();
    await ticket.connect(ctx.p1).grantRole(SCANNER_ROLE, scanner.address);

    await addDefaultTier(ticket, ctx.p1);
    await ctx.usdc.mint(buyer.address, USDC(100));
    await ctx.usdc.connect(buyer).approve(await ticket.getAddress(), USDC(100));
    await ticket.connect(buyer).buyTicket(0); // tokenId 0
  });

  it("only SCANNER_ROLE can call scanTicket", async function () {
    await expect(ticket.connect(signers[5]).scanTicket(0)).to.be.reverted;
  });

  it("before doorsTime: emits TicketAuthenticated and does NOT set scanned", async function () {
    // Current time is before doorsTime (set to 30 days in future)
    await expect(ticket.connect(scanner).scanTicket(0))
      .to.emit(ticket, "TicketAuthenticated")
      .withArgs(0n, scanner.address, await time.latest().then(t => t + 1));
    expect(await ticket.scanned(0)).to.equal(false);
  });

  it("at/after doorsTime: sets scanned = true, emits TicketRedeemed", async function () {
    await time.increaseTo(ctx.datesConfig.doorsTime);
    await expect(ticket.connect(scanner).scanTicket(0))
      .to.emit(ticket, "TicketRedeemed");
    expect(await ticket.scanned(0)).to.equal(true);
  });

  it("second scan after doorsTime reverts (Already redeemed)", async function () {
    await time.increaseTo(ctx.datesConfig.doorsTime);
    await ticket.connect(scanner).scanTicket(0);
    await expect(ticket.connect(scanner).scanTicket(0))
      .to.be.revertedWith("Already redeemed");
  });

  it("reverts for invalid tokenId", async function () {
    await expect(ticket.connect(scanner).scanTicket(999))
      .to.be.revertedWith("Invalid token");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("XAOTicket — Transfer Lock", function () {
  let signers, ctx, ticket, buyer, marketplace;

  beforeEach(async function () {
    signers     = await ethers.getSigners();
    ctx         = await deployShow(signers, { ticketsEnabled: true });
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    ticket      = await getTicketContract(ctx.show);
    buyer       = signers[6];
    marketplace = signers[8];

    await addDefaultTier(ticket, ctx.p1);
    await ctx.usdc.mint(buyer.address, USDC(100));
    await ctx.usdc.connect(buyer).approve(await ticket.getAddress(), USDC(100));
    await ticket.connect(buyer).buyTicket(0); // tokenId 0
  });

  it("pre-endTime: direct transfer by owner reverts", async function () {
    await expect(
      ticket.connect(buyer).safeTransferFrom(buyer.address, signers[9].address, 0, 1, "0x")
    ).to.be.revertedWith("Transfers locked until show ends");
  });

  it("pre-endTime: transfer via approved marketplace succeeds", async function () {
    await ticket.connect(ctx.p1).setMarketplaceApproval(marketplace.address, true);
    await ticket.connect(buyer).setApprovalForAll(marketplace.address, true);
    await expect(
      ticket.connect(marketplace).safeTransferFrom(buyer.address, signers[9].address, 0, 1, "0x")
    ).to.not.be.reverted;
  });

  it("post-endTime: direct transfer by owner succeeds", async function () {
    await time.increaseTo(ctx.datesConfig.endTime + 1);
    await expect(
      ticket.connect(buyer).safeTransferFrom(buyer.address, signers[9].address, 0, 1, "0x")
    ).to.not.be.reverted;
  });

  it("pre-endTime: batch transfer by non-marketplace reverts", async function () {
    await expect(
      ticket.connect(buyer).safeBatchTransferFrom(buyer.address, signers[9].address, [0], [1], "0x")
    ).to.be.revertedWith("Transfers locked until show ends");
  });

  it("post-endTime: batch transfer works freely", async function () {
    await time.increaseTo(ctx.datesConfig.endTime + 1);
    await expect(
      ticket.connect(buyer).safeBatchTransferFrom(buyer.address, signers[9].address, [0], [1], "0x")
    ).to.not.be.reverted;
  });

  it("setMarketplaceApproval reverts from non-ADMIN", async function () {
    await expect(
      ticket.connect(signers[5]).setMarketplaceApproval(marketplace.address, true)
    ).to.be.reverted;
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("XAOTicket — ERC-2981 Royalties", function () {
  let signers, ctx, ticket, buyer;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    ctx     = await deployShow(signers, { ticketsEnabled: true });
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    ticket  = await getTicketContract(ctx.show);
    buyer   = signers[6];

    await addDefaultTier(ticket, ctx.p1); // party1=50%, party2=30%, reseller=20%
    await ctx.usdc.mint(buyer.address, USDC(100));
    await ctx.usdc.connect(buyer).approve(await ticket.getAddress(), USDC(100));
    await ticket.connect(buyer).buyTicket(0);
  });

  it("receiver is the ShowContract address", async function () {
    const [receiver] = await ticket.royaltyInfo(0, USDC(100));
    expect(receiver).to.equal(await ctx.show.getAddress());
  });

  it("royalty amount = (party1BPS + party2BPS) / 10000 * salePrice", async function () {
    // party1=5000, party2=3000 → total=8000 BPS = 80%
    const [, amount] = await ticket.royaltyInfo(0, USDC(100));
    const expected   = USDC(100) * 8_000n / 10_000n;
    expect(amount).to.equal(expected);
  });

  it("royaltyInfo reverts for invalid tokenId", async function () {
    await expect(ticket.royaltyInfo(999, USDC(100))).to.be.revertedWith("Invalid token");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("XAOTicket — Access Control", function () {
  let signers, ctx, ticket, scanner;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    ctx     = await deployShow(signers, { ticketsEnabled: true });
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    ticket  = await getTicketContract(ctx.show);
    scanner = signers[7];
  });

  it("party1 can grant SCANNER_ROLE", async function () {
    const SCANNER_ROLE = await ticket.SCANNER_ROLE();
    await ticket.connect(ctx.p1).grantRole(SCANNER_ROLE, scanner.address);
    expect(await ticket.hasRole(SCANNER_ROLE, scanner.address)).to.equal(true);
  });

  it("party1 can revoke SCANNER_ROLE", async function () {
    const SCANNER_ROLE = await ticket.SCANNER_ROLE();
    await ticket.connect(ctx.p1).grantRole(SCANNER_ROLE, scanner.address);
    await ticket.connect(ctx.p1).revokeRole(SCANNER_ROLE, scanner.address);
    expect(await ticket.hasRole(SCANNER_ROLE, scanner.address)).to.equal(false);
  });

  it("non-ADMIN cannot grant SCANNER_ROLE", async function () {
    const SCANNER_ROLE = await ticket.SCANNER_ROLE();
    await expect(
      ticket.connect(signers[5]).grantRole(SCANNER_ROLE, scanner.address)
    ).to.be.reverted;
  });

  it("ADMIN_ROLE can pause and unpause the ticket contract", async function () {
    await ticket.connect(ctx.p1).pause();
    await ctx.usdc.mint(signers[6].address, USDC(100));
    await ctx.usdc.connect(signers[6]).approve(await ticket.getAddress(), USDC(100));
    await addDefaultTier(ticket, ctx.p1);
    await expect(ticket.connect(signers[6]).buyTicket(0)).to.be.reverted;

    await ticket.connect(ctx.p1).unpause();
    await expect(ticket.connect(signers[6]).buyTicket(0)).to.not.be.reverted;
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("XAOTicket — Fee Verification (Spec Checklist)", function () {
  let signers, ctx, ticket, buyer;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    ctx     = await deployShow(signers, { ticketsEnabled: true, salesTaxBPS: 800 });
    await signBoth(ctx.show, ctx.p1, ctx.p2);
    ticket  = await getTicketContract(ctx.show);
    buyer   = signers[6];

    await addDefaultTier(ticket, ctx.p1, { priceUSDC: USDC(50) });
    await ctx.usdc.mint(buyer.address, USDC(10_000));
    await ctx.usdc.connect(buyer).approve(await ticket.getAddress(), USDC(10_000));
  });

  it("2% protocol fee is sent to TREASURY on every sale", async function () {
    const before = await ctx.usdc.balanceOf(ctx.treasury.address);
    await ticket.connect(buyer).buyTicket(0);
    const expected2pct = USDC(50) * 200n / 10_000n;
    expect(await ctx.usdc.balanceOf(ctx.treasury.address) - before).to.be.gte(expected2pct);
  });

  it("$1 gas allotment is deducted on every sale", async function () {
    const before = await ctx.usdc.balanceOf(ctx.treasury.address);
    await ticket.connect(buyer).buyTicket(0);
    const treasuryReceived = await ctx.usdc.balanceOf(ctx.treasury.address) - before;
    // treasury receives xaoFee + gas = 2% of 50 USDC + $1 = 1 USDC + 1 USDC = 2 USDC
    expect(treasuryReceived).to.equal(USDC(50) * 200n / 10_000n + USDC(1));
  });

  it("net to parties = gross - xaoFee - gasAllotment", async function () {
    const gross    = USDC(50);
    const xaoFee   = gross * 200n / 10_000n;
    const gas      = USDC(1);
    const expected = gross - xaoFee - gas;

    const before = await ctx.show.escrowBalance();
    await ticket.connect(buyer).buyTicket(0);
    const after  = await ctx.show.escrowBalance();
    expect(after - before).to.equal(expected);
  });

  it("buyer's USDC balance decreases by exactly gross price", async function () {
    const before = await ctx.usdc.balanceOf(buyer.address);
    await ticket.connect(buyer).buyTicket(0);
    expect(before - await ctx.usdc.balanceOf(buyer.address)).to.equal(USDC(50));
  });

  it("total fees + net == gross (no USDC lost or created)", async function () {
    const gross  = USDC(50);
    const before = {
      treasury: await ctx.usdc.balanceOf(ctx.treasury.address),
      escrow:   await ctx.show.escrowBalance(),
      buyer:    await ctx.usdc.balanceOf(buyer.address),
    };
    await ticket.connect(buyer).buyTicket(0);
    const after = {
      treasury: await ctx.usdc.balanceOf(ctx.treasury.address),
      escrow:   await ctx.show.escrowBalance(),
      buyer:    await ctx.usdc.balanceOf(buyer.address),
    };
    const treasuryDelta = after.treasury - before.treasury;
    const escrowDelta   = after.escrow   - before.escrow;
    const buyerDelta    = before.buyer   - after.buyer;

    expect(buyerDelta).to.equal(gross);
    expect(treasuryDelta + escrowDelta).to.equal(gross);
  });
});
