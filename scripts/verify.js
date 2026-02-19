const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function verifyContract(contractAddress, constructorArgs = []) {
  try {
    console.log(`\n⏳ Verifying contract: ${contractAddress}`);
    
    if (constructorArgs.length > 0) {
      await hre.run("verify:verify", {
        address: contractAddress,
        constructorArguments: constructorArgs,
      });
    } else {
      await hre.run("verify:verify", {
        address: contractAddress,
      });
    }
    
    console.log("✅ Contract verified successfully!");
    return true;
  } catch (error) {
    if (error.message.includes("Already Verified")) {
      console.log("ℹ️  Contract already verified");
      return true;
    }
    console.error("❌ Verification failed!");
    console.error(error.message);
    return false;
  }
}

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("🔍 CONTRACT VERIFICATION");
  console.log("=".repeat(70));

  // Check API key
  if (!process.env.ETHERSCAN_API_KEY) {
    console.error("❌ ETHERSCAN_API_KEY not found in .env");
    console.error("   Add your Etherscan API key to .env file");
    process.exit(1);
  }

  console.log(`Network: ${hre.network.name}`);
  console.log(`Etherscan API Key: ${process.env.ETHERSCAN_API_KEY.substring(0, 5)}...`);
  console.log("");

  // Get deployment info
  const deploymentsDir = path.join(__dirname, "../deployments");
  const deploymentFile = path.join(deploymentsDir, `${hre.network.name}-deployment.json`);

  if (!fs.existsSync(deploymentFile)) {
    console.error(`❌ Deployment file not found: ${deploymentFile}`);
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf-8"));
  const factoryAddress = deployment.eventContractFactory || deployment.factory?.address;

  if (!factoryAddress) {
    console.error("❌ Factory address not found in deployment file");
    process.exit(1);
  }

  console.log(`Factory Address: ${factoryAddress}\n`);

  // Verify factory (no constructor arguments)
  console.log("📦 Step 1: Verifying EventContractFactory...");
  const factoryVerified = await verifyContract(factoryAddress);

  if (!factoryVerified) {
    console.error("\n❌ Factory verification failed");
    process.exit(1);
  }

  // Check for event contracts
  const eventFile = path.join(deploymentsDir, `${hre.network.name}-event.json`);
  if (fs.existsSync(eventFile)) {
    console.log("\n📦 Step 2: Verifying EventContract...");
    const eventInfo = JSON.parse(fs.readFileSync(eventFile, "utf-8"));
    const eventAddress = eventInfo.eventContract;

    const eventVerified = await verifyContract(eventAddress);

    if (!eventVerified) {
      console.warn("\n⚠️  Event contract verification failed (this may be expected)");
    }
  } else {
    console.log("\nℹ️  No event contracts found to verify");
  }

  console.log("\n" + "=".repeat(70));
  console.log("✅ VERIFICATION COMPLETE");
  console.log("=".repeat(70));
  console.log(`\n🔗 Block Explorer:`);
  console.log(`   https://${hre.network.name === "mainnet" ? "" : hre.network.name + "."}etherscan.io/address/${factoryAddress}`);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Verification script failed!");
    console.error(error);
    process.exit(1);
  });
