// scripts/verifyShowContracts.js
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

/**
 * XAO ShowContracts Verification Script
 *
 * Verifies deployed ShowContractFactory and individual ShowContracts on Basescan.
 *
 * Usage:
 *   npx hardhat run scripts/verifyShowContracts.js --network baseSepolia
 *   npx hardhat run scripts/verifyShowContracts.js --network base
 */

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  deploymentsDir: "deployments",

  blockExplorers: {
    base: "https://basescan.org",
    baseSepolia: "https://sepolia.basescan.org",
  },
};

// ============================================
// UTILITY FUNCTIONS
// ============================================

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
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
  section: (msg) => console.log(`\n${colors.bright}${msg}${colors.reset}`),
};

/**
 * Format address for display
 */
function formatAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Format ether value
 */
function formatEther(wei) {
  return hre.ethers.formatEther(wei);
}

/**
 * Get block explorer base URL for network
 */
function getBlockExplorerBase(network) {
  return CONFIG.blockExplorers[network] || CONFIG.blockExplorers.base;
}

/**
 * Attempt a verification and handle "Already verified" gracefully.
 * Returns: "verified" | "already" | "failed"
 */
async function tryVerify(address, constructorArguments, contractLabel) {
  log.info(`Verifying ${contractLabel}: ${colors.bright}${address}${colors.reset}`);
  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments,
    });
    log.success(`${contractLabel} verified on Basescan.`);
    return "verified";
  } catch (err) {
    const msg = err.message || "";
    if (
      msg.toLowerCase().includes("already verified") ||
      msg.toLowerCase().includes("already been verified")
    ) {
      log.warning(`${contractLabel} is already verified.`);
      return "already";
    }
    log.error(`${contractLabel} verification failed: ${msg}`);
    return "failed";
  }
}

// ============================================
// MAIN FUNCTION
// ============================================

