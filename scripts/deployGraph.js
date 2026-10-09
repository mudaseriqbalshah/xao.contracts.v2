// scripts/deployGraph.js
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

/**
 * XAO Phase 2A Deployment Script — GraphRegistry + Tour contracts
 *
 * Deploys, in order:
 *   1. GraphRegistry
 *   2. TourParticipationAgreement (implementation, cloned per TPA)
 *   3. TourShell (implementation, cloned per tour)
 *   4. TourFactory
 *
 * Usage:
 *   Deploy to Base Sepolia (testnet):
 *   npx hardhat run scripts/deployGraph.js --network baseSepolia
 *
 *   Deploy to Base Mainnet:
 *   npx hardhat run scripts/deployGraph.js --network base
 */

const CONFIG = {
  deploymentsDir: "deployments",
  blockExplorers: {
    base: "https://basescan.org",
    baseSepolia: "https://sepolia.basescan.org",
  },
};

const LOCAL_NETWORKS = ["hardhat", "localhost"];

async function deploy(name, args = []) {
  const factory = await hre.ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  const code = await hre.ethers.provider.getCode(address);
  if (code === "0x") {
    throw new Error(`${name} deployment failed — no code at ${address}`);
  }

  console.log(`✓ ${name}: ${address}`);
  return { address, txHash: contract.deploymentTransaction().hash };
}

async function main() {
  const network = hre.network.name;
  const chainId = hre.network.config.chainId;
  const isLocal = LOCAL_NETWORKS.includes(network);

  if (!isLocal && !process.env.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY env var is not set. Add PRIVATE_KEY=0x... to your .env file.");
  }

  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  console.log("\n═══ XAO Phase 2A: GraphRegistry + Tour contracts ═══\n");
  console.log(`Network:   ${network} (chain ${chainId})`);
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Balance:   ${hre.ethers.formatEther(balance)} ETH\n`);

  const registry  = await deploy("GraphRegistry");
  const tpaImpl   = await deploy("TourParticipationAgreement");
  const shellImpl = await deploy("TourShell");
  const factory   = await deploy("TourFactory", [shellImpl.address, tpaImpl.address, registry.address]);

  const info = {
    network,
    chainId,
    deployer: deployer.address,
    deploymentTime: new Date().toISOString(),
    graphRegistry: registry.address,
    tourParticipationAgreementImplementation: tpaImpl.address,
    tourShellImplementation: shellImpl.address,
    tourFactory: factory.address,
    txHashes: {
      graphRegistry: registry.txHash,
      tourParticipationAgreementImplementation: tpaImpl.txHash,
      tourShellImplementation: shellImpl.txHash,
      tourFactory: factory.txHash,
    },
  };

  if (isLocal) {
    console.log("\nLocal network — deployment info not saved.");
    return info;
  }

  if (!fs.existsSync(CONFIG.deploymentsDir)) {
    fs.mkdirSync(CONFIG.deploymentsDir, { recursive: true });
  }
  const filename = path.join(CONFIG.deploymentsDir, `${network}-graph.json`);
  fs.writeFileSync(filename, JSON.stringify(info, null, 2));
  console.log(`\n✓ Deployment info saved to: ${filename}`);

  const explorer = CONFIG.blockExplorers[network];
  if (explorer) {
    console.log(`\nExplorer:  ${explorer}/address/${factory.address}`);
  }

  console.log("\nVerify on Basescan:");
  console.log(`  npx hardhat verify --network ${network} ${registry.address}`);
  console.log(`  npx hardhat verify --network ${network} ${tpaImpl.address}`);
  console.log(`  npx hardhat verify --network ${network} ${shellImpl.address}`);
  console.log(
    `  npx hardhat verify --network ${network} ${factory.address} ${shellImpl.address} ${tpaImpl.address} ${registry.address}\n`
  );

  return info;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("✗ Deployment failed!");
    console.error(err.message || err);
    process.exit(1);
  });
