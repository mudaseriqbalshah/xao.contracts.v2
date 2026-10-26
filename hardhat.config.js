// hardhat.config.js
require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000000";
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";

const settingsWithRuns = (runs) => ({
  optimizer: {
    enabled: true,
    runs,
    details: {
      yul: true,
      yulDetails: {
        optimizerSteps: "u",
      },
    },
  },
  viaIR: true,
});

module.exports = {
  solidity: {
    compilers: [{ version: "0.8.20", settings: settingsWithRuns(80) }],
    overrides: {
      // The global settings above only run the optimizer's unused-code pruner
      // (optimizerSteps "u"). EventEscrow carries the payout, refund, dispute and
      // opener logic and does not fit the 24,576-byte contract limit that way, so
      // it uses the optimizer's default steps, tuned for size. It is called a few
      // times per show, so cheaper calls matter less than fitting.
      "contracts/show/EventEscrow.sol": {
        version: "0.8.20",
        settings: { optimizer: { enabled: true, runs: 1 }, viaIR: true },
      },
    },
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
    },
    base: {
      url: BASE_RPC,
      accounts: [PRIVATE_KEY],
      chainId: 8453,
    },
    baseSepolia: {
      url: "https://sepolia.base.org",
      accounts: [PRIVATE_KEY],
      chainId: 84532,
    },
  },
  etherscan: {
    apiKey: {
      base: process.env.BASESCAN_API_KEY || "1HUI6UTTVE64IMQYPH85UCWA12JXXM4CEQ",
      baseSepolia: process.env.BASESCAN_API_KEY || "1HUI6UTTVE64IMQYPH85UCWA12JXXM4CEQ",
    },
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=8453",
          browserURL: "https://basescan.org",
        },
      },
      {
        network: "baseSepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=84532",
          browserURL: "https://sepolia.basescan.org",
        },
      },
    ],
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
};



// ============================================
// USAGE IN package.json
// ============================================

/*
Add to package.json scripts section:

"scripts": {
  "deploy:base": "hardhat run scripts/deploy.js --network base",
  "deploy:sepolia": "hardhat run scripts/deploy.js --network baseSepolia",
  "mint:set-window": "hardhat run scripts/setMintWindow.js --network base",
  "mint:test": "hardhat run scripts/testMint.js --network base",
  "status": "hardhat run scripts/status.js --network base",
  "mint:close": "hardhat run scripts/closeMint.js --network base",
  "metadata:freeze": "hardhat run scripts/freezeMetadata.js --network base",
  "verify": "hardhat verify --network base"
}

Create .env file:
PRIVATE_KEY=0x...your_private_key...
BASE_URI=https://ipfs.io/ipfs/QmXXXXXX/
BASESCAN_API_KEY=...optional...
*/