async function main() {
  log.header("XAO ShowContracts Verification");

  const network = hre.network.name;
  const explorerBase = getBlockExplorerBase(network);

  log.info(`Network: ${colors.bright}${network}${colors.reset}`);

  // ============================================
  // 1. LOAD FACTORY DEPLOYMENT
  // ============================================

  log.section("Loading Factory Deployment");

  const factoryFile = path.join(CONFIG.deploymentsDir, `${network}-showfactory.json`);
  if (!fs.existsSync(factoryFile)) {
    log.error(`Factory deployment file not found: ${factoryFile}`);
    log.info(`Deploy the factory first: npx hardhat run scripts/deployShowContractFactory.js --network ${network}`);
    process.exit(1);
  }

  let factoryDeployment;
  try {
    factoryDeployment = JSON.parse(fs.readFileSync(factoryFile, "utf8"));
  } catch (err) {
    log.error(`Failed to parse ${factoryFile}: ${err.message}`);
    process.exit(1);
  }

  const factoryAddress = factoryDeployment.factoryAddress;
  log.success(`Factory address: ${colors.bright}${factoryAddress}${colors.reset}`);

  // ============================================
  // 2. VERIFY ShowContractFactory (no constructor args)
  // ============================================

  log.section("Verifying ShowContractFactory");

  const factoryResult = await tryVerify(factoryAddress, [], "ShowContractFactory");
  const factoryExplorerUrl = `${explorerBase}/address/${factoryAddress}#code`;
  log.info(`Explorer: ${colors.cyan}${factoryExplorerUrl}${colors.reset}`);

  // ============================================
  // 3. LOAD SHOW CONTRACTS LIST (if exists)
  // ============================================

  log.section("Loading ShowContracts List");

  const showContractsFile = path.join(CONFIG.deploymentsDir, `${network}-showcontracts.json`);

  if (!fs.existsSync(showContractsFile)) {
    log.warning(`No show contracts file found at: ${showContractsFile}`);
    log.info("No individual ShowContracts to verify yet.");
    log.info(`Create ShowContracts first: npx hardhat run scripts/createShowContract.js --network ${network}`);
  } else {
    let showContracts;
    try {
      showContracts = JSON.parse(fs.readFileSync(showContractsFile, "utf8"));
    } catch (err) {
      log.error(`Failed to parse ${showContractsFile}: ${err.message}`);
      showContracts = [];
    }

    log.info(`Found ${showContracts.length} ShowContract(s) in the list.`);

    // ============================================
    // 4. HANDLE ShowContract VERIFICATION
    // ============================================

    log.section("ShowContract Verification Notes");

    // NOTE: ShowContract has a large number of constructor arguments (10 parameters,
    // several of which are complex struct types). Programmatic verification of structs
    // is not reliably supported by the Hardhat verify plugin across all networks.
    // Each ShowContract should be verified manually via the Basescan UI or by running
    // the hardhat verify command with explicit --constructor-args.
    //
    // The factory creates each ShowContract via `new ShowContract(...)`, so the source
    // code and ABI are the same for all instances — only the constructor args differ.

    log.warning(
      "ShowContract instances have complex struct constructor args and are best verified individually."
    );
    log.info(
      "Use the Basescan UI 'Verify & Publish' flow, or construct a hardhat-verify arguments file."
    );
    console.log();

    for (let i = 0; i < showContracts.length; i++) {
      const entry = showContracts[i];
      const showAddr = entry.showContractAddress;
      const showExplorerUrl = `${explorerBase}/address/${showAddr}#code`;

      log.info(
        `[${i + 1}/${showContracts.length}] ShowContract: ${colors.bright}${showAddr}${colors.reset}`
      );
      log.info(`  Event:    ${entry.eventName || "N/A"}`);
      log.info(`  Party 1:  ${entry.party1 || "N/A"}`);
      log.info(`  Party 2:  ${entry.party2 || "N/A"}`);
      log.info(`  Explorer: ${colors.cyan}${showExplorerUrl}${colors.reset}`);
      log.warning(
        `  Skipping programmatic verification — verify manually on Basescan.`
      );
      console.log();
    }
  }

  // ============================================
  // 5. MANUAL VERIFICATION INSTRUCTIONS
  // ============================================

  log.section("Manual Verification Instructions for ShowContract");

  console.log(`
${colors.bright}To verify a ShowContract manually:${colors.reset}

  1. Open the contract on Basescan:
     ${colors.cyan}${explorerBase}/address/<SHOW_CONTRACT_ADDRESS>#code${colors.reset}

  2. Click "Verify & Publish"

  3. Select:
     - Compiler:  Solidity (Single file) or (Standard JSON)
     - Version:   Match your hardhat.solidity.version
     - License:   MIT

  4. Paste the flattened source:
     ${colors.cyan}npx hardhat flatten contracts/ShowContract.sol > ShowContract_flat.sol${colors.reset}

  5. Enter constructor arguments (ABI-encoded).
     You can generate ABI-encoded args with:
     ${colors.cyan}npx hardhat verify --network ${network} <SHOW_CONTRACT_ADDRESS> \\${colors.reset}
     ${colors.cyan}  --constructor-args arguments.js${colors.reset}

     Where arguments.js exports the array of constructor params:
     ${colors.dim}// arguments.js example
     // module.exports = [p1Config, p2Wallet, p2Role, datesConfig, locConfig,
     //                   ticketConfig, finConfig, promoConfig, usdcAddress, treasury];${colors.reset}
  `);

  // ============================================
  // 6. SUMMARY
  // ============================================

  log.header("Verification Complete");

  const factoryStatus =
    factoryResult === "verified"
      ? `${colors.green}Verified${colors.reset}`
      : factoryResult === "already"
      ? `${colors.yellow}Already verified${colors.reset}`
      : `${colors.red}Failed${colors.reset}`;

  console.log(`
${colors.bright}Results:${colors.reset}
  ShowContractFactory: ${factoryStatus}
  Address:             ${colors.bright}${factoryAddress}${colors.reset}
  Network:             ${network}
  Explorer:            ${colors.cyan}${factoryExplorerUrl}${colors.reset}
  Time:                ${new Date().toLocaleString()}
  `);
}

// ============================================
// RUN
// ============================================

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
