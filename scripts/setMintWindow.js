// scripts/setMintWindow.js
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Set Mint Window Script
 * 
 * Usage:
 *   npx hardhat run scripts/setMintWindow.js --network base
 */

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

const log = {
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  warning: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  header: (msg) => console.log(`\n${colors.bright}${colors.cyan}═══ ${msg} ═══${colors.reset}\n`),
};

async function main() {
  log.header("🎵 XAO ETHDenver - Set Mint Window");

  try {
    const network = hre.network.name;
    const deploymentFile = path.join("deployments", `${network}-deployment.json`);

    // Load deployment info
    if (!fs.existsSync(deploymentFile)) {
      log.warning("No deployment found!");
      log.info(`Deploy contract first: npx hardhat run scripts/deploy.js --network ${network}`);
      process.exit(1);
    }

    const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
    const contractAddress = deployment.address;

    log.info(`Network: ${colors.bright}${network}${colors.reset}`);
    log.info(`Contract: ${colors.bright}${contractAddress}${colors.reset}`);

    // Load contract
    const contract = await hre.ethers.getContractAt(
      deployment.contract,
      contractAddress
    );

    log.info(`Contract loaded: ${deployment.contract}`);

    // ============================================
    // CONFIGURE MINT WINDOW TIMES
    // ============================================

    // ETHDenver 2025 dates - ADJUST THESE TO ACTUAL EVENT DATES
    const startDate = new Date("2026-02-14T20:40:00Z");  // Feb 28, 2025 8 AM UTC
    const endDate = new Date("2025-02-16T20:00:00Z");    // Mar 3, 2025 8 PM UTC

    const startTime = Math.floor(startDate.getTime() / 1000);
    const endTime = Math.floor(endDate.getTime() / 1000);

    // ============================================
    // DISPLAY WINDOW INFO
    // ============================================

    console.log("\n📅 Mint Window Configuration:\n");
    log.info(`Start: ${colors.bright}${startDate.toISOString()}${colors.reset}`);
    log.info(`End:   ${colors.bright}${endDate.toISOString()}${colors.reset}`);
    console.log(`
Duration: ${Math.floor((endTime - startTime) / 3600)} hours
Unix Start: ${startTime}
Unix End:   ${endTime}
    `);

    // Check if already set
    const currentStart = await contract.mintStartTime();
    if (currentStart.toString() !== "0") {
      log.warning("Mint window already set!");
      const currentEnd = await contract.mintEndTime();
      log.info(`Current: ${new Date(Number(currentStart) * 1000).toISOString()}`);
      log.info(`to      ${new Date(Number(currentEnd) * 1000).toISOString()}`);
    }

    // ============================================
    // SET MINT WINDOW
    // ============================================

    log.info("\n🔧 Setting mint window...");

    const tx = await contract.setMintWindow(startTime, endTime);
    log.info(`Transaction: ${colors.cyan}${tx.hash}${colors.reset}`);

    const receipt = await tx.wait();
    log.success(`Mint window set! (Block ${receipt.blockNumber})`);

    // ============================================
    // VERIFY
    // ============================================

    const isActive = await contract.isMintActive();
    const actualStart = await contract.mintStartTime();
    const actualEnd = await contract.mintEndTime();

    log.info("\n✓ Verification:");
    log.info(`Start Time: ${Number(actualStart)}`);
    log.info(`End Time:   ${Number(actualEnd)}`);
    log.info(`Active Now: ${isActive ? colors.green + "YES" : colors.yellow + "NO"} (will be active at start time)${colors.reset}`);

    // Save to file
    const windowFile = path.join("deployments", `${network}-mint-window.json`);
    fs.writeFileSync(
      windowFile,
      JSON.stringify(
        {
          startTime: startTime,
          endTime: endTime,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          setAt: new Date().toISOString(),
          txHash: tx.hash,
          blockNumber: receipt.blockNumber,
        },
        null,
        2
      )
    );

    log.success(`\nMint window info saved to: ${colors.bright}${windowFile}${colors.reset}`);

    log.header("✅ Mint Window Ready!");

  } catch (error) {
    console.error(`${colors.yellow}✗${colors.reset} Error:`, error.message);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
