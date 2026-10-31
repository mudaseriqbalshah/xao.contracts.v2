// test/helpers/show.js
// Shared setup for the show bundle tests.
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time }   = require("@nomicfoundation/hardhat-network-helpers");

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const USDC         = (n) => ethers.parseUnits(String(n), 6);
const ONE_DAY      = 86_400;
const ZERO_BYTES32 = ethers.ZeroHash;
const ZERO_ADDRESS = ethers.ZeroAddress;
const MAX_UINT64   = (1n << 64n) - 1n;

const PartyRole    = { PROMOTER: 0, ARTIST: 1, VENUE: 2, BOOKING_AGENT: 3, PRODUCTION: 4, OTHER: 5 };
const ShowStatus   = { Offer: 0, Signed: 1, Active: 2, InDispute: 3, Completed: 4, Cancelled: 5, Expired: 6 };
const EscrowStatus = { Active: 0, Refunding: 1, Completed: 2, Expired: 3 };
const PayoutKind   = { FixedAmount: 0, PercentageOfCurrentBalance: 1 };
const Resolution   = { None: 0, Resume: 1, ReleaseToPartyA: 2, ReleaseToPartyB: 3 };
const TicketType   = { COMP: 0, PRESALE: 1, GENERAL_ADMISSION: 2, VIP: 3, CUSTOM: 4 };
const EdgeType     = { HAS_MODULE: 0 };
const EdgeStatus   = { None: 0, Pending: 1, Active: 2, Inactive: 3 };

const TICKET_PRICE = USDC(50);
const GAS_FEE      = USDC(1);     // $1 → treasury at sale
const ESCROWED     = USDC(49);    // reaches the escrow per ticket
const XAO_FEE      = USDC(1);     // 2% of $50, held in escrow

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function tier(overrides = {}) {
  return {
    ticketType: TicketType.GENERAL_ADMISSION,
    customName: "General Admission",
    priceUSDC: TICKET_PRICE,
    quantity: 10,
    onSaleTimestamp: 0,
    partyAResaleBPS: 500,
    partyBResaleBPS: 500,
    resellerBPS: 9_000,
    image: "ipfs://ga",
    ...overrides,
  };
}

function edgeIdOf(from, to, edgeType) {
  return ethers.solidityPackedKeccak256(
    ["address", "address", "uint8", "bytes32"],
    [from, to, edgeType, ZERO_BYTES32]
  );
}

/// Deploys the registry, a token, the four implementations and the factory.
async function deploySystem(tokenName = "MockERC20") {
  const [owner, , , treasury] = await ethers.getSigners();

  const registry = await (await ethers.getContractFactory("GraphRegistry")).deploy();
  const usdc = tokenName === "MockERC20"
    ? await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6)
    : await (await ethers.getContractFactory(tokenName)).deploy();

  const showImpl      = await (await ethers.getContractFactory("ShowInstance")).deploy();
  const escrowImpl    = await (await ethers.getContractFactory("EventEscrow")).deploy();
  const ticketImpl    = await (await ethers.getContractFactory("XAOTicketV2")).deploy();
  const validatorImpl = await (await ethers.getContractFactory("EntryValidator")).deploy();

  const factory = await (await ethers.getContractFactory("ShowFactory")).deploy(
    owner.address, registry.target, usdc.target, treasury.address,
    showImpl.target, escrowImpl.target, ticketImpl.target, validatorImpl.target
  );
  await factory.waitForDeployment();

  return { registry, usdc, factory, showImpl, escrowImpl, ticketImpl, validatorImpl };
}

