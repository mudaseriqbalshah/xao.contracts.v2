// scripts/deployPhase2.js
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

/**
 * XAO Phase 2 deployment: everything added or changed up to Phase 2F.
 *
 * Reuses from deployments/<network>-graph.json (they have not changed since):
 *   GraphRegistry, StakingParentFactory
 *
 * Deploys:
 *   Mini-Org      wallet, grant, MiniOrgFactory
 *   Agreements    StandingAgreement, StandingAgreementFactory
 *   Tour          TourParticipationAgreement, TourShell, TourFactory
 *   Shows         ShowInstance, EventEscrow, XAOTicketV2, EntryValidator, ShowFactory
 *   Data          DataModule, DataModuleFactory          (before the coordinator: it trusts this factory)
 *   Discounts     DiscountCoordinator, DiscountCoordinatorFactory, set on the ShowFactory
 *   Membership    FanMembership, FanMembershipFactory
 *   Perks         PerkModule, PerkModuleFactory
 *   Tour money    TourSettlementEscrow, TourSettlementEscrowFactory, TourCoverage, TourCoverageFactory
 *
 * Writes deployments/<network>-phase2.json after every step. No source verification is done.
 *
 * Env (not needed on the local network):
 *   PRIVATE_KEY         deployer key
 *   TREASURY_MULTISIG   receives the $1 per ticket and XAO's 2%
 *   FACTORY_OWNER       optional; owner of the ShowFactory, defaults to the deployer
 *   RESUME=1            optional; keep what an interrupted run already deployed. Only safe when
 *                       the contracts have not changed since that run.
 *
 * Usage:
 *   npx hardhat run scripts/deployPhase2.js                         (local rehearsal)
 *   npx hardhat run scripts/deployPhase2.js --network baseSepolia
 */

const DIR = "deployments";
const USDC = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  baseSepolia: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};
const LOCAL = ["hardhat", "localhost"].includes(hre.network.name);
const MAX_CODE = 24_576;

// every contract this script deploys; their sizes are checked before anything is sent
const CONTRACTS = [
  "MiniOrgWallet", "MiniOrgGrant", "MiniOrgFactory",
  "StandingAgreement", "StandingAgreementFactory",
  "TourParticipationAgreement", "TourShell", "TourFactory",
  "ShowInstance", "EventEscrow", "XAOTicketV2", "EntryValidator", "ShowFactory",
  "DataModule", "DataModuleFactory",
  "DiscountCoordinator", "DiscountCoordinatorFactory",
  "FanMembership", "FanMembershipFactory",
  "PerkModule", "PerkModuleFactory",
  "TourSettlementEscrow", "TourSettlementEscrowFactory", "TourCoverage", "TourCoverageFactory",
];

let record;
let gasUsed = 0n;
let outFile;

