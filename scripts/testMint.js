// scripts/testMint.js
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Test Mint Script
 * 
 * Usage:
 *   npx hardhat run scripts/testMint.js --network base
 */

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};

const log = {
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  warning: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  header: (msg) => console.log(`\n${colors.bright}${colors.cyan}═══ ${msg} ═══${colors.reset}\n`),
};

const PERSONA_NAMES = ["Hip Hop", "K-Pop", "Country", "Electronic", "Punk", "Classical", "Jazz"];

async function main() {
  log.header("🧪 Test Mint XAO ETHDenver NFT");

  try {
    const network = hre.network.name;
    const deploymentFile = path.join("deployments", `${network}-deployment.json`);

    if (!fs.existsSync(deploymentFile)) {
      log.error("No deployment found!");
      log.info(`Deploy contract first: npx hardhat run scripts/deploy.js --network ${network}`);
      process.exit(1);
    }

    const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
    const contractAddress = deployment.address;

    log.info(`Network: ${colors.bright}${network}${colors.reset}`);
    log.info(`Contract: ${colors.bright}${contractAddress}${colors.reset}`);

    // Get signer
    const [signer] = await hre.ethers.getSigners();
    log.info(`Minter: ${colors.bright}${signer.address}${colors.reset}`);

    // Load contract
    const contract = await hre.ethers.getContractAt(
      deployment.contract,
      contractAddress
    );

    // ============================================
    // CHECK MINT WINDOW
    // ============================================

    log.header("📋 Checking Mint Status");

    const isActive = await contract.isMintActive();
    log.info(`Mint Active: ${isActive ? colors.green + "YES" : colors.yellow + "NO"}`);

    if (!isActive) {
      log.warning("Mint window not active - setting test window...");
      
      const now = Math.floor(Date.now() / 1000);
      const startTime = now;
      const endTime = now + 86400; // 24 hours
      
      log.info(`Setting mint window for next 24 hours...`);
      const setTx = await contract.setMintWindow(startTime, endTime);
      await setTx.wait();
      log.success("Mint window set!");
    }

    // ============================================
    // CHECK WALLET MINT COUNT
    // ============================================

    const mintCount = await contract.getMintCount(signer.address);
    log.info(`Current wallet mints: ${colors.bright}${mintCount}${colors.reset}`);

    if (mintCount >= 10) {
      log.error("Wallet has reached max mint limit (10)!");
      process.exit(1);
    }

    const remainingMints = 10 - mintCount;
    log.info(`Remaining mints for wallet: ${colors.bright}${remainingMints}${colors.reset}`);

    // ============================================
    // PERFORM MINT
    // ============================================

    log.header("🎵 Minting NFT");

    const quantity = 1;
    log.info(`Minting ${colors.bright}${quantity}${colors.reset} NFT(s)...`);

    const mintTx = await contract.mint(quantity);
    log.info(`Transaction: ${colors.cyan}${mintTx.hash}${colors.reset}`);
    log.info(`Waiting for confirmation...`);

    const receipt = await mintTx.wait();
    log.success(`Mint successful! (Block ${receipt.blockNumber})`);
    log.info(`Gas used: ${receipt.gasUsed.toString()}`);

    // ============================================
    // GET MINTED TOKEN INFO
    // ============================================

    log.header("📊 NFT Traits");

    const totalSupply = await contract.totalSupply();
    const tokenId = totalSupply - 1; // Latest token

    log.info(`Token ID: ${colors.bright}#${tokenId.toString()}${colors.reset}`);

    // Get traits
    const traits = await contract.getTraits(tokenId);
    
    console.log(`\n${colors.bright}Trait Details:${colors.reset}`);
    log.info(`Persona: ${colors.bright}${PERSONA_NAMES[traits.persona]}${colors.reset}`);
    log.info(`Background: ${traits.background}`);
    log.info(`Head: ${traits.head}`);
    log.info(`Accessory: ${traits.accessory}`);
    log.info(`Accent: ${traits.accent}`);
    log.info(`Legendary: ${traits.legendary === 1 ? colors.green + "✨ YES" : "NO"}${colors.reset}`);
    log.info(`ETHDenver Slot: ${traits.ethDenverSlot} (0=BG, 1=Head, 2=Acc, 3=Accent)`);

    // ============================================
    // VERIFY OWNERSHIP
    // ============================================

    log.header("✓ Verification");

    const owner = await contract.ownerOf(tokenId);
    if (owner.toLowerCase() === signer.address.toLowerCase()) {
      log.success(`Token owner verified: ${colors.bright}${signer.address}${colors.reset}`);
    } else {
      log.error(`Token owner mismatch! Got: ${owner}`);
    }

    const balance = await contract.balanceOf(signer.address);
    log.info(`Wallet balance: ${colors.bright}${balance}${colors.reset} NFT(s)`);

    // ============================================
    // GET METADATA
    // ============================================

    log.header("📄 Metadata");

    try {
      const metadata = await contract.getMetadata(tokenId);
      const jsonStr = Buffer.from(
        metadata.replace("data:application/json;base64,", ""),
        "base64"
      ).toString();
      const parsed = JSON.parse(jsonStr);

      log.info(`Name: ${colors.bright}${parsed.name}${colors.reset}`);
      log.info(`Description: ${parsed.description}`);
      log.info(`Image: ${colors.cyan}${parsed.image}${colors.reset}`);
      
      if (parsed.attributes) {
        console.log(`\n${colors.bright}Attributes:${colors.reset}`);
        parsed.attributes.forEach((attr) => {
          console.log(`  • ${attr.trait_type}: ${colors.bright}${attr.value}${colors.reset}`);
        });
      }
    } catch (error) {
      log.warning("Could not decode metadata: " + error.message);
    }

    // ============================================
    // DISTRIBUTION STATUS
    // ============================================

    log.header("📊 Collection Status");

    const supply = await contract.totalSupply();
    const remaining = await contract.getRemainingSupply();
    const distribution = await contract.getPersonaStatus();

    log.info(`Total Minted: ${colors.bright}${supply}${colors.reset} / 10000`);
    log.info(`Remaining: ${colors.bright}${remaining}${colors.reset}`);

    console.log(`\n${colors.bright}Persona Distribution:${colors.reset}`);
    const targets = [220, 180, 160, 150, 130, 90, 70];
    for (let i = 0; i < 7; i++) {
      const minted = distribution[i];
      const target = targets[i] * 50; // Convert to actual numbers
      const pct = supply > 0 ? ((minted * 100) / supply).toFixed(1) : "0.0";
      const bar = "█".repeat(Math.floor(minted / 100)) + "░".repeat(Math.max(0, 10 - Math.floor(minted / 100)));
      log.info(`${PERSONA_NAMES[i].padEnd(12)} ${minted.toString().padStart(5)} (${pct}%) ${bar}`);
    }

    // ============================================
    // NEXT STEPS
    // ============================================

    log.header("✅ Test Mint Successful!");

    console.log(`
${colors.bright}Next Steps:${colors.reset}
  1. Check OpenSea: https://opensea.io (search for your contract)
  2. Test more mints:  npx hardhat run scripts/testMint.js --network ${network}
  3. Check status:     npx hardhat run scripts/status.js --network ${network}
  4. Close mint:       npx hardhat run scripts/closeMint.js --network ${network}
    `);

  } catch (error) {
    log.error(error.message);
    
    if (error.message.includes("Mint window")) {
      log.info("Mint window not active. Set it first with: npx hardhat run scripts/setMintWindow.js");
    } else if (error.message.includes("Wallet limit")) {
      log.info("This wallet has minted 10 NFTs. Use a different wallet to test more.");
    }
    
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
