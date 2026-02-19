// scripts/deploy.js
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

/**
 * XAO ETHDenver NFT Smart Contract Deployment Script
 * 
 * Usage:
 *   Deploy to Base Sepolia (testnet):
 *   npx hardhat run scripts/deploy.js --network baseSepolia
 * 
 *   Deploy to Base Mainnet:
 *   npx hardhat run scripts/deploy.js --network base
 */

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  // Get baseURI from environment or use default
  baseURI: process.env.BASE_URI || "https://ipfs.io/ipfs/bafybeihp6r7uehbi65zx4gfd2huer4sffgut5orcrpuzc53skzq26sobz4/",
  
  // Contract name
  contractName: "XAOETHDenverNFT_ERC721A",
  
  // Deployment info file
  deploymentsDir: "deployments",
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
 * Save deployment info to file
 */
function saveDeploymentInfo(address, deployer, network, baseURI, txHash, blockNumber) {
  ensureDeploymentsDir();
  
  const filename = path.join(CONFIG.deploymentsDir, `${network}-deployment.json`);
  const deploymentInfo = {
    contract: CONFIG.contractName,
    address: address,
    network: network,
    chainId: hre.network.config.chainId,
    deployer: deployer,
    baseURI: baseURI,
    deploymentTime: new Date().toISOString(),
    transactionHash: txHash,
    blockNumber: blockNumber,
    constructorArgs: [baseURI],
  };

  fs.writeFileSync(filename, JSON.stringify(deploymentInfo, null, 2));
  return filename;
}

/**
 * Get verification command
 */
function getVerificationCommand(network, address, baseURI) {
  return `npx hardhat verify --network ${network} ${address} "${baseURI}"`;
}

// ============================================
// MAIN DEPLOYMENT FUNCTION
// ============================================

