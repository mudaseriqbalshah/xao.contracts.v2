// Smoke test: ticket tiers are set BEFORE signing (while the show is DRAFT) and
// can never be added afterward. Run: npx hardhat run scripts/smokeTierFreeze.js
"use strict";
const { ethers } = require("hardhat");

const USDC = (n) => ethers.parseUnits(String(n), 6);
const DAY = 86400;
const PartyRole = { PROMOTER: 0, ARTIST: 1 };
const TicketType = { COMP: 0, PRESALE: 1, GA: 2, VIP: 3, CUSTOM: 4 };
const Status = { DRAFT: 0, PROPOSED: 1, COUNTER_PROPOSED: 2, APPROVED: 3 };

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

  // 1. Collection deployed at CREATE, show is DRAFT (nobody signed yet)
  const coll = await show.ticketCollection();
  assert(coll !== ethers.ZeroAddress, "ticketCollection deployed at create time");
  const ticket = await ethers.getContractAt("XAOTicket", coll);
  assert(Number(await show.status()) === Status.DRAFT, "show is DRAFT after create");

  const T = (type, price, qty) => [type, "", USDC(price), qty, now, 5000, 3000, 2000, "img"];

  // 2. party1 (ADMIN_ROLE) sets tiers while DRAFT — single + batch
  await (await ticket.connect(p1).addTier(...T(TicketType.GA, 45, 400))).wait();
  await (await ticket.connect(p1).addTiers([T(TicketType.VIP, 120, 100), T(TicketType.PRESALE, 30, 50)])).wait();
  assert((await ticket.tierCount()) === 3n, "party1 set 3 tiers before signing (addTier + batch addTiers)");

  // 3. party2 CANNOT add a tier (only ADMIN_ROLE / party1 may, and only in DRAFT)
  await expectRevert(ticket.connect(p2).addTier(...T(TicketType.GA, 10, 10)), "party2 addTier blocked");
  // 4. A stranger cannot add a tier
  await expectRevert(ticket.connect(buyer).addTier(...T(TicketType.GA, 1, 1)), "stranger addTier blocked");

  // 5. buyTicket before finalize is blocked
  await usdc.mint(buyer.address, USDC(1000));
  await usdc.connect(buyer).approve(coll, USDC(1000));
  await expectRevert(ticket.connect(buyer).buyTicket(0), "buyTicket blocked before signing");

  // 6. party1 signs -> status leaves DRAFT (PROPOSED)
  await (await show.connect(p1).sign()).wait();
  assert(Number(await show.status()) === Status.PROPOSED, "status PROPOSED after party1 signs");

  // 7. KEY: no more tiers can be added once signing has started — not even party1
  await expectRevert(ticket.connect(p1).addTier(...T(TicketType.GA, 5, 5)), "party1 addTier frozen after signing (not DRAFT)");
  assert((await ticket.tierCount()) === 3n, "tierCount stays 3 after party1 signs");

  // 8. party2 signs -> finalized; still frozen
  await (await show.connect(p2).sign()).wait();
  assert((await show.isFinalized()) === true, "finalized after both sign");
  await expectRevert(ticket.connect(p1).addTier(...T(TicketType.GA, 5, 5)), "addTier frozen after finalize too");

  // 9. buyTicket now works (finalized + on sale)
  await (await ticket.connect(buyer).buyTicket(0)).wait();
  assert((await ticket.totalSold()) === 1n, "buyTicket works after signing");

  console.log("\nALL SMOKE ASSERTIONS PASSED ✅");
}

main().catch((e) => { console.error(e); process.exit(1); });
