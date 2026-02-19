// scripts/freezeMetadata.js
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Freeze Metadata Script - PERMANENT
 * 
 * ⚠️  WARNING: This action CANNOT be undone!
 * 
 * Usage:
 *   npx hardhat run scripts/freezeMetadata.js --network base
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
  magenta: "\x1b[35m",
};

const log = {
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  warning: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  header: (msg) => console.log(`\n${colors.bright}${colors.cyan}═══ ${msg} ═══${colors.reset}\n`),
};

async function main() {
  log.header("🔐 Freeze Metadata - PERMANENT LOCK");

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

    const contract = await hre.ethers.getContractAt(
      deployment.contract,
      contractAddress
    );

    // ============================================
    // PRE-FREEZE CHECKS
    // ============================================

    log.header("📋 Pre-Freeze Checks");

    const isFrozen = await contract.metadataFrozen();
    const supply = await contract.totalSupply();
    const isOpen = await contract.mintWindowOpen();

    log.info(`Metadata Frozen: ${isFrozen ? colors.green + "YES" : colors.yellow + "NO"}${colors.reset}`);
    log.info(`Current Supply: ${colors.bright}${supply}${colors.reset} / 10000`);
    log.info(`Mint Window Open: ${isOpen ? colors.yellow + "YES" : colors.green + "NO"}${colors.reset}`);

    // Check if already frozen
    if (isFrozen) {
      log.success("Metadata is already frozen!");
      log.info("No action needed.");
      process.exit(0);
    }

    // Check if mint window is still open
    if (isOpen) {
      log.error("Cannot freeze metadata while mint window is open!");
      log.warning("Close the mint window first:");
      console.log(`  ${colors.cyan}npx hardhat run scripts/closeMint.js --network ${network}${colors.reset}\n`);
      process.exit(1);
    }

    // ============================================
    // DISPLAY WARNING
    // ============================================

    console.log(`
${colors.red}${colors.bright}
╔═══════════════════════════════════════════════════════════════════════╗
║                                                                       ║
║              ⚠️  PERMANENT ACTION - CANNOT BE UNDONE ⚠️               ║
║                                                                       ║
║  You are about to PERMANENTLY FREEZE the collection metadata!         ║
║                                                                       ║
║  After this action:                                                   ║
║  ✗ No metadata can be changed ever again                              ║
║  ✗ No baseURI updates allowed                                         ║
║  ✗ No trait modifications                                             ║
║  ✗ Collection becomes immutable forever                               ║
║                                                                       ║
║  Current Collection State:                                            ║
║    Total Minted: ${supply.toString().padEnd(48)} ║
║    Mint Window: CLOSED                                                ║
║    Ready Status: READY FOR FREEZE                                     ║
║                                                                       ║
║  This action is FINAL and IRREVERSIBLE.                               ║
║                                                                       ║
╚═══════════════════════════════════════════════════════════════════════╝
${colors.reset}
`);

    // ============================================
    // FINAL CONFIRMATION
    // ============================================

    log.warning("Last chance to cancel! (Ctrl+C to stop)");
    log.warning("Proceeding with metadata freeze in 5 seconds...");
    
    // Wait 5 seconds to allow user to cancel
    await new Promise(resolve => setTimeout(resolve, 5000));

    // ============================================
    // EXECUTE FREEZE
    // ============================================

    log.header("🔒 Freezing Metadata");
    log.info("Sending transaction to blockchain...");

    const tx = await contract.freezeMetadata();
    log.info(`Transaction: ${colors.cyan}${tx.hash}${colors.reset}`);
    log.info("Waiting for confirmation (this may take a moment)...");

    const receipt = await tx.wait();
    log.success(`Metadata frozen! (Block ${receipt.blockNumber})`);
    log.info(`Gas used: ${receipt.gasUsed.toString()}`);

    // ============================================
    // VERIFY FREEZE
    // ============================================

    log.header("✓ Verification");

    const frozen = await contract.metadataFrozen();
    if (frozen) {
      log.success("✓ Verified: Metadata is now PERMANENTLY FROZEN");
    } else {
      log.error("Verification failed - metadata may not be frozen!");
      process.exit(1);
    }

    // ============================================
    // SAVE FREEZE INFO
    // ============================================

    const freezeFile = path.join("deployments", `${network}-freeze-metadata.json`);
    fs.writeFileSync(
      freezeFile,
      JSON.stringify(
        {
          frozenAt: new Date().toISOString(),
          txHash: tx.hash,
          blockNumber: receipt.blockNumber,
          supply: supply.toString(),
          contractAddress: contractAddress,
          network: network,
        },
        null,
        2
      )
    );

    log.success(`Freeze info saved to: ${freezeFile}`);

    // ============================================
    // FINAL SUMMARY
    // ============================================

    console.log(`
${colors.bright}${colors.green}
╔═══════════════════════════════════════════════════════════════════════╗
║                                                                       ║
║                  ✅ COLLECTION SUCCESSFULLY FINALIZED ✅              ║
║                                                                       ║
║  Your XAO ETHDenver NFT collection is now PERMANENTLY LOCKED!         ║
║                                                                       ║
║  Collection Summary:                                                  ║
║    Total NFTs: ${supply.toString().padEnd(49)} ║
║    Status: IMMUTABLE & PERMANENT                                      ║
║    Network: ${network.padEnd(53)} ║
║    Contract: ${contractAddress.padEnd(51)} ║
║                                                                       ║
║  All 10,000 NFTs are now locked with their final traits!             ║
║                                                                       ║
╚═══════════════════════════════════════════════════════════════════════╝
${colors.reset}
`);

    log.header("📚 Next Steps");

    console.log(`
${colors.bright}Collection is complete and immutable!${colors.reset}

1. ${colors.bright}Share with Community${colors.reset}
   • Announce finalization on social media
   • Share contract address: ${colors.cyan}${contractAddress}${colors.reset}
   • Post on Discord/Twitter

2. ${colors.bright}Enable Trading${colors.reset}
   • Verify collection on OpenSea
   • Enable secondary market trading
   • Check royalty settings

3. ${colors.bright}Monitor Activity${colors.reset}
   • Track secondary market prices
   • Monitor community engagement
   • Check trait rarity rankings

4. ${colors.bright}View Collection${colors.reset}
   • OpenSea: https://opensea.io/ (search for your contract)
   • Basescan: https://basescan.org/address/${contractAddress}

${colors.bright}Congratulations! 🎉${colors.reset}
Your XAO ETHDenver NFT collection is live and immutable!
    `);

  } catch (error) {
    log.error("Failed to freeze metadata!");
    console.error(`${colors.red}${error.message}${colors.reset}`);
    
    if (error.message.includes("Mint window")) {
      log.info("Close the mint window first with: npx hardhat run scripts/closeMint.js");
    } else if (error.message.includes("Metadata frozen")) {
      log.info("Metadata is already frozen!");
    }
    
    process.exit(1);
  }
}

main()
  .then(() => {
    console.log(`\n${colors.dim}Metadata freeze script completed successfully.${colors.reset}\n`);
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
