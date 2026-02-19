const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("🚀 Starting deployment...");

  // Get deployer account
  const [deployer] = await hre.ethers.getSigners();
  console.log(`📝 Deploying contracts with account: ${deployer.address}`);

  // Get account balance
  const balance = await deployer.getBalance();
  console.log(`💰 Account balance: ${hre.ethers.utils.formatEther(balance)} ETH\n`);

  // Deploy EventContractFactory
  console.log("📦 Deploying EventContractFactory...");
  const EventContractFactory = await hre.ethers.getContractFactory("EventContractFactory");
  const factory = await EventContractFactory.deploy();
  await factory.deployed();
  console.log(`✅ EventContractFactory deployed at: ${factory.address}`);

  // Save deployment addresses
  const deploymentAddresses = {
    eventContractFactory: factory.address,
    deployer: deployer.address,
    network: hre.network.name,
    timestamp: new Date().toISOString(),
    blockNumber: await hre.ethers.provider.getBlockNumber(),
  };

  // Create deployments directory if it doesn't exist
  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  // Save to file
  const filename = path.join(deploymentsDir, `${hre.network.name}-deployment.json`);
  fs.writeFileSync(filename, JSON.stringify(deploymentAddresses, null, 2));
  console.log(`\n📄 Deployment addresses saved to: ${filename}`);

  // Display summary
  console.log("\n" + "=".repeat(60));
  console.log("📊 DEPLOYMENT SUMMARY");
  console.log("=".repeat(60));
  console.log(`Network: ${hre.network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`EventContractFactory: ${factory.address}`);
  console.log("=".repeat(60) + "\n");

  // Display contract interaction examples
  console.log("💡 NEXT STEPS:");
  console.log("=".repeat(60));
  console.log("\n1. To interact with the factory:");
  console.log(`
const factory = await ethers.getContractAt(
  "EventContractFactory",
  "${factory.address}"
);
  `);

  console.log("\n2. To create an event contract:");
  console.log(`
const dates = {
  announce: Math.floor(Date.now() / 1000),
  show: Math.floor(Date.now() / 1000) + 86400,
  loadIn: Math.floor(Date.now() / 1000) + 86400,
  doors: Math.floor(Date.now() / 1000) + 86400,
  start: Math.floor(Date.now() / 1000) + 87000,
  end: Math.floor(Date.now() / 1000) + 90000,
  setTime: Math.floor(Date.now() / 1000) + 87600,
  setLength: 3600
};

const location = {
  venue: "Concert Hall",
  addr: "123 Main St",
  radius: 5,
  days: 7
};

const config = {
  enabled: true,
  capacity: 1000,
  taxPct: 1000,
  typeCount: 0
};

const resale = {
  p1Pct: 5000,
  p2Pct: 3000,
  rPct: 2000
};

const payIn = {
  guarantee: 0,
  guaPct: 0,
  backPct: 0,
  barPct: 0,
  merchPct: 0
};

const tx = await factory.createEventContract(
  "Party1Name",
  "0x...", // party2 address
  dates,
  location,
  config,
  resale,
  payIn,
  "My Event",
  "ipfs://hash",
  ["Rock", "Pop"],
  "Rider text",
  "Legal terms",
  "Ticket legal"
);

const receipt = await tx.wait();
const contractAddress = receipt.events[0].args.addr;
  `);

  console.log("\n3. To verify on Etherscan (testnet):");
  console.log("npx hardhat verify --network sepolia <CONTRACT_ADDRESS>");

  console.log("\n=".repeat(60) + "\n");

  return deploymentAddresses;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
