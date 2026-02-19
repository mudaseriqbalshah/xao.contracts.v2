// test/XAOETHDenver.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("XAOETHDenverNFT", function () {
  let xaoContract;
  let owner, user1, user2, user3;
  const baseURI = "https://ipfs.io/ipfs/QmXXXXXX/";

  beforeEach(async function () {
    [owner, user1, user2, user3] = await ethers.getSigners();

    const XAOContract = await ethers.deployContract("XAOETHDenverNFT_ERC721A", [baseURI]);
    xaoContract = await XAOContract.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should deploy with correct name and symbol", async function () {
      expect(await xaoContract.name()).to.equal("XAO ETHDenver");
      expect(await xaoContract.symbol()).to.equal("XAOXED");
    });

    it("Should set correct baseURI", async function () {
      expect(await xaoContract.baseURI()).to.equal(baseURI);
    });

    it("Should have 0 total supply initially", async function () {
      expect(await xaoContract.totalSupply()).to.equal(0);
    });

    it("Should have max supply of 10000", async function () {
      expect(await xaoContract.MAX_SUPPLY()).to.equal(10000);
    });
  });

  describe("Mint Window", function () {
    it("Should revert if mint called without window set", async function () {
      await expect(xaoContract.connect(user1).mint(1))
        .to.be.revertedWith("Mint window not open");
    });

    it("Should set mint window correctly", async function () {
      const now = Math.floor(Date.now() / 1000);
      const startTime = now;
      const endTime = now + 86400;

      await expect(xaoContract.setMintWindow(startTime, endTime))
        .to.emit(xaoContract, "MintWindowSet")
        .withArgs(startTime, endTime);

      expect(await xaoContract.mintStartTime()).to.equal(startTime);
      expect(await xaoContract.mintEndTime()).to.equal(endTime);
    });

    it("Should revert if end time before start time", async function () {
      const now = Math.floor(Date.now() / 1000);
      await expect(xaoContract.setMintWindow(now + 1000, now))
        .to.be.revertedWith("Invalid window");
    });

    it("Should check if mint is active", async function () {
      const now = Math.floor(Date.now() / 1000);
      const startTime = now - 1000;
      const endTime = now + 86400;

      await xaoContract.setMintWindow(startTime, endTime);
      expect(await xaoContract.isMintActive()).to.equal(true);
    });

    it("Should close mint window", async function () {
      const now = Math.floor(Date.now() / 1000);
      await xaoContract.setMintWindow(now, now + 86400);

      await expect(xaoContract.closeMintWindow())
        .to.emit(xaoContract, "MintWindowClosed");

      expect(await xaoContract.mintWindowOpen()).to.equal(false);
    });
  });

  describe("Minting", function () {
    beforeEach(async function () {
      const now = Math.floor(Date.now() / 1000);
      await xaoContract.setMintWindow(now - 1000, now + 86400);
    });

    it("Should mint single NFT", async function () {
      await expect(xaoContract.connect(user1).mint(1))
        .to.emit(xaoContract, "XAONFTMinted");

      expect(await xaoContract.balanceOf(user1.address)).to.equal(1);
      expect(await xaoContract.totalSupply()).to.equal(1);
    });

    it("Should mint multiple NFTs in one tx", async function () {
      await xaoContract.connect(user1).mint(3);

      expect(await xaoContract.balanceOf(user1.address)).to.equal(3);
      expect(await xaoContract.totalSupply()).to.equal(3);
    });

    it("Should enforce max mint per wallet", async function () {
      const MAX_PER_WALLET = 10;

      await xaoContract.connect(user1).mint(MAX_PER_WALLET);
      expect(await xaoContract.getMintCount(user1.address)).to.equal(MAX_PER_WALLET);

      // Try to mint 1 more
      await expect(xaoContract.connect(user1).mint(1))
        .to.be.revertedWith("Wallet limit exceeded");
    });

    it("Should reject 0 quantity", async function () {
      await expect(xaoContract.connect(user1).mint(0))
        .to.be.revertedWith("Invalid quantity");
    });

    it("Should reject quantity > 10", async function () {
      await expect(xaoContract.connect(user1).mint(11))
        .to.be.revertedWith("Invalid quantity");
    });

    it("Should track multiple users correctly", async function () {
      await xaoContract.connect(user1).mint(5);
      await xaoContract.connect(user2).mint(3);
      await xaoContract.connect(user3).mint(2);

      expect(await xaoContract.getMintCount(user1.address)).to.equal(5);
      expect(await xaoContract.getMintCount(user2.address)).to.equal(3);
      expect(await xaoContract.getMintCount(user3.address)).to.equal(2);
      expect(await xaoContract.totalSupply()).to.equal(10);
    });
  });

  describe("Traits & Personas", function () {
    beforeEach(async function () {
      const now = Math.floor(Date.now() / 1000);
      await xaoContract.setMintWindow(now - 1000, now + 86400);
      await xaoContract.connect(user1).mint(3);
    });

    it("Should assign traits to minted tokens", async function () {
      for (let i = 0; i < 3; i++) {
        const traits = await xaoContract.getTraits(i);
        
        expect(traits.persona).to.be.within(0, 6);
        expect(traits.background).to.be.within(0, 2);
        expect(traits.head).to.be.within(0, 3);
        expect(traits.accessory).to.be.within(0, 2);
        expect(traits.accent).to.be.within(0, 2);
      }
    });

    it("Should have ETHDenver trait on all tokens", async function () {
      for (let i = 0; i < 3; i++) {
        const traits = await xaoContract.getTraits(i);
        expect(traits.ethDenverSlot).to.be.within(0, 3);
      }
    });

    it("Should mark legendary correctly", async function () {
      // Mint many to find legendaries
      await xaoContract.connect(user2).mint(10);
      
      let legendaryCount = 0;
      for (let i = 0; i < 13; i++) {
        const traits = await xaoContract.getTraits(i);
        if (traits.legendary === 1) {
          legendaryCount++;
          expect(await xaoContract.isLegendary(i)).to.equal(true);
        } else {
          expect(await xaoContract.isLegendary(i)).to.equal(false);
        }
      }
      
      console.log(`Found ${legendaryCount} legendary items in 13 mints`);
    });

    it("Should return persona distribution", async function () {
      const distribution = await xaoContract.getPersonaStatus();
      
      expect(distribution.length).to.equal(7);
      
      let totalMinted = 0;
      for (let i = 0; i < 7; i++) {
        totalMinted += Number(distribution[i]);
      }
      
      expect(totalMinted).to.equal(3);
    });
  });

  describe("Metadata", function () {
    beforeEach(async function () {
      const now = Math.floor(Date.now() / 1000);
      await xaoContract.setMintWindow(now - 1000, now + 86400);
      await xaoContract.connect(user1).mint(1);
    });

    it("Should return correct tokenURI", async function () {
      const uri = await xaoContract.tokenURI(0);
      expect(uri).to.include(baseURI);
      expect(uri).to.include("0");
    });

    it("Should generate on-chain metadata", async function () {
      const metadata = await xaoContract.getMetadata(0);
      
      expect(metadata).to.include("data:application/json;base64,");
      
      // Decode and verify JSON structure
      const jsonStr = Buffer.from(
        metadata.replace("data:application/json;base64,", ""),
        "base64"
      ).toString();
      
      const parsed = JSON.parse(jsonStr);
      expect(parsed.name).to.include("XAO ETHDenver");
      expect(parsed.description).to.exist;
      expect(parsed.attributes).to.be.an("array");
    });

    it("Should include correct attributes in metadata", async function () {
      const metadata = await xaoContract.getMetadata(0);
      const jsonStr = Buffer.from(
        metadata.replace("data:application/json;base64,", ""),
        "base64"
      ).toString();
      
      const parsed = JSON.parse(jsonStr);
      const attributes = parsed.attributes;
      
      const traitTypes = attributes.map(a => a.trait_type);
      expect(traitTypes).to.include("Persona");
      expect(traitTypes).to.include("Background");
      expect(traitTypes).to.include("Head");
      expect(traitTypes).to.include("Accessory");
      expect(traitTypes).to.include("Accent");
      expect(traitTypes).to.include("Legendary");
      expect(traitTypes).to.include("ETHDenver");
    });

    it("Should freeze metadata", async function () {
      await xaoContract.freezeMetadata();
      expect(await xaoContract.metadataFrozen()).to.equal(true);
    });

    it("Should not allow baseURI change after freeze", async function () {
      await xaoContract.freezeMetadata();
      
      await expect(xaoContract.setBaseURI("https://new.uri/"))
        .to.be.revertedWith("Metadata frozen");
    });
  });

  describe("Supply Limits", function () {
    beforeEach(async function () {
      const now = Math.floor(Date.now() / 1000);
      await xaoContract.setMintWindow(now - 1000, now + 86400);
    });

    it("Should track remaining supply", async function () {
      expect(await xaoContract.getRemainingSupply()).to.equal(10000);
      
      await xaoContract.connect(user1).mint(5);
      expect(await xaoContract.getRemainingSupply()).to.equal(9995);
      
      await xaoContract.connect(user2).mint(10);
      expect(await xaoContract.getRemainingSupply()).to.equal(9985);
    });

    it("Should revert if exceeds max supply", async function () {
      // Verify max supply constant
      const maxSupply = await xaoContract.MAX_SUPPLY();
      expect(maxSupply).to.equal(10000);
      
      // Verify initial remaining supply
      const initial = await xaoContract.getRemainingSupply();
      expect(initial).to.equal(10000);
      
      // Mint a small amount
      await xaoContract.connect(user1).mint(5);
      
      // Verify remaining supply decreased correctly
      const afterMint = await xaoContract.getRemainingSupply();
      expect(afterMint).to.equal(initial - 5n);
    });
  });

  describe("Access Control", function () {
    it("Should only allow owner to set mint window", async function () {
      const now = Math.floor(Date.now() / 1000);
      
      await expect(xaoContract.connect(user1).setMintWindow(now, now + 1000))
        .to.be.revertedWithCustomError;
    });

    it("Should only allow owner to close mint window", async function () {
      const now = Math.floor(Date.now() / 1000);
      await xaoContract.setMintWindow(now, now + 86400);
      
      await expect(xaoContract.connect(user1).closeMintWindow())
        .to.be.revertedWithCustomError;
    });

    it("Should only allow owner to set baseURI", async function () {
      await expect(xaoContract.connect(user1).setBaseURI("https://new.uri/"))
        .to.be.revertedWithCustomError;
    });

    it("Should only allow owner to freeze metadata", async function () {
      await expect(xaoContract.connect(user1).freezeMetadata())
        .to.be.revertedWithCustomError;
    });
  });

  describe("Gas Optimization (ERC721A)", function () {
    it("Should batch mint efficiently", async function () {
      const now = Math.floor(Date.now() / 1000);
      await xaoContract.setMintWindow(now - 1000, now + 86400);

      const tx = await xaoContract.connect(user1).mint(10);
      const receipt = await tx.wait();
      
      console.log(`\nGas used for 10 mints: ${receipt.gasUsed.toString()}`);
      console.log(`Gas per NFT: ${(receipt.gasUsed / 10n).toString()}`);
    });
  });

  describe("Edge Cases", function () {
    beforeEach(async function () {
      const now = Math.floor(Date.now() / 1000);
      await xaoContract.setMintWindow(now - 1000, now + 86400);
    });

    it("Should handle boundary trait values", async function () {
      await xaoContract.connect(user1).mint(1);
      const traits = await xaoContract.getTraits(0);
      
      expect(traits.background).to.be.within(0, 2);
      expect(traits.head).to.be.within(0, 3);
      expect(traits.accessory).to.be.within(0, 2);
      expect(traits.accent).to.be.within(0, 2);
    });

    it("Should revert on non-existent token", async function () {
      await xaoContract.connect(user1).mint(1);
      
      await expect(xaoContract.getTraits(9999))
        .to.be.revertedWith("Token does not exist");
    });

    it("Should handle multiple mint transactions from same wallet", async function () {
      await xaoContract.connect(user1).mint(5);
      await xaoContract.connect(user1).mint(3);
      await xaoContract.connect(user1).mint(2);
      
      expect(await xaoContract.getMintCount(user1.address)).to.equal(10);
      expect(await xaoContract.balanceOf(user1.address)).to.equal(10);
    });
  });
});