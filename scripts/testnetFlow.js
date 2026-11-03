// scripts/testnetFlow.js
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * XAO Phase 2A end-to-end flow check.
 *
 * Runs the whole Phase 2A story against deployed contracts and prints PASS /
 * FAIL for every check: a tour with participation agreements, a standing
 * agreement, a show with ticket sales, an opener paid from ticket money,
 * linking shows into a tour (live and by confirmation), a staking container,
 * cancellation with refunds, disputes, a missed funding deadline, door
 * scanning, and the final payouts.
 *
 * On Base Sepolia it reads the addresses from
 *   deployments/baseSepolia-graph.json and deployments/baseSepolia-showbundle.json
 * and creates six throwaway wallets, funded with a little ETH from the deployer.
 * Shows are a few minutes long and the script waits for the real clock, so a run
 * takes about ten minutes. Most of the money checks use a test token on a
 * second ShowFactory deployed by this script, so they do not need real USDC. A
 * short smoke test also runs on the real ShowFactory with the real test USDC.
 *
 * On the local Hardhat network it deploys everything in-process and skips the
 * waiting by moving the clock, which is a quick rehearsal.
 *
 * Usage:
 *   npx hardhat run scripts/testnetFlow.js                        (local rehearsal)
 *   npx hardhat run scripts/testnetFlow.js --network baseSepolia
 */

const { ethers } = hre;
const LOCAL = ["hardhat", "localhost"].includes(hre.network.name);

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const U = (n) => ethers.parseUnits(String(n), 6);
const Z32 = ethers.ZeroHash;
const ZA = ethers.ZeroAddress;
const MAX64 = (1n << 64n) - 1n;

const EdgeType = { HAS_MODULE: 0, CHILD_OF: 1, PARENTS: 2, APPLIES_TO: 3 };
const EdgeStatus = { None: 0, Pending: 1, Active: 2, Inactive: 3 };
const ShowStatus = { Offer: 0, Signed: 1, Active: 2, InDispute: 3, Completed: 4, Cancelled: 5, Expired: 6 };
const EscrowStatus = { Active: 0, Refunding: 1, Completed: 2 };

const ETH_PER_WALLET = "0.003";
const REAL_USDC_FOR_SMOKE = U("2.2");

// ─── REPORTING ───────────────────────────────────────────────────────────────
const results = [];
let txCount = 0;

function check(label, ok, detail = "") {
  results.push({ label, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

function eq(label, actual, expected) {
  check(label, actual.toString() === expected.toString(), `got ${actual}, want ${expected}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tx(promise) {
  const sent = await promise;
  const receipt = await sent.wait();
  txCount++;
  return receipt;
}

async function send(makePromise, retries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await tx(makePromise());
    } catch (e) {
      const text = String(e.shortMessage || e.message || e);
      const transient = /429|timeout|ETIMEDOUT|ECONNRESET|rate limit|nonce|replacement|network|socket/i.test(text);
      if (!transient || attempt >= retries) throw e;
      console.log(`  (retrying after: ${text.slice(0, 80)})`);
      await sleep(3000 * attempt);
    }
  }
}

// The raw revert data, wherever this provider put it.
function revertData(e) {
  const candidates = [e.data, e.data && e.data.data, e.info && e.info.error && e.info.error.data, e.error && e.error.data];
  for (const c of candidates) if (typeof c === "string" && c.startsWith("0x")) return c;
  const m = String(e.message || "").match(/return data: (0x[0-9a-fA-F]+)/);
  return m ? m[1] : "";
}

// Passes when the call reverts with the named custom error (none of ours take arguments),
// recognised by name or by its four-byte selector.
async function expectRevert(label, promise, errorName) {
  try {
    await promise;
    check(label, false, "did not revert");
  } catch (e) {
    const named = (e.revert && e.revert.name) || e.errorName || "";
    const text = String(e.shortMessage || e.message || e);
    const selector = errorName ? ethers.id(`${errorName}()`).slice(0, 10) : "";
    const ok = !errorName || named === errorName || text.includes(`'${errorName}`) || revertData(e).startsWith(selector);
    check(label, ok, `reverted: ${named || (ok && errorName) || text.slice(0, 80)}`);
  }
}

async function section(name, fn) {
  console.log(`\n== ${name} ==`);
  try {
    await fn();
  } catch (e) {
    check(`${name}: finished without an error`, false, String(e.shortMessage || e.message || e).slice(0, 300));
  }
}

// ─── CHAIN HELPERS ───────────────────────────────────────────────────────────
async function chainNow() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

async function waitUntil(ts, label) {
  if ((await chainNow()) >= ts) return;
  if (LOCAL) {
    const { time } = require("@nomicfoundation/hardhat-network-helpers");
    await time.increaseTo(ts);
    return;
  }
  console.log(`  ...waiting for ${label} (${ts - (await chainNow())}s)`);
  while ((await chainNow()) < ts) {
    await sleep(4000);
  }
}

function findEvent(receipt, contract, name) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.target.toLowerCase()) continue;
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === name) return parsed;
    } catch (e) {
      // not an event of this contract
    }
  }
  throw new Error(`event ${name} not found`);
}