async function main() {
  log.header("🎵 XAO ETHDenver NFT Deployment");

  try {
    // ============================================
    // 1. NETWORK & ACCOUNT SETUP
    // ============================================
    
    log.section("📋 Deployment Configuration");

    const [deployer] = await hre.ethers.getSigners();
    const network = hre.network.name;
    const chainId = hre.network.config.chainId;

    log.info(`Network: ${colors.bright}${network}${colors.reset}`);
    log.info(`Chain ID: ${colors.bright}${chainId}${colors.reset}`);
    log.info(`Deployer: ${colors.bright}${deployer.address}${colors.reset}`);

    // Get account balance
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    const balanceEth = formatEther(balance);

    log.info(`Account Balance: ${colors.bright}${balanceEth} ETH${colors.reset}`);

    // Validate balance
    if (balance < hre.ethers.parseEther("0.1")) {
      log.warning("Low balance! You may not have enough for deployment + testing.");
    }

    // ============================================
    // 2. VALIDATE CONFIGURATION
    // ============================================

    log.section("✔ Validating Configuration");

    // Check if baseURI is set
    if (!CONFIG.baseURI || CONFIG.baseURI.includes("QmXXXXXX")) {
      log.warning("baseURI not properly set!");
      log.info("Set BASE_URI in .env file or it will use placeholder");
      log.info("Example: BASE_URI=https://ipfs.io/ipfs/QmYourHash/");
    }

    log.info(`Base URI: ${colors.dim}${CONFIG.baseURI}${colors.reset}`);

    // ============================================
    // 3. GET CONTRACT FACTORY
    // ============================================

    log.section("📦 Loading Contract");

    let contract;
    try {
      contract = await hre.ethers.getContractFactory(CONFIG.contractName);
      log.success(`Contract factory loaded: ${CONFIG.contractName}`);
    } catch (error) {
      log.error(`Failed to load contract factory: ${error.message}`);
      log.info("Make sure you ran: npx hardhat compile");
      process.exit(1);
    }

    // ============================================
    // 4. DEPLOY CONTRACT
    // ============================================

    log.section("🚀 Deploying Contract");
    log.info("This may take a moment...");

    const deployTx = await contract.deploy(CONFIG.baseURI);
    log.info(`Transaction sent: ${colors.cyan}${deployTx.deploymentTransaction().hash}${colors.reset}`);

    const deployed = await deployTx.waitForDeployment();
    const contractAddress = await deployed.getAddress();
    const receipt = deployTx.deploymentTransaction();

    log.success(`Contract deployed!`);
    log.info(`Address: ${colors.bright}${contractAddress}${colors.reset}`);
    log.info(`Block: ${receipt.blockNumber}`);
    log.info(`Gas Used: ${receipt.gasLimit.toString()}`);

    // ============================================
    // 5. VERIFY CONTRACT DETAILS
    // ============================================

    log.section("✓ Verifying Deployment");

    // Check that contract is deployed
    const code = await hre.ethers.provider.getCode(contractAddress);
    if (code === "0x") {
      log.error("Contract deployment failed - no code at address!");
      process.exit(1);
    }

    log.success("Contract code verified on chain");

    // Get contract info
    const name = await deployed.name();
    const symbol = await deployed.symbol();
    const maxSupply = await deployed.MAX_SUPPLY();
    const baseURIStored = await deployed.baseURI();

    log.info(`Name: ${colors.bright}${name}${colors.reset}`);
    log.info(`Symbol: ${colors.bright}${symbol}${colors.reset}`);
    log.info(`Max Supply: ${colors.bright}${maxSupply.toString()}${colors.reset}`);
    log.info(`Stored Base URI: ${colors.dim}${baseURIStored}${colors.reset}`);

    // ============================================
    // 6. SAVE DEPLOYMENT INFO
    // ============================================

    log.section("💾 Saving Deployment Info");

    const deploymentFile = saveDeploymentInfo(
      contractAddress,
      deployer.address,
      network,
      CONFIG.baseURI,
      receipt.hash,
      receipt.blockNumber
    );

    log.success(`Deployment info saved to: ${colors.bright}${deploymentFile}${colors.reset}`);

    // ============================================
    // 7. DISPLAY VERIFICATION COMMAND
    // ============================================

    log.section("🔍 Next Steps");

    log.info("1. Verify on Basescan:");
    const verifyCmd = getVerificationCommand(network, contractAddress, CONFIG.baseURI);
    console.log(`   ${colors.cyan}${verifyCmd}${colors.reset}\n`);

    log.info("2. Set mint window:");
    console.log(`   ${colors.cyan}npx hardhat run scripts/setMintWindow.js --network ${network}${colors.reset}\n`);

    log.info("3. Test mint:");
    console.log(`   ${colors.cyan}npx hardhat run scripts/testMint.js --network ${network}${colors.reset}\n`);

    log.info("4. Check status anytime:");
    console.log(`   ${colors.cyan}npx hardhat run scripts/status.js --network ${network}${colors.reset}\n`);

    // ============================================
    // 8. SAVE QUICK REFERENCE
    // ============================================

    log.section("📝 Quick Reference");

    const quickRef = {
      network: network,
      contractAddress: contractAddress,
      contractName: CONFIG.contractName,
      deployer: deployer.address,
      baseURI: CONFIG.baseURI,
      blockExplorer: getBlockExplorer(network, contractAddress),
      verifyCommand: verifyCmd,
    };

    log.info(`Explorer: ${colors.cyan}${quickRef.blockExplorer}${colors.reset}`);
    log.info(`Save this address: ${colors.bright}${contractAddress}${colors.reset}`);

    // ============================================
    // 9. SUMMARY
    // ============================================

    log.header("✅ Deployment Successful!");

    console.log(`
${colors.bright}Deployment Summary:${colors.reset}
  Contract:  ${CONFIG.contractName}
  Address:   ${colors.bright}${contractAddress}${colors.reset}
  Network:   ${network}
  Explorer:  ${quickRef.blockExplorer}
  Time:      ${new Date().toLocaleString()}
    `);

    return {
      address: contractAddress,
      network: network,
      deployer: deployer.address,
      baseURI: CONFIG.baseURI,
    };

  } catch (error) {
    log.error(`Deployment failed!`);
    console.error(colors.red + error.message + colors.reset);
    
    if (error.message.includes("insufficient funds")) {
      log.info("You don't have enough ETH to deploy. Fund your wallet and try again.");
    } else if (error.message.includes("Contract does not exist")) {
      log.info("Run 'npx hardhat compile' first to compile the contracts.");
    }
    
    process.exit(1);
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get block explorer URL for network
 */
function getBlockExplorer(network, address) {
  const explorers = {
    base: "https://basescan.org/address/",
    baseSepolia: "https://sepolia.basescan.org/address/",
    localhost: "http://localhost:8545",
  };

  const baseUrl = explorers[network] || explorers.base;
  if (address) {
    return `${baseUrl}${address}`;
  }
  return baseUrl;
}

// ============================================
// RUN DEPLOYMENT
// ============================================

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
