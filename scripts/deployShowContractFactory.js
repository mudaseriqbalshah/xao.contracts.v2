// scripts/deployShowContractFactory.js
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

/**
 * XAO ShowContractFactory Deployment Script
 *
 * Usage:
 *   Deploy to Base Sepolia (testnet):
 *   npx hardhat run scripts/deployShowContractFactory.js --network baseSepolia
 *
 *   Deploy to Base Mainnet:
 *   npx hardhat run scripts/deployShowContractFactory.js --network base
 */

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  contractName: "ShowContractFactory",
  deploymentsDir: "deployments",

  // Well-known USDC addresses (informational — factory itself is USDC-agnostic)
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

/**
 * Color codes for terminal output
 */
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
 * Save deployment info to file
 */
function saveDeploymentInfo(factoryAddress, deployer, network, chainId, txHash, blockNumber, usdcAddress, treasuryAddress) {
  ensureDeploymentsDir();

  const filename = path.join(CONFIG.deploymentsDir, `${network}-showfactory.json`);
  const deploymentInfo = {
    factoryAddress,
    deployer,
    network,
    chainId,
    deploymentTime: new Date().toISOString(),
    txHash,
    blockNumber,
    usdcAddress,
    treasuryAddress,
  };

  fs.writeFileSync(filename, JSON.stringify(deploymentInfo, null, 2));
  return filename;
}

// ============================================
// MAIN DEPLOYMENT FUNCTION
// ============================================