const at = (name, address) => ethers.getContractAt(name, address);

// ─── SHOW CONFIG ─────────────────────────────────────────────────────────────
// o: { t0, name, partyA, partyB, doors, start, end, tickets, price, funding,
//      payoutRules, sweep: { recipients, bps }, backend }
function buildConfig(o) {
  const sweep = { recipients: o.sweep.recipients, bps: o.sweep.bps, notBefore: o.end };
  const partyBShare = o.partyB
    ? sweep.recipients.reduce((sum, r, i) => (r === o.partyB.address ? sum + sweep.bps[i] : sum), 0)
    : 0;

  return {
    showId: Z32,
    partyA: { wallet: o.partyA.address, role: 0, xaoUsername: "venue" },
    partyB: { wallet: o.partyB ? o.partyB.address : ZA, role: 1, xaoUsername: "" },
    dates: {
      announcementDate: o.t0,
      eventStartDate: o.start,
      eventEndDate: 0,
      loadInTime: o.doors - 600,
      doorsOpenTime: o.doors,
      showStartTime: o.start,
      showEndTime: o.end,
      setTime: o.start,
      setLengthMinutes: 60,
      ticketsSaleDate: o.t0,
    },
    location: { venueName: "Flow Test Venue", venueAddress: "1 Test St", radiusMiles: 50, radiusDays: 7 },
    tickets: {
      ticketsEnabled: !!o.tickets,
      totalCapacity: 100,
      salesTaxBPS: 0,
      compTickets: 0,
      resalePartyABPS: 500,
      resalePartyBBPS: 500,
      resaleResellerBPS: 9_000,
    },
    financials: {
      guaranteeUSDC: 0,
      guaranteePctBPS: 0,
      backendBPS: o.backend !== undefined ? o.backend : partyBShare,
      barSplitBPS: 0,
      merchSplitBPS: 0,
    },
    promo: {
      eventName: o.name,
      flyerDNSLink: "ipns://flow",
      flyerCIDHash: ethers.id("flyer-" + o.name),
      riderIPFSCID: "ipfs://rider",
      ticketLegal: "ipfs://ticket-legal",
      genres: ["test"],
    },
    anchors: {
      legalTextHash: ethers.id("legal"),
      legalTextCID: "ipfs://legal",
      termsHash: ethers.id("terms-" + o.name),
      termsCID: "ipfs://terms-" + o.name,
      showMetaHash: ethers.id("meta-" + o.name),
      showMetaCID: "ipfs://meta-" + o.name,
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
    tiers: o.tickets
      ? [{
          ticketType: 2,
          customName: "General Admission",
          priceUSDC: o.price,
          quantity: 100,
          onSaleTimestamp: 0,
          partyAResaleBPS: 500,
          partyBResaleBPS: 500,
          resellerBPS: 9_000,
          image: "ipfs://ga",
        }]
      : [],
    funding: o.funding || [],
    payoutRules: o.payoutRules || [],
    sweep,
    cancelRules: [{ notAfter: MAX64, payBpsToPartyA: 10_000, payBpsToPartyB: 0, treasuryBps: 0 }],
    defaultCancelRefundBps: 10_000,
  };
}

async function createShow(factory, signer, o) {
  const receipt = await send(() => factory.connect(signer).createShow(buildConfig(o)));
  const ev = findEvent(receipt, factory, "ShowCreated");
  return {
    show: await at("ShowInstance", ev.args.showInstance),
    escrow: await at("EventEscrow", ev.args.escrow),
    ticket: ev.args.ticketContract === ZA ? null : await at("XAOTicketV2", ev.args.ticketContract),
    validator: ev.args.entryValidator === ZA ? null : await at("EntryValidator", ev.args.entryValidator),
  };
}

async function signBoth(show, a, b) {
  await send(() => show.connect(a).signTerms());
  await send(() => show.connect(b).signTerms());
}

// ─── INFRASTRUCTURE ──────────────────────────────────────────────────────────
async function deploy(name, args = []) {
  const f = await ethers.getContractFactory(name);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  return c;
}

async function loadInfra(deployer) {
  if (!LOCAL) {
    const graph = JSON.parse(fs.readFileSync(path.join("deployments", `${hre.network.name}-graph.json`), "utf8"));
    const bundle = JSON.parse(fs.readFileSync(path.join("deployments", `${hre.network.name}-showbundle.json`), "utf8"));
    return {
      registry: await at("GraphRegistry", graph.graphRegistry),
      tourFactory: await at("TourFactory", graph.tourFactory),
      agreementFactory: await at("StandingAgreementFactory", graph.standingAgreementFactory),
      stakingFactory: await at("StakingParentFactory", graph.stakingParentFactory),
      prodFactory: await at("ShowFactory", bundle.showFactory),
      prodToken: await at("MockERC20", bundle.usdcAddress),   // only the ERC-20 calls are used
      impls: [bundle.showInstanceImplementation, bundle.eventEscrowImplementation, bundle.ticketImplementation, bundle.entryValidatorImplementation],
      treasury: bundle.treasuryAddress,
      realUsdc: true,
    };
  }

  const registry = await deploy("GraphRegistry");
  const tpa = await deploy("TourParticipationAgreement");
  const shell = await deploy("TourShell");
  const tourFactory = await deploy("TourFactory", [shell.target, tpa.target, registry.target]);
  const agreement = await deploy("StandingAgreement");
  const agreementFactory = await deploy("StandingAgreementFactory", [agreement.target]);
  const staking = await deploy("StakingParent");
  const stakingFactory = await deploy("StakingParentFactory", [staking.target, registry.target]);
  const prodToken = await deploy("MockERC20", ["USD Coin", "USDC", 6]);
  const impls = [
    (await deploy("ShowInstance")).target,
    (await deploy("EventEscrow")).target,
    (await deploy("XAOTicketV2")).target,
    (await deploy("EntryValidator")).target,
  ];
  const prodFactory = await deploy("ShowFactory", [deployer.address, registry.target, prodToken.target, deployer.address, ...impls]);
  return { registry, tourFactory, agreementFactory, stakingFactory, prodFactory, prodToken, impls, treasury: deployer.address, realUsdc: false };
}

async function makeWallets(deployer) {
  const names = ["venue", "artist", "band", "fan", "agent", "outsider"];
  if (LOCAL) {
    const signers = await ethers.getSigners();
    return Object.fromEntries(names.map((n, i) => [n, signers[i + 1]]));
  }
  const wallets = {};
  for (const n of names) {
    wallets[n] = ethers.Wallet.createRandom().connect(ethers.provider);
    await send(() => deployer.sendTransaction({ to: wallets[n].address, value: ethers.parseEther(ETH_PER_WALLET) }));
  }
  return wallets;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\nXAO Phase 2A flow check on ${hre.network.name}${LOCAL ? " (local rehearsal)" : ""}`);
  console.log(`Deployer: ${deployer.address}`);

  const I = await loadInfra(deployer);
  const W = await makeWallets(deployer);
  const { venue, artist, band, fan, agent, outsider } = W;
  const treasury = I.treasury;

  // A test token and a second ShowFactory using it, so the money checks need no real USDC.
  const token = await deploy("MockERC20", ["Test USD", "tUSD", 6]);
  const testFactory = await deploy("ShowFactory", [deployer.address, I.registry.target, token.target, treasury, ...I.impls]);
  await send(() => token.mint(fan.address, U(500)));
  console.log(`Test token:   ${token.target}`);
  console.log(`Test factory: ${testFactory.target}`);

  const t0 = await chainNow();
  const T = { doors: t0 + 480, start: t0 + 500, end: t0 + 540, later: t0 + 900 };
  const balance = async (who, tok = token) => tok.balanceOf(typeof who === "string" ? who : who.address);
  const registry = I.registry;
  const shows = {};

  // ── Tour and participation agreements ──
  let shell, tpa1, tpa2;
  await section("Tour and participation agreements", async () => {
    const tourId = ethers.id("flow-tour-" + t0);
    const metaHash = ethers.id("tour-meta");
    const derived = await I.tourFactory.deriveTourId(venue.address, tourId, "ipfs://tour", metaHash);
    const predicted = await I.tourFactory.predictTourShell(derived);

    const r = await send(() => I.tourFactory.connect(venue).createTourShell(tourId, "ipfs://tour", metaHash));
    shell = await at("TourShell", findEvent(r, I.tourFactory, "TourShellCreated").args.tourShell);
    eq("tour shell is deployed at the predicted address", shell.target, predicted);
    eq("the venue owns the tour", await shell.owner(), venue.address);

    const mk = async (party) => {
      const rr = await send(() => shell.connect(venue).createTourParticipationAgreement({
        partyB: party.address, termsHash: ethers.id("tpa-" + party.address), termsCID: "ipfs://tpa",
        effectiveFrom: 0, effectiveTo: 0, metaHash: Z32, metaCID: "", supersedes: ZA,
      }));
      return at("TourParticipationAgreement", findEvent(rr, shell, "TPACreated").args.tpa);
    };
    tpa1 = await mk(artist);
    tpa2 = await mk(band);

    await send(() => tpa1.connect(venue).sign());
    await send(() => tpa1.connect(artist).sign());
    eq("participation agreement is Active once both sign", await tpa1.status(), 1);

    await send(() => tpa2.connect(band).terminate("ipfs://leaving"));
    eq("a band can end its own agreement alone", await tpa2.status(), 2);
    eq("the other band's agreement is untouched", await tpa1.status(), 1);

    const edge = await registry.computeEdgeId(shell.target, tpa1.target, EdgeType.PARENTS, Z32);
    eq("shell -> agreement edge is Active", await registry.edgeStatus(edge), EdgeStatus.Active);
  });

  // ── Standing agreement ──
  let agreement;
  await section("Standing agreement", async () => {
    const r = await send(() => I.agreementFactory.connect(artist).createAgreement({
      partyA: artist.address, partyB: agent.address, kind: 2, effectiveFrom: 0, effectiveTo: 0,
      termsHash: ethers.id("agent-deal-" + t0), termsCID: "ipfs://agent", supersedes: ZA,
      streams: [{ stream: 0, splits: [{ recipient: agent.address, bps: 1_000 }, { recipient: artist.address, bps: 9_000 }] }],
      flatPayments: [], flags: [],
    }));
    agreement = await at("StandingAgreement", findEvent(r, I.agreementFactory, "AgreementCreated").args.agreement);
    await send(() => agreement.connect(artist).sign());
    await send(() => agreement.connect(agent).sign());
    eq("standing agreement is Active once both sign", await agreement.status(), 1);
    eq("agent's cut is stored on-chain", (await agreement.getStreamSplits(0))[0].bps, 1_000);
    check("agreement is in effect", await agreement.isInEffect());
  });

  // ── Create the shows ──
  await section("Create and sign the shows", async () => {
    const headlinerPayout = [{ to: artist.address, kind: 0, value: U(50), notBefore: T.end, isGuarantee: true }];

    // Backend must match the artist's share of the sweep.
    await expectRevert("a show whose backend disagrees with its sweep is rejected",
      testFactory.connect(venue).createShow.staticCall(buildConfig({
        t0, name: "bad-backend", partyA: venue, partyB: artist, doors: T.doors, start: T.start, end: T.end, tickets: false,
        sweep: { recipients: [venue.address, artist.address], bps: [7_000, 3_000] }, backend: 100,
      })), "BackendMismatch");

    shows.M = await createShow(testFactory, venue, {
      t0, name: "main-" + t0, partyA: venue, partyB: artist, doors: T.doors, start: T.start, end: T.end,
      tickets: true, price: U(26), payoutRules: headlinerPayout,
      sweep: { recipients: [venue.address, artist.address], bps: [7_000, 3_000] },
    });
    shows.O = await createShow(testFactory, venue, {
      t0, name: "opener-" + t0, partyA: venue, partyB: band, doors: T.doors, start: T.start, end: T.end,
      tickets: false, funding: [{ byTime: t0 + 400, minFunded: U(20) }],
      payoutRules: [{ to: band.address, kind: 0, value: U(20), notBefore: T.end, isGuarantee: true }],
      sweep: { recipients: [venue.address], bps: [10_000] },
    });
    shows.X = await createShow(testFactory, outsider, {
      t0, name: "other-" + t0, partyA: outsider, partyB: agent, doors: T.doors, start: T.start, end: T.later,
      tickets: false, sweep: { recipients: [outsider.address], bps: [10_000] },
    });
    shows.E = await createShow(testFactory, venue, {
      t0, name: "unfunded-" + t0, partyA: venue, partyB: artist, doors: T.doors, start: T.start, end: T.later,
      tickets: false, funding: [{ byTime: t0 + 240, minFunded: U(20) }],
      payoutRules: [{ to: artist.address, kind: 0, value: U(20), notBefore: T.later, isGuarantee: true }],
      sweep: { recipients: [venue.address], bps: [10_000] },
    });

    await signBoth(shows.M.show, venue, artist);
    await signBoth(shows.O.show, venue, band);
    await signBoth(shows.X.show, outsider, agent);
    await signBoth(shows.E.show, venue, artist);
    eq("main show is Signed", await shows.M.show.status(), ShowStatus.Signed);

    for (const [label, mod] of [["escrow", shows.M.escrow], ["ticket contract", shows.M.ticket], ["entry validator", shows.M.validator]]) {
      const id = await registry.computeEdgeId(shows.M.show.target, mod.target, EdgeType.HAS_MODULE, Z32);
      eq(`factory registered the ${label} as a module, Active`, await registry.edgeStatus(id), EdgeStatus.Active);
    }
    await expectRevert("an outsider cannot register itself as a show's module",
      registry.connect(outsider).registerEdge.staticCall(shows.M.show.target, outsider.address, EdgeType.HAS_MODULE, Z32, ""),
      "NotAuthorized");
  });

  // ── Graph: tour links, agreement, staking ──
  await section("Graph links", async () => {
    // The tour owner is a party on the main show, so the link is live at once.
    await send(() => registry.connect(venue).registerEdges([
      { from: tpa1.target, to: shows.M.show.target, edgeType: EdgeType.PARENTS, metaHash: Z32, metaCID: "" },
      { from: shows.M.show.target, to: tpa1.target, edgeType: EdgeType.CHILD_OF, metaHash: Z32, metaCID: "" },
    ]));
    for (const [label, from, to, type] of [
      ["agreement -> show", tpa1.target, shows.M.show.target, EdgeType.PARENTS],
      ["show -> agreement", shows.M.show.target, tpa1.target, EdgeType.CHILD_OF],
    ]) {
      eq(`tour owner on the show: ${label} is Active at once`,
        await registry.edgeStatus(await registry.computeEdgeId(from, to, type, Z32)), EdgeStatus.Active);
    }

    // The tour owner is not a party on show X, so its parties must confirm.
    await send(() => shell.connect(venue).linkShowToTPA(tpa1.target, shows.X.show.target, Z32, ""));
    const pId = await registry.computeEdgeId(tpa1.target, shows.X.show.target, EdgeType.PARENTS, Z32);
    const cId = await registry.computeEdgeId(shows.X.show.target, tpa1.target, EdgeType.CHILD_OF, Z32);
    eq("tour owner not on the show: link is Pending", await registry.edgeStatus(pId), EdgeStatus.Pending);
    await expectRevert("the tour owner cannot confirm the link for the show",
      registry.connect(venue).confirmEdge.staticCall(pId), "NothingToConfirm");
    for (const id of [pId, cId]) {
      await send(() => registry.connect(outsider).confirmEdge(id));
      await send(() => registry.connect(agent).confirmEdge(id));
    }
    eq("link is Active after the show's parties confirm", await registry.edgeStatus(pId), EdgeStatus.Active);

    // A standing agreement applies to the main show once everyone confirms.
    const aId = await registry.computeEdgeId(agreement.target, shows.M.show.target, EdgeType.APPLIES_TO, Z32);
    await send(() => registry.connect(artist).registerEdge(agreement.target, shows.M.show.target, EdgeType.APPLIES_TO, Z32, ""));
    eq("agreement applies: Pending until all parties confirm", await registry.edgeStatus(aId), EdgeStatus.Pending);
    eq("three parties must confirm (artist is on both sides)", (await registry.getRequiredConfirmersForEdge(aId)).length, 3);
    await send(() => registry.connect(agent).confirmEdge(aId));
    await send(() => registry.connect(venue).confirmEdge(aId));
    eq("agreement applies: Active after everyone confirms", await registry.edgeStatus(aId), EdgeStatus.Active);

    // Staking container with the main show as a child.
    const r = await send(() => I.stakingFactory.connect(venue).createStakingParent(venue.address, 0, Z32, "ipfs://staking"));
    const sp = await at("StakingParent", findEvent(r, I.stakingFactory, "StakingParentCreated").args.stakingParent);
    await send(() => sp.connect(venue).registerChild(shows.M.show.target, true, Z32, ""));
    eq("staking child is not linked until the show's parties confirm", await sp.isChildLinked(shows.M.show.target), false);
    const sId = await registry.computeEdgeId(sp.target, shows.M.show.target, EdgeType.PARENTS, Z32);
    await send(() => registry.connect(venue).confirmEdge(sId));
    await send(() => registry.connect(artist).confirmEdge(sId));
    eq("staking child is linked after they confirm", await sp.isChildLinked(shows.M.show.target), true);
  });

  // ── Cancellation with refunds ──
  await section("Cancellation refunds the buyers", async () => {
    const C = await createShow(testFactory, venue, {
      t0, name: "cancelled-" + t0, partyA: venue, partyB: artist, doors: T.doors, start: T.start, end: T.later,
      tickets: true, price: U(26), sweep: { recipients: [venue.address], bps: [10_000] },
    });
    await signBoth(C.show, venue, artist);
    await send(() => token.connect(fan).approve(C.ticket.target, U(52)));
    await send(() => C.ticket.connect(fan).buyTicket(0));
    await send(() => C.ticket.connect(fan).buyTicket(0));
    const before = await balance(fan);
    await send(() => C.escrow.connect(venue).cancel());
    eq("escrow is refunding", await C.escrow.status(), EscrowStatus.Refunding);
    eq("show is Cancelled", await C.show.status(), ShowStatus.Cancelled);
    await send(() => C.escrow.connect(outsider).continueRefunds(10));
    eq("buyer gets everything back except the $1 per ticket", (await balance(fan)) - before, U(50));
    check("refunded tickets are burned", !(await C.ticket.exists(1)));
    await send(() => C.escrow.connect(outsider).finalizeCancellationPayout());
    eq("cancelled escrow is closed", await C.escrow.status(), EscrowStatus.Completed);
  });

  // ── Dispute ──
  await section("Dispute freezes and resumes", async () => {
    const D = await createShow(testFactory, venue, {
      t0, name: "disputed-" + t0, partyA: venue, partyB: artist, doors: T.doors, start: T.start, end: T.later,
      tickets: false, sweep: { recipients: [venue.address], bps: [10_000] },
    });
    await signBoth(D.show, venue, artist);
    await send(() => D.escrow.connect(artist).raiseDispute());
    check("show is frozen by the dispute", await D.show.isFrozen());
    check("dispute has a 30 day deadline", (await D.escrow.disputeDeadline()) > 0n);
    await send(() => D.escrow.connect(artist).resolveDispute(1));
    check("one vote does not settle it", await D.show.isFrozen());
    await send(() => D.escrow.connect(venue).resolveDispute(1));
    check("both voting to resume lifts the freeze", !(await D.show.isFrozen()));
    eq("escrow carries on", await D.escrow.status(), EscrowStatus.Active);
  });

  // ── Real ShowFactory with the real payout token ──
  await section("Smoke test on the real ShowFactory and token", async () => {
    if (I.realUsdc) {
      await send(() => I.prodToken.connect(deployer).transfer(fan.address, REAL_USDC_FOR_SMOKE));
    } else {
      await send(() => I.prodToken.mint(fan.address, REAL_USDC_FOR_SMOKE));
    }
    const R = await createShow(I.prodFactory, venue, {
      t0, name: "real-usdc-" + t0, partyA: venue, partyB: artist, doors: T.doors, start: T.start, end: T.later,
      tickets: true, price: U(2), sweep: { recipients: [venue.address], bps: [10_000] },
    });
    await signBoth(R.show, venue, artist);
    await send(() => I.prodToken.connect(fan).approve(R.ticket.target, U(2)));
    const before = await balance(fan, I.prodToken);
    await send(() => R.ticket.connect(fan).buyTicket(0));
    eq("$1 reaches the escrow, $1 goes to the treasury", await balance(R.escrow.target, I.prodToken), U(1));
    await send(() => R.escrow.connect(venue).cancel());
    await send(() => R.escrow.connect(venue).continueRefunds(5));
    eq("buyer is refunded $1 of the $2", (await balance(fan, I.prodToken)) - (before - U(2)), U(1));
    await send(() => R.escrow.connect(venue).finalizeCancellationPayout());
    eq("escrow is empty and closed", await balance(R.escrow.target, I.prodToken), 0);
  });

  // ── Opener funded from ticket money ──
  const snap = {};
  await section("Ticket sales fund the headliner and the opener", async () => {
    await send(() => shows.M.escrow.connect(venue).linkAgreement(shows.O.escrow.target));
    eq("opener is linked to the main show", (await shows.M.escrow.getLinkedAgreements())[0], shows.O.escrow.target);
    eq("opener knows its parent", await shows.O.escrow.parentEscrow(), shows.M.escrow.target);
    await expectRevert("only the organizer can link an opener",
      shows.M.escrow.connect(artist).linkAgreement.staticCall(shows.O.escrow.target), "NotOrganizer");

    for (const [n, w] of Object.entries({ artist, venue, band })) snap[n] = await balance(w);
    snap.treasury = await balance(treasury);

    await send(() => token.connect(fan).approve(shows.M.ticket.target, U(104)));
    for (let i = 0; i < 4; i++) await send(() => shows.M.ticket.connect(fan).buyTicket(0));
    eq("four tickets sold", await shows.M.ticket.lastMintedId(), 4);
    await send(() => shows.M.escrow.connect(outsider).allocate());
    eq("the opener's $20 is set aside from ticket money", await shows.M.escrow.earmarkOf(shows.O.escrow.target), U(20));
    eq("the headliner's $50 is still there: 97.92 free less 20 set aside", await shows.M.escrow.distributable(), U("77.92"));
    eq("opener needs nothing more", await shows.O.escrow.fundingNeed(), 0);
  });

  // ── Doors open: scanning and a missed deadline ──
  await section("Door scanning and a missed funding deadline", async () => {
    await waitUntil(t0 + 245, "the unfunded show's deadline");
    await send(() => shows.E.escrow.connect(outsider).cancelForMissedFunding(0));
    eq("a show missing its funding deadline is cancelled", await shows.E.show.status(), ShowStatus.Cancelled);
    eq("the main show carries on", await shows.M.show.status(), ShowStatus.Signed);

    await waitUntil(T.doors + 2, "doors to open");
    check("first scan grants entry", await shows.M.validator.connect(venue).scanTicket.staticCall(1, Z32));
    await send(() => shows.M.validator.connect(venue).scanTicket(1, Z32));
    check("ticket is marked scanned", await shows.M.ticket.isScanned(1));
    check("a second scan is not accepted", !(await shows.M.validator.connect(venue).scanTicket.staticCall(1, Z32)));
    await expectRevert("a scanned ticket cannot be moved before the show ends",
      shows.M.ticket.connect(fan).safeTransferFrom.staticCall(fan.address, outsider.address, 1, 1, "0x"), "TransfersLocked");
    await expectRevert("a stranger cannot raise a dispute",
      shows.M.escrow.connect(outsider).raiseDispute.staticCall(), "NotAParty");
  });

  // ── Show ends: payouts ──
  await section("Payouts after the show", async () => {
    await waitUntil(T.end + 3, "the show to end");
    // Anyone may close the show, and it must still pay the headliner's guarantee first.
    await send(() => shows.M.escrow.connect(outsider).executeFinalSweep());
    eq("main escrow is closed by the sweep", await shows.M.escrow.status(), EscrowStatus.Completed);
    eq("main show is Completed", await shows.M.show.status(), ShowStatus.Completed);

    await send(() => shows.O.escrow.connect(outsider).executeAvailablePayouts());
    await send(() => shows.O.escrow.connect(outsider).executeFinalSweep());
    eq("opener show is Completed", await shows.O.show.status(), ShowStatus.Completed);
    await expectRevert("a closed show cannot be disputed",
      shows.M.escrow.connect(artist).raiseDispute.staticCall(), "NotActive");

    const d = async (n, w) => (await balance(w)) - snap[n];
    eq("artist: $50 guarantee + 30% of the leftover", await d("artist", artist), U("58.376"));
    eq("band: opener guarantee $20", await d("band", band), U(20));
    eq("venue: 70% of the leftover", await d("venue", venue), U("19.544"));
    eq("treasury: $4 gas + 2% on four tickets", await d("treasury", treasury), U("6.08"));
    const total = (await d("artist", artist)) + (await d("band", band)) + (await d("venue", venue)) + (await d("treasury", treasury));
    eq("every dollar the fan paid is accounted for", total, U(104));
    eq("main escrow is empty", await balance(shows.M.escrow.target), 0);
    eq("opener escrow is empty", await balance(shows.O.escrow.target), 0);
  });

  // ── Summary ──
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed, ${txCount} transactions.`);
  if (failed.length) {
    console.log("Failed:");
    for (const f of failed) console.log(`  - ${f.label}`);
  }

  if (!LOCAL) {
    const file = path.join("deployments", `${hre.network.name}-flow.json`);
    fs.writeFileSync(file, JSON.stringify({
      ranAt: new Date().toISOString(),
      testToken: token.target,
      testFactory: testFactory.target,
      tourShell: shell && shell.target,
      standingAgreement: agreement && agreement.target,
      shows: Object.fromEntries(Object.entries(shows).map(([k, v]) => [k, { show: v.show.target, escrow: v.escrow.target }])),
      wallets: Object.fromEntries(Object.entries(W).map(([k, v]) => [k, { address: v.address, privateKey: v.privateKey }])),
    }, null, 2));
    console.log(`Addresses and the throwaway wallets (testnet only) saved to ${file}`);
  }

  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error("Flow check crashed:", e.shortMessage || e.message || e);
  process.exit(1);
});
