// scripts/status.js
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Status Check Script
 * 
 * Usage:
 *   npx hardhat run scripts/status.js --network base
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

const PERSONA_NAMES = ["Hip Hop", "K-Pop", "Country", "Electronic", "Punk", "Classical", "Jazz"];
const TARGETS = [2200, 1800, 1600, 1500, 1300, 900, 700];

async function main() {
  log.header("📊 XAO ETHDenver Collection Status");

  try {
    const network = hre.network.name;
    const deploymentFile = path.join("deployments", `${network}-deployment.json`);

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

    // ============================================
    // MINT WINDOW STATUS
    // ============================================

    log.header("🎫 Mint Window Status");

    const isActive = await contract.isMintActive();
    const startTime = await contract.mintStartTime();
    const endTime = await contract.mintEndTime();
    const windowOpen = await contract.mintWindowOpen();

    log.info(`Window Open: ${windowOpen ? colors.green + "YES" : colors.yellow + "NO"}${colors.reset}`);
    log.info(`Currently Active: ${isActive ? colors.green + "YES" : colors.yellow + "NO"}${colors.reset}`);

    if (startTime > 0) {
      const startDate = new Date(Number(startTime) * 1000);
      const endDate = new Date(Number(endTime) * 1000);
      log.info(`Start: ${startDate.toISOString()}`);
      log.info(`End:   ${endDate.toISOString()}`);
      
      const now = Math.floor(Date.now() / 1000);
      if (now < startTime) {
        const hoursUntil = ((startTime - now) / 3600).toFixed(1);
        log.warning(`Starts in ${hoursUntil} hours`);
      } else if (now > endTime) {
        log.warning(`Ended ${((now - endTime) / 3600).toFixed(1)} hours ago`);
      }
    }

    // ============================================
    // SUPPLY STATUS
    // ============================================

    log.header("🎨 Supply Status");

    const totalSupply = await contract.totalSupply();
    const remaining = await contract.getRemainingSupply();
    const maxSupply = await contract.MAX_SUPPLY();

    const percentMinted = ((totalSupply / maxSupply) * 100).toFixed(2);

    log.info(`Total Minted: ${colors.bright}${totalSupply}${colors.reset} / ${maxSupply}`);
    log.info(`Remaining: ${colors.bright}${remaining}${colors.reset}`);
    log.info(`Progress: ${percentMinted}%`);

    // Progress bar
    const barLength = 30;
    const filledLength = Math.floor((totalSupply / maxSupply) * barLength);
    const bar = "█".repeat(filledLength) + "░".repeat(barLength - filledLength);
    console.log(`\n  [${bar}] ${percentMinted}%\n`);

    // ============================================
    // PERSONA DISTRIBUTION
    // ============================================

    log.header("👤 Persona Distribution");

    const distribution = await contract.getPersonaStatus();

    console.log(`${colors.bright}Target → Minted (% of total)${colors.reset}\n`);

    let totalMinted = 0;
    for (let i = 0; i < 7; i++) {
      const minted = Number(distribution[i]);
      const target = TARGETS[i];
      totalMinted += minted;
      
      const pct = totalSupply > 0 ? ((minted * 100) / totalSupply).toFixed(1) : "0.0";
      const remaining = target - minted;
      const status = remaining === 0 ? colors.green + "✓ FULL" : `${remaining} left`;
      
      const barLength = 20;
      const barFilled = Math.floor((minted / target) * barLength);
      const progressBar = "█".repeat(barFilled) + "░".repeat(barLength - barFilled);
      
      console.log(`${PERSONA_NAMES[i].padEnd(12)} ${target.toString().padStart(4)} → ${minted.toString().padStart(4)} (${pct.padStart(5)}%) [${progressBar}] ${status}${colors.reset}`);
    }

    console.log(`\nTotal Verified: ${totalMinted}`);

    // ============================================
    // LEGENDARY STATISTICS
    // ============================================

    log.header("✨ Legendary Statistics");

    // Estimate legendary count (sample from recent mints if possible)
    const estimatedLegendaryRate = 2; // 2% target
    const estimatedLegendaryCount = Math.floor((totalSupply * estimatedLegendaryRate) / 100);

    log.info(`Target Rate: ${estimatedLegendaryRate}%`);
    log.info(`Estimated Count: ~${estimatedLegendaryCount}`);
    
    if (totalSupply > 0) {
      const expectedMin = Math.floor((totalSupply * 1.5) / 100);
      const expectedMax = Math.floor((totalSupply * 2) / 100);
      log.info(`Expected Range: ${expectedMin} - ${expectedMax}`);
    }

    // ============================================
    // GAS COST ESTIMATE
    // ============================================

    log.header("⛽ Gas Cost Estimate");

    const gasPerMint = 60000; // ERC721A average
    const gasPriceGwei = 10; // Base average
    const totalGasUsed = totalSupply * gasPerMint;
    const costEth = (totalGasUsed * gasPriceGwei) / 1e9;

    log.info(`Mints So Far: ${totalSupply}`);
    log.info(`Gas Per Mint: ${gasPerMint} (avg)`);
    log.info(`Total Gas Used: ${totalGasUsed.toLocaleString()}`);
    log.info(`Est. Cost @ ${gasPriceGwei} gwei: ${colors.bright}${costEth.toFixed(4)} ETH${colors.reset}`);

    // Projection
    if (totalSupply > 0) {
      const projectedTotal = (10000 * costEth) / totalSupply;
      log.info(`Projected Total (10k): ${colors.bright}${projectedTotal.toFixed(2)} ETH${colors.reset}`);
    }

    // ============================================
    // CONTRACT INFO
    // ============================================

    log.header("ℹ️ Contract Info");

    const name = await contract.name();
    const symbol = await contract.symbol();
    const baseURI = await contract.baseURI();
    const metadataFrozen = await contract.metadataFrozen();

    log.info(`Name: ${name}`);
    log.info(`Symbol: ${symbol}`);
    log.info(`Base URI: ${colors.cyan}${baseURI}${colors.reset}`);
    log.info(`Metadata Frozen: ${metadataFrozen ? colors.green + "YES" : colors.yellow + "NO"}${colors.reset}`);

    // ============================================
    // QUICK ACTIONS
    // ============================================

    log.header("⚡ Quick Actions");

    console.log(`
${colors.bright}Recommended Next Steps:${colors.reset}

${totalSupply === 0 ? `${colors.yellow}Collection not started yet!${colors.reset}` : `${colors.green}✓ Collection active${colors.reset}`}

Actions:
  • View on Basescan:  https://basescan.org/address/${contractAddress}
  • Test mint:         npx hardhat run scripts/testMint.js --network ${network}
  • Set mint window:   npx hardhat run scripts/setMintWindow.js --network ${network}
  • Close mint:        npx hardhat run scripts/closeMint.js --network ${network}
  • Freeze metadata:   npx hardhat run scripts/freezeMetadata.js --network ${network}
  • Check again:       npx hardhat run scripts/status.js --network ${network}
    `);

    // ============================================
    // SUMMARY
    // ============================================

    log.header("✅ Status Check Complete");

  } catch (error) {
    console.error(`${colors.bright}${colors.yellow}Error: ${error.message}${colors.reset}`);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
