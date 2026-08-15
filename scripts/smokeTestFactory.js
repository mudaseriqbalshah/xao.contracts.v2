// Smoke test: create a ShowContract via the deployed factory and exercise the
// refactor (external ticket factory) + a Section-C setter (genres) on-chain.
const hre = require("hardhat");
const fs = require("fs");
require("dotenv").config();

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  console.log("Network:", net.name, Number(net.chainId), "| signer:", signer.address);

  const dep = JSON.parse(fs.readFileSync("deployments/baseSepolia-showfactory.json", "utf8"));
  const factoryAddr = dep.factoryAddress;
  console.log("Factory:", factoryAddr);

  const factory = await hre.ethers.getContractAt("ShowContractFactory", factoryAddr);
  const ticketFactoryFromFactory = await factory.ticketFactory();
  console.log("Factory.ticketFactory():", ticketFactoryFromFactory);

  const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const TREASURY = process.env.TREASURY_MULTISIG || signer.address;
  const ZERO32 = "0x" + "00".repeat(32);
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;

  const p1 = [signer.address, 0, "SmokePromoter"];            // PartyConfig
  const p2Wallet = "0x000000000000000000000000000000000000dEaD";
  const p2Role = 1;                                            // ARTIST
  const dates = [now, now + 30 * day, now + 30 * day, now + 30 * day, now + 30 * day, now + 30 * day, now + 30 * day + 3600, 0, 60];
  const loc = ["Smoke Venue", "1 Test St", 10, 5];
  const tickets = [true, 100, 800];                            // enabled, cap 100, 8% tax
  const fin = [1000000, 0, 500, 0, 0];                         // $1 guarantee, 5% backend
  const promo = ["Smoke Event", "ipfs://flyer", ZERO32, "rider", "legal", "ticketlegal", ZERO32];

  console.log("\n→ calling create() ...");
  const tx = await factory.create(p1, p2Wallet, p2Role, dates, loc, tickets, fin, promo, USDC, TREASURY);
  const rcpt = await tx.wait();
  console.log("  create() mined in block", rcpt.blockNumber);

  // Parse ShowContractCreated for the new address
  let showAddr;
  for (const log of rcpt.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed && parsed.name === "ShowContractCreated") { showAddr = parsed.args[0]; break; }
    } catch (_) {}
  }
  console.log("  New ShowContract:", showAddr);

  const show = await hre.ethers.getContractAt("ShowContract", showAddr);
  const [eventName, tf, status] = await Promise.all([show.eventName(), show.ticketFactory(), show.status()]);
  console.log("\nShowContract reads:");
  console.log("  eventName:", eventName);
  console.log("  ticketFactory():", tf, tf.toLowerCase() === ticketFactoryFromFactory.toLowerCase() ? "✓ matches factory" : "✗ MISMATCH");
  console.log("  status:", Number(status), "(0 = DRAFT)");

  console.log("\n→ testing setGenres/getGenres (Section-C setter) ...");
  const gtx = await show.setGenres(["Rock", "Jazz"]);
  await gtx.wait();
  const genres = await show.getGenres();
  console.log("  getGenres():", genres, Array.isArray(genres) && genres.length === 2 ? "✓" : "✗");

  console.log("\n→ testing setResaleSplits ...");
  const rtx = await show.setResaleSplits(3000, 3000, 4000);
  await rtx.wait();
  const [rp1, rp2, rr] = await Promise.all([show.resaleParty1BPS(), show.resaleParty2BPS(), show.resaleResellerBPS()]);
  console.log("  resale BPS:", Number(rp1), Number(rp2), Number(rr), (Number(rp1) === 3000 && Number(rr) === 4000) ? "✓" : "✗");

  console.log("\n✅ SMOKE TEST PASSED");
}

main().catch((e) => { console.error("✗ FAILED:", e.message || e); process.exit(1); });