function save() {
  if (!outFile) return;
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Add it to your .env file.`);
  return value;
}

// The local network allows any size, so check against the real limit ourselves.
async function checkSizes() {
  const tooBig = [];
  for (const name of CONTRACTS) {
    const { deployedBytecode } = await hre.artifacts.readArtifact(name);
    const size = (deployedBytecode.length - 2) / 2;
    if (size > MAX_CODE) tooBig.push(`${name} (${size} bytes)`);
  }
  if (tooBig.length) throw new Error(`Over the ${MAX_CODE}-byte contract limit: ${tooBig.join(", ")}`);
  console.log(`✓ all ${CONTRACTS.length} contracts are within the size limit\n`);
}

async function deploy(name, args = []) {
  const known = record.contracts[name];
  if (known && (await hre.ethers.provider.getCode(known)) !== "0x") {
    console.log(`• ${name}: ${known} (already deployed)`);
    return hre.ethers.getContractAt(name, known);
  }
  const factory = await hre.ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  const receipt = await contract.deploymentTransaction().wait(LOCAL ? 1 : 2);
  gasUsed += receipt.gasUsed;
  const address = await contract.getAddress();
  if ((await hre.ethers.provider.getCode(address)) === "0x") throw new Error(`${name}: no code at ${address}`);

  record.contracts[name] = address;
  record.constructorArgs[name] = args;
  record.txHashes[name] = receipt.hash;
  save();
  console.log(`✓ ${name}: ${address}`);
  return contract;
}

function check(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`wiring check failed: ${label} is ${actual}, expected ${expected}`);
  }
  console.log(`✓ ${label}`);
}

async function main() {
  const network = hre.network.name;
  const [deployer] = await hre.ethers.getSigners();
  if (!LOCAL) required("PRIVATE_KEY");

  console.log("\n═══ XAO Phase 2 deployment ═══\n");
  console.log(`Network:   ${network} (chain ${hre.network.config.chainId})`);
  console.log(`Deployer:  ${deployer.address}`);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Balance:   ${hre.ethers.formatEther(balance)} ETH\n`);
  if (!LOCAL && balance === 0n) throw new Error("The deployer has no ETH for gas.");

  await hre.run("compile");
  await checkSizes();

  // ── what is reused or comes from outside ──
  let registry, stakingFactory, usdc, treasury;
  if (LOCAL) {
    registry = await (await (await hre.ethers.getContractFactory("GraphRegistry")).deploy()).getAddress();
    usdc = await (await (await hre.ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6)).getAddress();
    treasury = deployer.address;
  } else {
    treasury = required("TREASURY_MULTISIG");
    usdc = USDC[network];
    if (!usdc) throw new Error(`No USDC address configured for ${network}.`);
    const graphFile = path.join(DIR, `${network}-graph.json`);
    if (!fs.existsSync(graphFile)) throw new Error(`${graphFile} not found: run scripts/deployGraph.js first.`);
    const graph = JSON.parse(fs.readFileSync(graphFile, "utf8"));
    registry = graph.graphRegistry;
    stakingFactory = graph.stakingParentFactory;
    for (const [label, address] of [["GraphRegistry", registry], ["USDC", usdc], ["StakingParentFactory", stakingFactory]]) {
      if (!address || (await hre.ethers.provider.getCode(address)) === "0x") throw new Error(`No contract at the recorded ${label} address (${address}).`);
    }
  }
  const owner = process.env.FACTORY_OWNER || deployer.address;

  outFile = LOCAL ? null : path.join(DIR, `${network}-phase2.json`);
  const previous = outFile && process.env.RESUME === "1" && fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : null;
  record = previous || {
    network,
    chainId: hre.network.config.chainId,
    deployer: deployer.address,
    startedAt: new Date().toISOString(),
    graphRegistry: registry,
    stakingParentFactory: stakingFactory || null,
    usdcAddress: usdc,
    treasuryAddress: treasury,
    factoryOwner: owner,
    contracts: {},
    constructorArgs: {},
    txHashes: {},
  };

  console.log(`Registry:  ${registry}`);
  console.log(`USDC:      ${usdc}`);
  console.log(`Treasury:  ${treasury}`);
  console.log(`Owner:     ${owner}\n`);

  // ── Mini-Org, agreements, tours ──
  const orgWallet = await deploy("MiniOrgWallet");
  const orgGrant = await deploy("MiniOrgGrant");
  const miniOrgFactory = await deploy("MiniOrgFactory", [orgWallet.target, orgGrant.target, registry]);

  const agreement = await deploy("StandingAgreement");
  const agreementFactory = await deploy("StandingAgreementFactory", [agreement.target]);

  const tpa = await deploy("TourParticipationAgreement");
  const shell = await deploy("TourShell");
  const tourFactory = await deploy("TourFactory", [shell.target, tpa.target, registry]);

  // ── shows ──
  const showImpl = await deploy("ShowInstance");
  const escrowImpl = await deploy("EventEscrow");
  const ticketImpl = await deploy("XAOTicketV2");
  const validatorImpl = await deploy("EntryValidator");
  const showFactory = await deploy("ShowFactory", [
    owner, registry, usdc, treasury, showImpl.target, escrowImpl.target, ticketImpl.target, validatorImpl.target,
  ]);

  // ── data and discounts: the coordinator trusts this data factory only ──
  const dataImpl = await deploy("DataModule");
  const dataFactory = await deploy("DataModuleFactory", [dataImpl.target]);
  const coordinatorImpl = await deploy("DiscountCoordinator", [dataFactory.target]);
  const coordinatorFactory = await deploy("DiscountCoordinatorFactory", [coordinatorImpl.target]);

  // ── membership and perks ──
  const membershipImpl = await deploy("FanMembership");
  const membershipFactory = await deploy("FanMembershipFactory", [membershipImpl.target]);
  const perkImpl = await deploy("PerkModule");
  const perkFactory = await deploy("PerkModuleFactory", [perkImpl.target]);

  // ── tour money ──
  const settlementImpl = await deploy("TourSettlementEscrow");
  const settlementFactory = await deploy("TourSettlementEscrowFactory", [settlementImpl.target, showFactory.target]);
  const coverageImpl = await deploy("TourCoverage");
  const coverageFactory = await deploy("TourCoverageFactory", [coverageImpl.target, showFactory.target]);

  // ── wiring ──
  console.log("\nWiring:");
  const canSet = owner.toLowerCase() === deployer.address.toLowerCase();
  if ((await showFactory.discountCoordinatorImpl()) !== coordinatorImpl.target) {
    if (canSet) {
      const tx = await showFactory.setDiscountCoordinatorImplementation(coordinatorImpl.target);
      gasUsed += (await tx.wait(LOCAL ? 1 : 2)).gasUsed;
    } else {
      console.log(`! The ShowFactory owner (${owner}) still has to call setDiscountCoordinatorImplementation(${coordinatorImpl.target}).`);
      console.log("  Until then, shows with discounts cannot be created.");
      record.pending = [`ShowFactory.setDiscountCoordinatorImplementation(${coordinatorImpl.target}) by ${owner}`];
    }
  }

  check("ShowFactory.owner", await showFactory.owner(), owner);
  check("ShowFactory.graphRegistry", await showFactory.graphRegistry(), registry);
  check("ShowFactory.payoutToken", await showFactory.payoutToken(), usdc);
  check("ShowFactory.treasury", await showFactory.treasury(), treasury);
  check("ShowFactory.eventEscrowImpl", await showFactory.eventEscrowImpl(), escrowImpl.target);
  check("ShowFactory.ticketImpl", await showFactory.ticketImpl(), ticketImpl.target);
  if (canSet) check("ShowFactory.discountCoordinatorImpl", await showFactory.discountCoordinatorImpl(), coordinatorImpl.target);
  check("DiscountCoordinator.dataModuleFactory", await coordinatorImpl.dataModuleFactory(), dataFactory.target);
  check("DiscountCoordinatorFactory.implementation", await coordinatorFactory.implementation(), coordinatorImpl.target);
  check("DataModuleFactory.implementation", await dataFactory.implementation(), dataImpl.target);
  check("FanMembershipFactory.implementation", await membershipFactory.implementation(), membershipImpl.target);
  check("PerkModuleFactory.implementation", await perkFactory.implementation(), perkImpl.target);
  check("MiniOrgFactory.walletImplementation", await miniOrgFactory.walletImplementation(), orgWallet.target);
  check("MiniOrgFactory.graphRegistry", await miniOrgFactory.graphRegistry(), registry);
  check("StandingAgreementFactory.implementation", await agreementFactory.implementation(), agreement.target);
  check("TourFactory.shellImplementation", await tourFactory.shellImplementation(), shell.target);
  check("TourFactory.graphRegistry", await tourFactory.graphRegistry(), registry);
  check("TourSettlementEscrowFactory.implementation", await settlementFactory.implementation(), settlementImpl.target);
  check("TourSettlementEscrowFactory.showFactory", await settlementFactory.showFactory(), showFactory.target);
  check("TourCoverageFactory.implementation", await coverageFactory.implementation(), coverageImpl.target);
  check("TourCoverageFactory.showFactory", await coverageFactory.showFactory(), showFactory.target);

  record.finishedAt = new Date().toISOString();
  save();

  const feeData = await hre.ethers.provider.getFeeData();
  console.log(`\nGas used:  ${gasUsed.toString()}`);
  if (!LOCAL && feeData.gasPrice) console.log(`Cost at the current gas price: about ${hre.ethers.formatEther(gasUsed * feeData.gasPrice)} ETH`);
  if (outFile) console.log(`Saved:     ${outFile}`);
  else console.log("Local network: nothing saved.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("✗ Deployment failed!");
    console.error(err.message || err);
    process.exit(1);
  });
