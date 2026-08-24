// Smoke test for the "tiers set at create, frozen after both sign" change.
// Run: npx hardhat run scripts/smokeTierFreeze.js
"use strict";
const { ethers } = require("hardhat");

const USDC = (n) => ethers.parseUnits(String(n), 6);
const DAY = 86400;
const PartyRole = { PROMOTER: 0, ARTIST: 1 };
const TicketType = { COMP: 0, PRESALE: 1, GA: 2, VIP: 3, CUSTOM: 4 };

function assert(cond, msg) { if (!cond) throw new Error("ASSERT FAILED: " + msg); console.log("  ok:", msg); }
async function expectRevert(p, label) {
  try { await p; throw new Error("did NOT revert: " + label); }
  catch (e) { if (String(e.message).includes("did NOT revert")) throw e; console.log("  ok (reverted):", label); }
}

async function main() {
  const [deployer, p1, p2, buyer, treasury] = await ethers.getSigners();
  const now = (await ethers.provider.getBlock("latest")).timestamp;

  const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
  await usdc.waitForDeployment();
  const ticketFactory = await (await ethers.getContractFactory("XAOTicketFactory")).deploy();
  await ticketFactory.waitForDeployment();

  const dates = {
    announcementDate: now, eventStartDate: now + 30 * DAY, eventEndDate: now + 30 * DAY,
    loadInTime: now + 30 * DAY - 3600, doorsTime: now + 30 * DAY - 1800, startTime: now + 30 * DAY,
    endTime: now + 30 * DAY + 7200, setTime: now + 30 * DAY, setLengthMinutes: 60,
  };
  const p1Config = { wallet: p1.address, role: PartyRole.PROMOTER, xaoUsername: "promoter1" };
  const loc = { venueName: "Venue", venueAddress: "123 Main", radiusMiles: 50, radiusDays: 7 };
  const tick = { ticketsEnabled: true, totalCapacity: 100, salesTaxBPS: 0 };
  const fin = { guaranteeUSDC: 0, guaranteePctBPS: 0, backendBPS: 0, barSplitBPS: 0, merchSplitBPS: 0 };
  const promo = {
    eventName: "Smoke Show", flyerDNSLink: "ipns://x", flyerCIDHash: ethers.zeroPadValue("0x01", 32),
    riderIPFSCID: "Qm", contractLegal: "legal", ticketLegal: "tlegal", contractCIDHash: ethers.zeroPadValue("0x02", 32),
  };

  const Show = await ethers.getContractFactory("ShowContract");
  const show = await Show.deploy(
    p1Config, p2.address, PartyRole.ARTIST, dates, loc, tick, fin, promo,
    usdc.target, treasury.address, ticketFactory.target,
  );
  await show.waitForDeployment();
  console.log("ShowContract:", show.target);

  // 1. Collection deployed at CREATE (not finalize)
  const coll = await show.ticketCollection();
  assert(coll !== ethers.ZeroAddress, "ticketCollection deployed at create time");
  const ticket = await ethers.getContractAt("XAOTicket", coll);
  assert((await show.isFinalized()) === false, "not finalized right after create");

  // 2. party1 (ADMIN_ROLE) can add a tier during negotiation
  await (await ticket.connect(p1).addTier(TicketType.GA, "", USDC(10), 50, now, 5000, 3000, 2000, "img1")).wait();
  assert((await ticket.tierCount()) === 1n, "party1 added tier during negotiation");

  // 3. party2 (via party2 check, no ADMIN_ROLE) can also add a tier during negotiation
  await (await ticket.connect(p2).addTier(TicketType.VIP, "", USDC(20), 25, now, 5000, 3000, 2000, "img2")).wait();
  assert((await ticket.tierCount()) === 2n, "party2 added tier during negotiation");

  // 4. A random third party cannot add a tier
  await expectRevert(ticket.connect(buyer).addTier(TicketType.GA, "", USDC(1), 1, now, 5000, 3000, 2000, ""), "stranger addTier blocked");

  // 5. buyTicket before finalize is blocked (contract not signed)
  await usdc.mint(buyer.address, USDC(1000));
  await usdc.connect(buyer).approve(coll, USDC(1000));
  await expectRevert(ticket.connect(buyer).buyTicket(0), "buyTicket blocked before signing");

  // 6. Both sign -> finalized
  await (await show.connect(p1).sign()).wait();
  await (await show.connect(p2).sign()).wait();
  assert((await show.isFinalized()) === true, "finalized after both sign");

  // 7. Tiers FROZEN after finalize (even party1 admin cannot add)
  await expectRevert(ticket.connect(p1).addTier(TicketType.GA, "", USDC(5), 5, now, 5000, 3000, 2000, ""), "party1 addTier frozen after sign");
  await expectRevert(ticket.connect(p2).addTier(TicketType.GA, "", USDC(5), 5, now, 5000, 3000, 2000, ""), "party2 addTier frozen after sign");
  assert((await ticket.tierCount()) === 2n, "tierCount stays 2 after finalize");

  // 8. buyTicket now works (finalized + on sale)
  await (await ticket.connect(buyer).buyTicket(0)).wait();
  assert((await ticket.totalSold()) === 1n, "buyTicket works after signing");

  // ── Scenario 2: tier change resets a prior signature ──────────────────
  console.log("\n-- Scenario 2: tier change resets signature --");
  const show2 = await Show.deploy(
    p1Config, p2.address, PartyRole.ARTIST, dates, loc, tick, fin, promo,
    usdc.target, treasury.address, ticketFactory.target,
  );
  await show2.waitForDeployment();
  const ticket2 = await ethers.getContractAt("XAOTicket", await show2.ticketCollection());

  // party1 signs first -> PROPOSED, party1 hasSigned = true
  await (await show2.connect(p1).sign()).wait();
  assert((await show2.status()) === 1n, "status PROPOSED after party1 signs");
  assert((await show2.hasSigned(p1.address)) === true, "party1 signed");

  // party2 adds a tier during negotiation -> resets party1's signature
  await (await ticket2.connect(p2).addTier(TicketType.GA, "", USDC(10), 10, now, 5000, 3000, 2000, "img")).wait();
  assert((await show2.hasSigned(p1.address)) === false, "party1 signature RESET after party2 tier change");
  assert((await show2.status()) === 2n, "status COUNTER_PROPOSED after party2 tier change");

  // party1 must re-sign, then party2 signs -> finalized
  await (await show2.connect(p1).sign()).wait();
  await (await show2.connect(p2).sign()).wait();
  assert((await show2.isFinalized()) === true, "finalized after re-sign + party2 sign");

  // ── Scenario 3: batch addTiers (one tx for many tiers) ────────────────
  console.log("\n-- Scenario 3: batch addTiers --");
  const show3 = await Show.deploy(
    p1Config, p2.address, PartyRole.ARTIST, dates, loc, tick, fin, promo,
    usdc.target, treasury.address, ticketFactory.target,
  );
  await show3.waitForDeployment();
  const ticket3 = await ethers.getContractAt("XAOTicket", await show3.ticketCollection());

  // TierInput = [ticketType, customName, priceUSDC, quantity, onSaleTimestamp,
  //              party1ResaleBPS, party2ResaleBPS, resellerBPS, image]
  const batch = [
    [TicketType.GA, "", USDC(45), 400, now, 5000, 3000, 2000, "img-ga"],
    [TicketType.VIP, "", USDC(120), 100, now, 5000, 3000, 2000, "img-vip"],
    [TicketType.PRESALE, "", USDC(30), 50, now, 5000, 3000, 2000, "img-pre"],
  ];
  await (await ticket3.connect(p1).addTiers(batch)).wait();
  assert((await ticket3.tierCount()) === 3n, "addTiers added 3 tiers in ONE tx");

  console.log("\nALL SMOKE ASSERTIONS PASSED ✅");
}

main().catch((e) => { console.error(e); process.exit(1); });
