// scripts/deployShowBundle.js
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

/**
 * XAO Phase 2A Deployment Script — show bundle
 *
 * Deploys, in order:
 *   1. ShowInstance   (implementation, cloned per show)
 *   2. EventEscrow    (implementation, cloned per show)
 *   3. XAOTicketV2    (implementation, cloned per show)
 *   4. EntryValidator (implementation, cloned per show)
 *   5. ShowFactory
 *
 * Needs the GraphRegistry first. Its address is read from
 * deployments/<network>-graph.json (written by scripts/deployGraph.js), or
 * from the GRAPH_REGISTRY env var.
 *
 * Env:
 *   PRIVATE_KEY         deployer key
 *   TREASURY_MULTISIG   receives the $1 per ticket and XAO's 2%
 *   FACTORY_OWNER       optional; defaults to the deployer
 *   GRAPH_REGISTRY      optional; overrides the deployments file
 *
 * Usage:
 *   npx hardhat run scripts/deployShowBundle.js --network baseSepolia
 *   npx hardhat run scripts/deployShowBundle.js --network base
 */

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
  return address;
}

function readGraphRegistry(network) {
  if (process.env.GRAPH_REGISTRY) return process.env.GRAPH_REGISTRY;
  const file = path.join(CONFIG.deploymentsDir, `${network}-graph.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No GraphRegistry found. Run scripts/deployGraph.js on ${network} first, or set GRAPH_REGISTRY.`
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8")).graphRegistry;
}

async function main() {
  const network = hre.network.name;
  const chainId = hre.network.config.chainId;
  const isLocal = LOCAL_NETWORKS.includes(network);
  const [deployer] = await hre.ethers.getSigners();

  console.log("\n═══ XAO Phase 2A: show bundle ═══\n");
  console.log(`Network:   ${network} (chain ${chainId})`);
  console.log(`Deployer:  ${deployer.address}`);

  let graphRegistry, usdc, treasury;
  if (isLocal) {
    // Throwaway dependencies so the script can be dry-run locally.
    graphRegistry = await deploy("GraphRegistry");
    usdc = await deploy("MockERC20", ["USD Coin", "USDC", 6]);
    treasury = deployer.address;
  } else {
    if (!process.env.PRIVATE_KEY) {
      throw new Error("PRIVATE_KEY env var is not set. Add PRIVATE_KEY=0x... to your .env file.");
    }
    if (!process.env.TREASURY_MULTISIG) {
      throw new Error("TREASURY_MULTISIG env var is not set. Add TREASURY_MULTISIG=0x... to your .env file.");
    }
    usdc = CONFIG.usdcAddresses[network];
    if (!usdc) throw new Error(`No USDC address configured for network ${network}.`);
    graphRegistry = readGraphRegistry(network);
    treasury = process.env.TREASURY_MULTISIG;
  }
  const owner = process.env.FACTORY_OWNER || deployer.address;

  console.log(`Registry:  ${graphRegistry}`);
  console.log(`USDC:      ${usdc}`);
  console.log(`Treasury:  ${treasury}`);
  console.log(`Owner:     ${owner}\n`);

  const showInstanceImpl = await deploy("ShowInstance");
  const eventEscrowImpl  = await deploy("EventEscrow");
  const ticketImpl       = await deploy("XAOTicketV2");
  const validatorImpl    = await deploy("EntryValidator");

  const factoryArgs = [
    owner, graphRegistry, usdc, treasury,
    showInstanceImpl, eventEscrowImpl, ticketImpl, validatorImpl,
  ];
  const showFactory = await deploy("ShowFactory", factoryArgs);

  const info = {
    network,
    chainId,
    deployer: deployer.address,
    deploymentTime: new Date().toISOString(),
    showFactory,
    owner,
    graphRegistry,
    usdcAddress: usdc,
    treasuryAddress: treasury,
    showInstanceImplementation: showInstanceImpl,
    eventEscrowImplementation: eventEscrowImpl,
    ticketImplementation: ticketImpl,
    entryValidatorImplementation: validatorImpl,
  };

  if (isLocal) {
    console.log("\nLocal network — deployment info not saved.");
    return info;
  }

  if (!fs.existsSync(CONFIG.deploymentsDir)) {
    fs.mkdirSync(CONFIG.deploymentsDir, { recursive: true });
  }
  const filename = path.join(CONFIG.deploymentsDir, `${network}-showbundle.json`);
  fs.writeFileSync(filename, JSON.stringify(info, null, 2));
  console.log(`\n✓ Deployment info saved to: ${filename}`);

  const explorer = CONFIG.blockExplorers[network];
  if (explorer) {
    console.log(`\nExplorer:  ${explorer}/address/${showFactory}`);
  }

  console.log("\nVerify on Basescan:");
  for (const impl of [showInstanceImpl, eventEscrowImpl, ticketImpl, validatorImpl]) {
    console.log(`  npx hardhat verify --network ${network} ${impl}`);
  }
  console.log(`  npx hardhat verify --network ${network} ${showFactory} ${factoryArgs.join(" ")}\n`);

  return info;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("✗ Deployment failed!");
    console.error(err.message || err);
    process.exit(1);
  });
