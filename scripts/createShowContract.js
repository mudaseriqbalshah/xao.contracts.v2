// scripts/createShowContract.js
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

/**
 * XAO CreateShowContract Script
 *
 * Creates a single ShowContract through the already-deployed ShowContractFactory.
 *
 * Required env vars:
 *   PRIVATE_KEY         — deployer private key
 *   PARTY1_ADDRESS      — promoter/organizer wallet
 *   PARTY2_ADDRESS      — artist wallet
 *   TREASURY_MULTISIG   — XAO treasury address
 *
 * Optional env vars:
 *   USDC_ADDRESS        — override USDC address (defaults to network default)
 *   EVENT_NAME          — show name (default: "XAO Show")
 *   GUARANTEE_USDC      — flat guarantee in USDC dollars (default: 0)
 *
 * Usage:
 *   npx hardhat run scripts/createShowContract.js --network baseSepolia
 *   npx hardhat run scripts/createShowContract.js --network base
 */

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  deploymentsDir: "deployments",

  usdcAddresses: {
    base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    baseSepolia: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },

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
 * Create deployments directory if it doesn't exist
 */
function ensureDeploymentsDir() {
  if (!fs.existsSync(CONFIG.deploymentsDir)) {
    fs.mkdirSync(CONFIG.deploymentsDir, { recursive: true });
  }
}

/**
 * Get block explorer base URL for network
 */
function getBlockExplorerBase(network) {
  return CONFIG.blockExplorers[network] || CONFIG.blockExplorers.base;
}

/**
 * Load factory deployment file
 */