async function main() {
  log.header("XAO ShowContractFactory Deployment");

  try {
    // ============================================
    // 1. VALIDATE ENV VARS
    // ============================================

    log.section("Validating Environment");

    const privateKey = process.env.PRIVATE_KEY;
    const treasuryAddress = process.env.TREASURY_MULTISIG;

    if (!privateKey) {
      log.error("PRIVATE_KEY env var is not set.");
      log.info("Add PRIVATE_KEY=0x... to your .env file.");
      process.exit(1);
    }

    if (!treasuryAddress) {
      log.error("TREASURY_MULTISIG env var is not set.");
      log.info("Add TREASURY_MULTISIG=0x... to your .env file.");
      process.exit(1);
    }

    log.success("PRIVATE_KEY is set");
    log.success(`TREASURY_MULTISIG: ${colors.bright}${treasuryAddress}${colors.reset}`);

    // ============================================
    // 2. NETWORK & ACCOUNT SETUP
    // ============================================

    log.section("Deployment Configuration");

    const [deployer] = await hre.ethers.getSigners();
    const network = hre.network.name;
    const chainId = hre.network.config.chainId;
    const usdcAddress = CONFIG.usdcAddresses[network] || "N/A (not a known network)";

    log.info(`Network:   ${colors.bright}${network}${colors.reset}`);
    log.info(`Chain ID:  ${colors.bright}${chainId}${colors.reset}`);
    log.info(`Deployer:  ${colors.bright}${deployer.address}${colors.reset}`);
    log.info(`USDC:      ${colors.bright}${usdcAddress}${colors.reset} (informational)`);
    log.info(`Treasury:  ${colors.bright}${treasuryAddress}${colors.reset}`);

    // Get account balance
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    const balanceEth = formatEther(balance);
    log.info(`Balance:   ${colors.bright}${balanceEth} ETH${colors.reset}`);

    if (balance < hre.ethers.parseEther("0.01")) {
      log.warning("Low balance! You may not have enough ETH to cover deployment gas.");
    }

    // ============================================
    // 3. LOAD CONTRACT FACTORY
    // ============================================

    log.section("Loading Contract");

    let factory;
    try {
      factory = await hre.ethers.getContractFactory(CONFIG.contractName);
      log.success(`Contract factory loaded: ${CONFIG.contractName}`);
    } catch (err) {
      log.error(`Failed to load contract factory: ${err.message}`);
      log.info("Make sure you ran: npx hardhat compile");
      process.exit(1);
    }

    // ============================================
    // 3b. DEPLOY XAOTicketFactory (dependency)
    // ============================================
    // ShowContract no longer embeds XAOTicket's creation bytecode (EIP-170
    // size limit). Tickets are deployed via this external factory, whose
    // address is injected into ShowContractFactory's constructor and passed
    // down to every ShowContract it creates.

    log.section("Deploying XAOTicketFactory");
    log.info("This may take a moment...");

    const ticketFactoryCF = await hre.ethers.getContractFactory("XAOTicketFactory");
    const ticketFactoryTx = await ticketFactoryCF.deploy();
    const ticketFactoryDeployed = await ticketFactoryTx.waitForDeployment();
    const ticketFactoryAddress = await ticketFactoryDeployed.getAddress();
    log.success(`XAOTicketFactory deployed: ${colors.bright}${ticketFactoryAddress}${colors.reset}`);

    // ============================================
    // 4. DEPLOY ShowContractFactory (with ticket factory)
    // ============================================

    log.section("Deploying ShowContractFactory");
    log.info("This may take a moment...");

    const deployTx = await factory.deploy(ticketFactoryAddress);
    log.info(`Transaction sent: ${colors.cyan}${deployTx.deploymentTransaction().hash}${colors.reset}`);

    const deployed = await deployTx.waitForDeployment();
    const factoryAddress = await deployed.getAddress();
    const receipt = deployTx.deploymentTransaction();

    log.success("ShowContractFactory deployed!");
    log.info(`Address:     ${colors.bright}${factoryAddress}${colors.reset}`);
    log.info(`Block:       ${receipt.blockNumber}`);
    log.info(`Gas Limit:   ${receipt.gasLimit.toString()}`);

    // ============================================
    // 5. VERIFY ON-CHAIN CODE EXISTS
    // ============================================

    log.section("Verifying Deployment");

    const code = await hre.ethers.provider.getCode(factoryAddress);
    if (code === "0x") {
      log.error("Contract deployment failed — no code at address!");
      process.exit(1);
    }
    log.success("Contract code verified on chain");

    // ============================================
    // 6. SAVE DEPLOYMENT INFO
    // ============================================

    log.section("Saving Deployment Info");

    const deploymentFile = saveDeploymentInfo(
      factoryAddress,
      deployer.address,
      network,
      chainId,
      receipt.hash,
      receipt.blockNumber,
      usdcAddress,
      treasuryAddress
    );

    log.success(`Deployment info saved to: ${colors.bright}${deploymentFile}${colors.reset}`);

    // ============================================
    // 7. NEXT STEPS
    // ============================================

    log.section("Basescan Verification Command");
    const verifyCmd = `npx hardhat verify --network ${network} ${factoryAddress}`;
    console.log(`   ${colors.cyan}${verifyCmd}${colors.reset}\n`);

    log.section("Next Steps");

    log.info("1. Verify the factory on Basescan:");
    console.log(`   ${colors.cyan}${verifyCmd}${colors.reset}\n`);

    log.info("2. Create a ShowContract through the factory:");
    console.log(`   ${colors.cyan}npx hardhat run scripts/createShowContract.js --network ${network}${colors.reset}\n`);

    log.info("3. Verify individual ShowContracts (after creation):");
    console.log(`   ${colors.cyan}npx hardhat run scripts/verifyShowContracts.js --network ${network}${colors.reset}\n`);

    // ============================================
    // 8. SUMMARY
    // ============================================

    const explorerBase = getBlockExplorerBase(network);
    const explorerUrl = `${explorerBase}/address/${factoryAddress}`;

    log.header("Deployment Successful!");

    console.log(`
${colors.bright}Deployment Summary:${colors.reset}
  Contract:  ${CONFIG.contractName}
  Address:   ${colors.bright}${factoryAddress}${colors.reset}
  Network:   ${network}
  Chain ID:  ${chainId}
  USDC:      ${usdcAddress}
  Treasury:  ${treasuryAddress}
  Explorer:  ${colors.cyan}${explorerUrl}${colors.reset}
  Time:      ${new Date().toLocaleString()}
    `);

    return {
      factoryAddress,
      network,
      deployer: deployer.address,
    };

  } catch (err) {
    log.error("Deployment failed!");
    console.error(colors.red + err.message + colors.reset);

    if (err.message.includes("insufficient funds")) {
      log.info("You don't have enough ETH to deploy. Fund your wallet and try again.");
    } else if (err.message.includes("Contract does not exist")) {
      log.info("Run 'npx hardhat compile' first to compile the contracts.");
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