/// Builds a full ShowConfig. `t0` is the reference "now".
function showConfig(promoter, artist, t0, overrides = {}) {
  const showStart = t0 + 30 * ONE_DAY;
  const dates = {
    announcementDate: t0,
    eventStartDate:   showStart,
    eventEndDate:     0,
    loadInTime:       showStart - 3_600,
    doorsOpenTime:    showStart - 1_800,
    showStartTime:    showStart,
    showEndTime:      showStart + 7_200,
    setTime:          showStart,
    setLengthMinutes: 60,
    ticketsSaleDate:  t0,
    ...overrides.dates,
  };

  const sweep = overrides.sweep || {
    recipients: artist ? [promoter.address, artist.address] : [promoter.address],
    bps: artist ? [4_000, 6_000] : [10_000],
    notBefore: dates.showEndTime,
  };
  const partyBShare = artist
    ? sweep.recipients.reduce((sum, r, i) => (r === artist.address ? sum + (sweep.bps[i] || 0) : sum), 0)
    : 0;

  return {
    showId: ZERO_BYTES32,
    partyA: { wallet: promoter.address, role: PartyRole.PROMOTER, xaoUsername: "promoter1" },
    partyB: { wallet: artist ? artist.address : ZERO_ADDRESS, role: PartyRole.ARTIST, xaoUsername: "notmine" },
    dates,
    location: { venueName: "Test Venue", venueAddress: "123 Main St", radiusMiles: 50, radiusDays: 7 },
    tickets: {
      ticketsEnabled: true,
      totalCapacity: 100,
      salesTaxBPS: 800,
      compTickets: 5,
      resalePartyABPS: 500,
      resalePartyBBPS: 500,
      resaleResellerBPS: 9_000,
      ...overrides.tickets,
    },
    financials: {
      guaranteeUSDC: USDC(1_000),
      guaranteePctBPS: 0,
      backendBPS: partyBShare,   // partyB's share of the sweep, as the factory requires
      barSplitBPS: 0,
      merchSplitBPS: 0,
      ...overrides.financials,
    },
    promo: {
      eventName: "Test Show",
      flyerDNSLink: "ipns://flyer",
      flyerCIDHash: ethers.id("flyer"),
      riderIPFSCID: "ipfs://rider",
      ticketLegal: "ipfs://ticket-legal",
      genres: ["rock", "indie"],
    },
    anchors: {
      legalTextHash: ethers.id("legal"),
      legalTextCID: "ipfs://legal",
      termsHash: ethers.id("terms"),
      termsCID: "ipfs://terms",
      showMetaHash: ethers.id("meta"),
      showMetaCID: "ipfs://meta",
      ...overrides.anchors,
    },
    reputation: {
      ticketPurchaseRepEnabled: false,
      attendanceRepEnabled: false,
      ticketPurchaseDomainId: 0,
      attendanceDomainId: 0,
      ticketPurchaseRepAmount: 0,
      attendanceRepAmount: 0,
    },
    arbitrationEnabled: false,
    tiers: overrides.tiers || [tier()],
    funding: overrides.funding || [{ byTime: t0 + 10 * ONE_DAY, minFunded: USDC(1_000) }],
    payoutRules: overrides.payoutRules || [
      {
        to: artist ? artist.address : promoter.address,
        kind: PayoutKind.FixedAmount,
        value: USDC(500),
        notBefore: t0 + 15 * ONE_DAY,
        isGuarantee: true,
      },
    ],
    sweep,
    cancelRules: overrides.cancelRules || [
      { notAfter: t0 + 20 * ONE_DAY, payBpsToPartyA: 10_000, payBpsToPartyB: 0, treasuryBps: 0 },
      { notAfter: MAX_UINT64, payBpsToPartyA: 5_000, payBpsToPartyB: 4_000, treasuryBps: 1_000 },
    ],
    defaultCancelRefundBps: overrides.defaultCancelRefundBps ?? 10_000,
  };
}

async function createShow(factory, creator, cfg) {
  const receipt = await (await factory.connect(creator).createShow(cfg)).wait();
  const log = receipt.logs
    .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((l) => l && l.name === "ShowCreated");
  const a = log.args;
  return {
    showId:    a.showId,
    show:      await ethers.getContractAt("ShowInstance", a.showInstance),
    escrow:    await ethers.getContractAt("EventEscrow", a.escrow),
    ticket:    a.ticketContract === ZERO_ADDRESS ? null : await ethers.getContractAt("XAOTicketV2", a.ticketContract),
    validator: a.entryValidator === ZERO_ADDRESS ? null : await ethers.getContractAt("EntryValidator", a.entryValidator),
  };
}

module.exports = {
  USDC,
  ONE_DAY,
  ZERO_BYTES32,
  ZERO_ADDRESS,
  MAX_UINT64,
  PartyRole,
  ShowStatus,
  EscrowStatus,
  PayoutKind,
  Resolution,
  TicketType,
  EdgeType,
  EdgeStatus,
  TICKET_PRICE,
  GAS_FEE,
  ESCROWED,
  XAO_FEE,
  tier,
  edgeIdOf,
  deploySystem,
  showConfig,
  createShow,
};