function loadFactoryDeployment(network) {
  const filename = path.join(CONFIG.deploymentsDir, `${network}-showfactory.json`);
  if (!fs.existsSync(filename)) {
    log.error(`Factory deployment file not found: ${filename}`);
    log.info(`Deploy the factory first: npx hardhat run scripts/deployShowContractFactory.js --network ${network}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

/**
 * Append a new ShowContract entry to the network's show-contracts JSON file
 */
function appendShowContract(network, entry) {
  ensureDeploymentsDir();
  const filename = path.join(CONFIG.deploymentsDir, `${network}-showcontracts.json`);

  let existing = [];
  if (fs.existsSync(filename)) {
    try {
      existing = JSON.parse(fs.readFileSync(filename, "utf8"));
    } catch (_) {
      existing = [];
    }
  }

  existing.push(entry);
  fs.writeFileSync(filename, JSON.stringify(existing, null, 2));
  return filename;
}

// ============================================
// MAIN FUNCTION
// ============================================

async function main() {
  log.header("XAO Create ShowContract");

  try {
    // ============================================
    // 1. VALIDATE ENV VARS
    // ============================================

    log.section("Validating Environment");

    const privateKey       = process.env.PRIVATE_KEY;
    const party1Address    = process.env.PARTY1_ADDRESS;
    const party2Address    = process.env.PARTY2_ADDRESS;
    const treasuryAddress  = process.env.TREASURY_MULTISIG;

    if (!privateKey) {
      log.error("PRIVATE_KEY env var is not set.");
      process.exit(1);
    }
    if (!party1Address) {
      log.error("PARTY1_ADDRESS env var is not set. This is the promoter/organizer wallet.");
      process.exit(1);
    }
    if (!party2Address) {
      log.error("PARTY2_ADDRESS env var is not set. This is the artist wallet.");
      process.exit(1);
    }
    if (!treasuryAddress) {
      log.error("TREASURY_MULTISIG env var is not set.");
      process.exit(1);
    }

    log.success("Required env vars validated");

    // ============================================
    // 2. NETWORK & ACCOUNT SETUP
    // ============================================

    log.section("Network Configuration");

    const [deployer] = await hre.ethers.getSigners();
    const network = hre.network.name;
    const chainId = hre.network.config.chainId;

    log.info(`Network:  ${colors.bright}${network}${colors.reset}`);
    log.info(`Chain ID: ${colors.bright}${chainId}${colors.reset}`);
    log.info(`Deployer: ${colors.bright}${deployer.address}${colors.reset}`);

    const balance = await hre.ethers.provider.getBalance(deployer.address);
    log.info(`Balance:  ${colors.bright}${formatEther(balance)} ETH${colors.reset}`);

    if (balance < hre.ethers.parseEther("0.005")) {
      log.warning("Low ETH balance — you may run out of gas.");
    }

    // ============================================
    // 3. RESOLVE OPTIONAL CONFIG
    // ============================================

    const usdcAddress   = process.env.USDC_ADDRESS || CONFIG.usdcAddresses[network];
    const eventName     = process.env.EVENT_NAME || "XAO Show";
    const guaranteeRaw  = process.env.GUARANTEE_USDC || "0";

    if (!usdcAddress) {
      log.error(`No USDC address known for network "${network}". Set USDC_ADDRESS env var.`);
      process.exit(1);
    }

    const guaranteeUSDC = hre.ethers.parseUnits(guaranteeRaw, 6); // 6 decimals

    log.info(`Party 1 (Promoter): ${colors.bright}${party1Address}${colors.reset}`);
    log.info(`Party 2 (Artist):   ${colors.bright}${party2Address}${colors.reset}`);
    log.info(`Treasury:           ${colors.bright}${treasuryAddress}${colors.reset}`);
    log.info(`USDC:               ${colors.bright}${usdcAddress}${colors.reset}`);
    log.info(`Event Name:         ${colors.bright}${eventName}${colors.reset}`);
    log.info(`Guarantee USDC:     ${colors.bright}${guaranteeRaw} USDC${colors.reset}`);

    // ============================================
    // 4. LOAD FACTORY
    // ============================================

    log.section("Loading Factory");

    const factoryDeployment = loadFactoryDeployment(network);
    const factoryAddress = factoryDeployment.factoryAddress;

    log.success(`Factory address: ${colors.bright}${factoryAddress}${colors.reset}`);

    const factory = await hre.ethers.getContractAt("ShowContractFactory", factoryAddress);

    // ============================================
    // 5. BUILD SHOW CONTRACT CONFIG STRUCTS
    // ============================================

    log.section("Building Show Config");

    // Dates: show starts 30 days from now, doors 1h before, ends 3h after
    const now = Math.floor(Date.now() / 1000);
    const thirtyDays = 30 * 24 * 60 * 60;
    const oneHour    = 60 * 60;
    const threeHours = 3 * 60 * 60;

    const showStart = now + thirtyDays;
    const doorsTime = showStart - oneHour;
    const showEnd   = showStart + threeHours;

    // PartyConfig for party1 (PROMOTER = role 0)
    const p1Config = {
      wallet: party1Address,
      role: 0, // PartyRole.PROMOTER
      xaoUsername: "",
    };

    // party2 args (ARTIST = role 1) passed separately per factory.create() signature
    const p2Wallet = party2Address;
    const p2Role   = 1; // PartyRole.ARTIST

    const datesConfig = {
      announcementDate:  now,
      eventStartDate:    showStart,
      eventEndDate:      showEnd,
      loadInTime:        doorsTime - oneHour,
      doorsTime:         doorsTime,
      startTime:         showStart,
      endTime:           showEnd,
      setTime:           showStart,
      setLengthMinutes:  60,
    };

    const locConfig = {
      venueName:    "",
      venueAddress: "",
      radiusMiles:  0,
      radiusDays:   0,
    };

    const ticketConfig = {
      ticketsEnabled: true,
      totalCapacity:  1000,
      salesTaxBPS:    0,
    };

    const finConfig = {
      guaranteeUSDC:   guaranteeUSDC,
      guaranteePctBPS: 0,
      backendBPS:      2000, // 20%
      barSplitBPS:     0,
      merchSplitBPS:   0,
    };

    const promoConfig = {
      eventName:       eventName,
      flyerDNSLink:    "",
      flyerCIDHash:    hre.ethers.ZeroHash,
      riderIPFSCID:    "",
      contractLegal:   "",
      ticketLegal:     "",
      contractCIDHash: hre.ethers.ZeroHash,
    };

    log.success("Config structs built");
    log.info(`Show start: ${new Date(showStart * 1000).toLocaleString()}`);
    log.info(`Doors:      ${new Date(doorsTime * 1000).toLocaleString()}`);
    log.info(`Show end:   ${new Date(showEnd * 1000).toLocaleString()}`);

    // ============================================
    // 6. CALL factory.create(...)
    // ============================================

    log.section("Creating ShowContract");
    log.info("Sending transaction to factory...");

    const tx = await factory.create(
      p1Config,
      p2Wallet,
      p2Role,
      datesConfig,
      locConfig,
      ticketConfig,
      finConfig,
      promoConfig,
      usdcAddress,
      treasuryAddress
    );

    log.info(`Transaction sent: ${colors.cyan}${tx.hash}${colors.reset}`);

    const receipt = await tx.wait();
    log.success("Transaction confirmed!");
    log.info(`Block: ${receipt.blockNumber}`);
    log.info(`Gas Used: ${receipt.gasUsed.toString()}`);

    // ============================================
    // 7. EXTRACT ShowContract ADDRESS FROM EVENT
    // ============================================

    log.section("Extracting ShowContract Address");

    const iface = factory.interface;
    let showContractAddress = null;

    for (const txLog of receipt.logs) {
      try {
        const parsed = iface.parseLog(txLog);
        if (parsed && parsed.name === "ShowContractCreated") {
          showContractAddress = parsed.args.contractAddr;
          break;
        }
      } catch (_) {
        // not a factory log — skip
      }
    }

    if (!showContractAddress) {
      log.error("Could not find ShowContractCreated event in receipt logs.");
      process.exit(1);
    }

    log.success(`ShowContract deployed at: ${colors.bright}${showContractAddress}${colors.reset}`);

    // ============================================
    // 8. SAVE TO deployments/{network}-showcontracts.json
    // ============================================

    log.section("Saving ShowContract Info");

    const entry = {
      showContractAddress,
      factoryAddress,
      party1: party1Address,
      party2: party2Address,
      eventName,
      network,
      chainId,
      deploymentTime: new Date().toISOString(),
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      usdcAddress,
      treasuryAddress,
      guaranteeUSDC: guaranteeRaw,
    };

    const savedFile = appendShowContract(network, entry);
    log.success(`Appended to: ${colors.bright}${savedFile}${colors.reset}`);

    // ============================================
    // 9. NEXT STEPS
    // ============================================

    const explorerBase = getBlockExplorerBase(network);
    const explorerUrl  = `${explorerBase}/address/${showContractAddress}`;

    log.section("Block Explorer");
    log.info(`ShowContract: ${colors.cyan}${explorerUrl}${colors.reset}`);

    log.section("Next Steps");

    log.info("1. Both parties sign the contract:");
    console.log(`   ${colors.dim}// Call showContract.sign() from both party1 and party2 wallets${colors.reset}\n`);

    log.info("2. Add ticket tiers (after signing):");
    console.log(`   ${colors.dim}// Call xaoTicket.addTier(...) from party1 wallet${colors.reset}\n`);

    log.info("3. Verify the ShowContract on Basescan:");
    console.log(`   ${colors.cyan}npx hardhat run scripts/verifyShowContracts.js --network ${network}${colors.reset}\n`);

    log.info("4. Check factory stats:");
    console.log(`   ${colors.dim}// factory.getContractCount() and factory.getUserContracts(address)${colors.reset}\n`);

    // ============================================
    // 10. SUMMARY
    // ============================================

    log.header("ShowContract Created Successfully!");

    console.log(`
${colors.bright}Summary:${colors.reset}
  ShowContract:  ${colors.bright}${showContractAddress}${colors.reset}
  Factory:       ${factoryAddress}
  Event:         ${eventName}
  Party 1:       ${party1Address}
  Party 2:       ${party2Address}
  Network:       ${network}
  Explorer:      ${colors.cyan}${explorerUrl}${colors.reset}
  Time:          ${new Date().toLocaleString()}
    `);

    return { showContractAddress, network };

  } catch (err) {
    log.error("Failed to create ShowContract!");
    console.error(colors.red + err.message + colors.reset);

    if (err.message.includes("insufficient funds")) {
      log.info("Fund your deployer wallet with ETH and try again.");
    } else if (err.message.includes("Zero party address")) {
      log.info("Check that PARTY1_ADDRESS and PARTY2_ADDRESS are valid non-zero addresses.");
    } else if (err.message.includes("Zero protocol address")) {
      log.info("Check that USDC_ADDRESS and TREASURY_MULTISIG are valid non-zero addresses.");
    }

    process.exit(1);
  }
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
