// scripts/closeMint.js
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Close Mint Window Script
 * 
 * Usage:
 *   npx hardhat run scripts/closeMint.js --network base
 */

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

const log = {
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  warning: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  header: (msg) => console.log(`\n${colors.bright}${colors.cyan}═══ ${msg} ═══${colors.reset}\n`),
};

async function main() {
  log.header("🛑 Close Mint Window");

  try {
    const network = hre.network.name;
    const deploymentFile = path.join("deployments", `${network}-deployment.json`);

    if (!fs.existsSync(deploymentFile)) {
      log.error("No deployment found!");
      process.exit(1);
    }

    const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
    const contractAddress = deployment.address;

    log.info(`Network: ${colors.bright}${network}${colors.reset}`);
    log.info(`Contract: ${colors.bright}${contractAddress}${colors.reset}`);

    const contract = await hre.ethers.getContractAt(
      deployment.contract,
      contractAddress
    );

    // ============================================
    // GET CURRENT STATUS
    // ============================================

    const isOpen = await contract.mintWindowOpen();
    const supply = await contract.totalSupply();
    const isActive = await contract.isMintActive();

    log.header("📋 Current Status");
    log.info(`Window Open: ${isOpen ? colors.green + "YES" : colors.yellow + "NO"}${colors.reset}`);
    log.info(`Currently Active: ${isActive ? colors.green + "YES" : colors.yellow + "NO"}${colors.reset}`);
    log.info(`Supply: ${colors.bright}${supply}${colors.reset} / 10000`);

    if (!isOpen) {
      log.warning("Mint window is already closed!");
      process.exit(0);
    }

    // ============================================
    // CLOSE WINDOW
    // ============================================

    log.header("🔒 Closing Mint Window");
    log.info("Sending transaction...");

    const tx = await contract.closeMintWindow();
    log.info(`Transaction: ${colors.cyan}${tx.hash}${colors.reset}`);

    const receipt = await tx.wait();
    log.success(`Mint window closed! (Block ${receipt.blockNumber})`);

    // ============================================
    // VERIFY
    // ============================================

    const newStatus = await contract.mintWindowOpen();
    if (!newStatus) {
      log.success("✓ Verified: Mint window is now closed");
    } else {
      log.error("Verification failed!");
      process.exit(1);
    }

    // ============================================
    // FINAL STATS
    // ============================================

    log.header("✅ Mint Window Closed");

    const finalSupply = await contract.totalSupply();
    const remaining = await contract.getRemainingSupply();

    console.log(`
${colors.bright}Final Stats:${colors.reset}
  Minted: ${finalSupply} / 10000
  Remaining: ${remaining}
  Percentage: ${((finalSupply / 10000) * 100).toFixed(2)}%

${colors.bright}Next Step:${colors.reset}
  Freeze metadata to finalize collection:
  ${colors.cyan}npx hardhat run scripts/freezeMetadata.js --network ${network}${colors.reset}
    `);

  } catch (error) {
    log.error(error.message);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

// ============================================
// freezeMetadata.js - Add to same file or separate
// ============================================

/**
 * Freeze Metadata Script
 * 
 * Usage:
 *   npx hardhat run scripts/freezeMetadata.js --network base
 */

async function freezeMetadata() {
  log.header("🔐 Freeze Metadata - PERMANENT");

  try {
    const network = hre.network.name;
    const deploymentFile = path.join("deployments", `${network}-deployment.json`);

    if (!fs.existsSync(deploymentFile)) {
      log.error("No deployment found!");
      process.exit(1);
    }

    const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
    const contractAddress = deployment.address;

    log.info(`Network: ${colors.bright}${network}${colors.reset}`);
    log.info(`Contract: ${colors.bright}${contractAddress}${colors.reset}`);

    const contract = await hre.ethers.getContractAt(
      deployment.contract,
      contractAddress
    );

    // ============================================
    // CHECK STATUS
    // ============================================

    const isFrozen = await contract.metadataFrozen();
    const supply = await contract.totalSupply();
    const isOpen = await contract.mintWindowOpen();

    log.header("📋 Pre-Freeze Check");
    log.info(`Metadata Already Frozen: ${isFrozen ? colors.green + "YES" : colors.yellow + "NO"}${colors.reset}`);
    log.info(`Current Supply: ${colors.bright}${supply}${colors.reset}} / 10000`);
    log.info(`Mint Window Open: ${isOpen ? colors.yellow + "YES - CLOSE IT FIRST!" : colors.green + "NO"}${colors.reset}`);

    if (isFrozen) {
      log.warning("Metadata is already frozen!");
      process.exit(0);
    }

    if (isOpen) {
      log.error("Mint window is still open! Close it first before freezing.");
      log.info(`Run: npx hardhat run scripts/closeMint.js --network ${network}`);
      process.exit(1);
    }

    // ============================================
    // WARNING
    // ============================================

    log.header("⚠️  WARNING - THIS IS PERMANENT!");

    console.log(`
${colors.red}${colors.bright}
╔════════════════════════════════════════════════════════════════════╗
║ METADATA FREEZE IS PERMANENT AND CANNOT BE UNDONE!                  ║
║                                                                    ║
║ After freezing:                                                     ║
║ • No metadata changes possible                                      ║
║ • No URI updates allowed                                            ║
║ • NFT attributes are immutable forever                              ║
║                                                                    ║
║ Current supply: ${supply.toString().padEnd(52)} ║
║                                                                    ║
║ Are you sure? This is your last chance to update metadata.         ║
╚════════════════════════════════════════════════════════════════════╝
${colors.reset}`);

    // ============================================
    // FREEZE
    // ============================================

    log.header("🔐 Freezing Metadata");
    log.info("Sending transaction...");

    const tx = await contract.freezeMetadata();
    log.info(`Transaction: ${colors.cyan}${tx.hash}${colors.reset}`);

    const receipt = await tx.wait();
    log.success(`Metadata frozen! (Block ${receipt.blockNumber})`);

    // ============================================
    // VERIFY
    // ============================================

    const newStatus = await contract.metadataFrozen();
    if (newStatus) {
      log.success("✓ Verified: Metadata is now permanently frozen");
    } else {
      log.error("Verification failed!");
      process.exit(1);
    }

    // ============================================
    // SUMMARY
    // ============================================

    log.header("✅ Metadata Frozen Successfully!");

    console.log(`
${colors.bright}Collection Finalized:${colors.reset}
  Minted: ${supply} / 10000
  Status: LOCKED & PERMANENT
  
Your XAO ETHDenver collection is now complete and immutable!

Next steps:
  • Enable trading on OpenSea
  • Share collection with community
  • Monitor secondary market activity
    `);

  } catch (error) {
    log.error(error.message);
    process.exit(1);
  }
}

// Export for use in other files if needed
module.exports = { main, freezeMetadata };
