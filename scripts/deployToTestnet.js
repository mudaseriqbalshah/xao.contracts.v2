const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("🌐 DEPLOYING TO SEPOLIA TESTNET");
  console.log("=".repeat(70) + "\n");

  // Check network
  if (hre.network.name !== "baseSepolia") {
    console.error("❌ This script is for baseSepolia testnet only!");
    console.error(`Current network: ${hre.network.name}`);
    console.error("\nRun with: npx hardhat run scripts/deployToTestnet.js --network baseSepolia");
    process.exit(1);
  }

  // Get deployer
  const [deployer] = await hre.ethers.getSigners();
  console.log(`📝 Deployer Address: ${deployer.address}`);

  // Check balance
  // const balance = await deployer.getBalance();
  // const balanceEth = hre.ethers.utils.formatEther(balance);
  // console.log(`💰 Account Balance: ${balanceEth} ETH`);

  // if (parseFloat(balanceEth) < 0.5) {
  //   console.warn("⚠️  Warning: Low balance! You may not have enough ETH for deployment + gas");
  //   console.warn("   Get testnet ETH from: https://sepoliafaucet.com/");
  // }
  // console.log("");

  // Deployment configuration
  console.log("📋 DEPLOYMENT CONFIGURATION:");
  console.log("━".repeat(70));
  console.log(`Network: ${hre.network.name} (Sepolia Testnet)`);
  console.log(`Chain ID: 11155111`);
  console.log(`Block Confirmations: 6`);
  console.log(`Gas Reporter: ${process.env.REPORT_GAS === "true" ? "ENABLED" : "DISABLED"}`);
  console.log("━".repeat(70) + "\n");

  // Deploy EventContractFactory
  console.log("📦 Step 1: Deploying EventContractFactory...");
  const EventContractFactory = await hre.ethers.getContractFactory("EventContractFactory");
  
  console.log("   ⏳ Sending deployment transaction...");
  const factory = await EventContractFactory.deploy();
  console.log(`   📝 Transaction Hash: ${factory.deployTransaction.hash}`);
  
  console.log("   ⏳ Waiting for confirmations...");
  const deploymentReceipt = await factory.deployTransaction.wait(6);
  console.log(`   ✅ Deployed in block: ${deploymentReceipt.blockNumber}`);
  console.log(`   ✅ Gas Used: ${deploymentReceipt.gasUsed.toString()}`);
  console.log(`   ✅ EventContractFactory: ${factory.address}\n`);

  // Verify contract size
  console.log("📊 CONTRACT SIZE VERIFICATION:");
  console.log("━".repeat(70));
  const factoryBytecode = EventContractFactory.bytecode;
  const factorySizeKb = (factoryBytecode.length / 2 / 1024).toFixed(2);
  console.log(`EventContractFactory Size: ${factorySizeKb} KB`);
  console.log(`Max Contract Size: 24.576 KB`);
  if (factorySizeKb < 24.576) {
    console.log("✅ Size OK - Contract is deployable on mainnet");
  } else {
    console.log("❌ Size EXCEEDS limit - Contract too large!");
  }
  console.log("━".repeat(70) + "\n");

  // Save deployment info
  console.log("💾 Saving deployment information...");
  const deploymentInfo = {
    network: hre.network.name,
    chainId: 11155111,
    deployer: deployer.address,
    factory: {
      address: factory.address,
      deploymentBlock: deploymentReceipt.blockNumber,
      transactionHash: factory.deployTransaction.hash,
      gasUsed: deploymentReceipt.gasUsed.toString(),
      contractSize: `${factorySizeKb} KB`,
    },
    timestamp: new Date().toISOString(),
    blockExplorer: `https://sepolia.etherscan.io/address/${factory.address}`,
  };

  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const filename = path.join(deploymentsDir, "sepolia-deployment.json");
  fs.writeFileSync(filename, JSON.stringify(deploymentInfo, null, 2));
  console.log(`✅ Saved to: ${filename}\n`);

  // Create README
  const readmeContent = `# Sepolia Testnet Deployment

**Network:** Sepolia Testnet  
**Factory Address:** ${factory.address}  
**Deployed by:** ${deployer.address}  
**Timestamp:** ${new Date().toISOString()}

## Block Explorer
https://sepolia.etherscan.io/address/${factory.address}

## Verify Contract on Etherscan
\`\`\`bash
npx hardhat verify --network sepolia ${factory.address}
\`\`\`

## Test the Deployment
\`\`\`javascript
const factory = await ethers.getContractAt(
  "EventContractFactory",
  "${factory.address}"
);

// Get contract count
const count = await factory.getContractCount();
console.log("Total contracts:", count.toString());
\`\`\`

## Create Event Contract
See deploy.js for example usage.
`;

  const readmePath = path.join(deploymentsDir, "SEPOLIA_README.md");
  fs.writeFileSync(readmePath, readmeContent);
  console.log(`✅ Created README: ${readmePath}\n`);

  // Display final summary
  console.log("=".repeat(70));
  console.log("✅ DEPLOYMENT COMPLETE!");
  console.log("=".repeat(70));
  console.log("\n📊 DEPLOYMENT SUMMARY:");
  console.log(`  Network:             ${hre.network.name}`);
  console.log(`  Factory Address:     ${factory.address}`);
  console.log(`  Deployer:            ${deployer.address}`);
  console.log(`  Transaction Hash:    ${factory.deployTransaction.hash}`);
  console.log(`  Block Number:        ${deploymentReceipt.blockNumber}`);
  console.log(`  Gas Used:            ${deploymentReceipt.gasUsed.toString()}`);
  console.log(`  Contract Size:       ${factorySizeKb} KB`);
  console.log("");

  console.log("🔗 ETHERSCAN:");
  console.log(`  https://sepolia.etherscan.io/address/${factory.address}`);
  console.log("");

  console.log("✅ NEXT STEPS:");
  console.log("  1. Verify contract on Etherscan:");
  console.log(`     npx hardhat verify --network sepolia ${factory.address}`);
  console.log("");
  console.log("  2. Create an event contract:");
  console.log("     npx hardhat run scripts/createEvent.js --network sepolia");
  console.log("");
  console.log("  3. Run tests:");
  console.log("     npx hardhat test");
  console.log("");
  console.log("=".repeat(70) + "\n");

  return deploymentInfo;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed!");
    console.error(error);
    process.exit(1);
  });
