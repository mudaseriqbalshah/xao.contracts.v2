// XAO_NFT_README.md

# XAO ETHDenver NFT Collection

A free, culturally expressive NFT collection marking early participation at ETHDenver 2025.

## 🎵 Overview

**XAO ETHDenver** is a 10,000-piece cultural artifact celebrating musical subculture diversity and ETHDenver participation. Each NFT features one of seven personas (Hip Hop, K-Pop, Country, Electronic, Punk, Classical, Jazz) with unique traits and a legendary rarity tier.

- **Total Supply**: 10,000
- **Mint Price**: Free (gas covered)
- **Chain**: Base
- **Standard**: ERC721A (optimized for gas efficiency)
- **Reveal**: Instant
- **Metadata**: Frozen after mint window
- **Trading**: Fully enabled

## 📊 Collection Specifications

### Personas (Rarity Distribution)
| Persona    | Supply | Rarity      |
|-----------|--------|-------------|
| Hip Hop   | 2,200  | Most Common |
| K-Pop     | 1,800  |             |
| Country   | 1,600  |             |
| Electronic| 1,500  |             |
| Punk      | 1,300  |             |
| Classical |   900  |             |
| Jazz      |   700  | Least Common|

### Traits Per Persona
Each NFT combines traits from five categories:
- **Background**: 3 options
- **Head**: 4 options
- **Accessory**: 3 options
- **Accent**: 3 options
- **Legendary**: 1 special item per persona (~1.5-2% rate)

Base combinations per persona: 108 different looks (before legendary/ETHDenver variants)

### Special Mechanics

**ETHDenver Provenance Marker**
- Every NFT includes exactly one ETHDenver-specific trait
- Appears in one of four slots: Background, Head, Accessory, or Accent
- Indicates participation, not rarity
- Cannot occupy same slot as legendary item

**Legendary Items**
- ~1.5-2% chance per mint
- Persona-specific designs
- Replaces one trait slot
- Visually unmistakable
- Incompatible with ETHDenver in same slot

## 🚀 Quick Start

### Prerequisites
```bash
Node.js >= 18.0
npm or yarn
Hardhat
```

### Installation

```bash
# Clone repository
git clone https://github.com/your-repo/xao-ethdenver-nft.git
cd xao-ethdenver-nft

# Install dependencies
npm install
# or
yarn install

# Install required packages
npm install --save-dev hardhat @openzeppelin/contracts dotenv

# Add to imports (if using ERC721A)
npm install erc721a
```

### Environment Setup

Create `.env` file:
```
PRIVATE_KEY=0x...your_private_key_here...
BASE_URI=https://ipfs.io/ipfs/QmXXXXXX/  # Your IPFS metadata URI
BASESCAN_API_KEY=...optional...
```

### Compile Contract

```bash
npx hardhat compile
```

### Run Tests

```bash
npx hardhat test
npx hardhat test --grep "Traits & Personas"  # Run specific test suite
```

## 📤 Deployment

### Step 1: Deploy to Base Testnet (Recommended First)

```bash
npx hardhat run scripts/deploy.js --network baseSepolia
```

### Step 2: Deploy to Base Mainnet

```bash
npx hardhat run scripts/deploy.js --network base
```

**Output**: Contract address will be saved to `deployments/base-deployment.json`

### Step 3: Set Mint Window

```bash
# Edit scripts/setMintWindow.js with actual ETHDenver dates
npx hardhat run scripts/setMintWindow.js --network base
```

### Step 4: Verify Contract

```bash
npx hardhat verify --network base 0xYourContractAddress "https://ipfs.io/ipfs/QmXXXXXX/"
```

### Step 5: Monitor & Close

```bash
# Check status anytime
npx hardhat run scripts/status.js --network base

# Close mint window when done
npx hardhat run scripts/closeMint.js --network base

# Freeze metadata (permanent)
npx hardhat run scripts/freezeMetadata.js --network base
```

## 📚 API Reference

### Minting Functions

#### `mint(uint256 quantity)`
Mint 1-10 NFTs during active mint window.
```javascript
// Mint 1 NFT
await contract.mint(1);

// Mint 5 NFTs
await contract.mint(5);

// Reverts if:
// - Mint window not active
// - quantity < 1 or > 10
// - wallet already has 10 NFTs
// - supply would exceed 10,000
```

### Query Functions

#### `getTraits(uint256 tokenId) → TraitCombo`
Get full trait data for a token.
```javascript
const traits = await contract.getTraits(0);
// Returns: {
//   persona: 0-6,
//   background: 0-2,
//   head: 0-3,
//   accessory: 0-2,
//   accent: 0-2,
//   legendary: 0 or 1,
//   ethDenverSlot: 0-3
// }
```

#### `getPersonaStatus() → uint16[7]`
Get distribution of all seven personas.
```javascript
const distribution = await contract.getPersonaStatus();
// Returns: [hipHopCount, kPopCount, countryCount, ...]
```

#### `getMintCount(address wallet) → uint256`
Check how many NFTs a wallet has minted.
```javascript
const count = await contract.getMintCount("0x...");
```

#### `getRemainingSupply() → uint256`
Get how many NFTs can still be minted.
```javascript
const remaining = await contract.getRemainingSupply();
```

#### `isLegendary(uint256 tokenId) → bool`
Check if a specific NFT is legendary.
```javascript
const isLegendary = await contract.isLegendary(5);
```

#### `getMetadata(uint256 tokenId) → string`
Get on-chain JSON metadata (base64 encoded).
```javascript
const metadata = await contract.getMetadata(0);
// Returns: "data:application/json;base64,eyJ..."
```

### Admin Functions

#### `setMintWindow(uint256 startTime, uint256 endTime)`
Set the mint window (owner only).
```javascript
const startTime = Math.floor(new Date("2025-02-28T08:00:00Z").getTime() / 1000);
const endTime = Math.floor(new Date("2025-03-03T20:00:00Z").getTime() / 1000);
await contract.setMintWindow(startTime, endTime);
```

#### `closeMintWindow()`
Close mint window (owner only).
```javascript
await contract.closeMintWindow();
```

#### `setBaseURI(string _baseURI)`
Update metadata URI (owner only, before metadata frozen).
```javascript
await contract.setBaseURI("https://ipfs.io/ipfs/QmNewURI/");
```

#### `freezeMetadata()`
Permanently freeze metadata (owner only).
```javascript
await contract.freezeMetadata();
// After this, baseURI cannot be changed
```

## 🔧 Contract Architecture

### Core Files

**XAOETHDenverNFT_ERC721A.sol** (RECOMMENDED)
- Gas-optimized ERC721A implementation
- Persona-weighted randomness
- Legendary item system
- ETHDenver provenance tracking
- ~90% cheaper minting vs standard ERC721

**XAOETHDenverNFT.sol** (Alternative)
- Standard ERC721 with custom optimizations
- Full enumerable support
- Higher gas costs but proven implementation

### Key Components

**Trait Assignment** (`_assignTraits()`)
- Selects persona with weighted distribution
- Generates random traits within persona
- Determines legendary status (~1.5-2%)
- Assigns ETHDenver marker slot
- Stores everything immutably

**Persona Weighting** (`_selectWeightedPersona()`)
- Uses available supply as weight
- Tapers as persona supply targets approached
- Ensures all personas hit targets
- Fair distribution

**Randomness** (`_random()`)
- Pseudo-random using block data
- Adequate for art distribution
- Can upgrade to Chainlink VRF if needed

## 💾 Metadata Structure

On-chain JSON (via `getMetadata()`):
```json
{
  "name": "XAO ETHDenver #42",
  "description": "A cultural artifact marking early participation at XAO ETHDenver 2025",
  "image": "https://ipfs.io/ipfs/QmXXXXXX/42.png",
  "attributes": [
    { "trait_type": "Persona", "value": "Hip Hop" },
    { "trait_type": "Background", "value": "BG_1" },
    { "trait_type": "Head", "value": "HEAD_2" },
    { "trait_type": "Accessory", "value": "ACC_0" },
    { "trait_type": "Accent", "value": "ACCENT_1" },
    { "trait_type": "Legendary", "value": "False" },
    { "trait_type": "ETHDenver", "value": "True" }
  ]
}
```

## 🧪 Testing

Run full test suite:
```bash
npx hardhat test
```

Run specific test:
```bash
npx hardhat test test/XAOETHDenver.test.js --grep "Minting"
```

Test coverage:
- ✅ Deployment & initialization
- ✅ Mint window control
- ✅ Minting mechanics (single, batch)
- ✅ Wallet limits & supply caps
- ✅ Trait assignment & randomness
- ✅ Legendary detection
- ✅ Metadata generation
- ✅ Access control
- ✅ Gas optimization
- ✅ Edge cases

## 📊 Gas Cost Estimates (Base Network)

| Action | Gas | Cost (@ 10 gwei) |
|--------|-----|-----------------|
| Deploy ERC721A | 1,800,000 | ~0.018 ETH |
| Mint 1 NFT (first) | 85,000 | ~0.00085 ETH |
| Mint 1 NFT (batch) | 60,000 | ~0.0006 ETH |
| Transfer | 50,000 | ~0.0005 ETH |

**For 10,000 free mints**: ~550 ETH total gas cost (ERC721A savings!)

## 🌐 Network Configuration

### Base Mainnet
- **RPC**: https://mainnet.base.org
- **Chain ID**: 8453
- **Explorer**: https://basescan.org/

### Base Sepolia (Testnet)
- **RPC**: https://sepolia.base.org
- **Chain ID**: 84532
- **Explorer**: https://sepolia.basescan.org/

## 📋 Pre-Mint Checklist

- [ ] Images uploaded to IPFS, URI verified
- [ ] Contract deployed and verified on Basescan
- [ ] Test mint successful
- [ ] Metadata frozen (if all minted)
- [ ] Mint window set correctly
- [ ] Owner address verified
- [ ] Backup of deployment info
- [ ] Discord/social announcements ready
- [ ] Frontend integration complete
- [ ] Secondary trading enabled (OpenSea)

## ⚙️ Advanced Configuration

### Chainlink VRF Integration (Optional)

For higher security randomness:

```solidity
// Add to contract imports
import "@chainlink/contracts/src/v0.8/VRFConsumerBaseV2.sol";

// Implement VRFConsumerBaseV2
contract XAOETHDenverNFT_VRF is ERC721A, Ownable, VRFConsumerBaseV2 {
  // ...randomness via Chainlink instead
}
```

### Emergency Functions

```bash
# Reset wallet mint count (emergency)
npx hardhat run --eval "
  const contract = await ethers.getContractAt('XAOETHDenverNFT_ERC721A', '0x...');
  await contract.resetMintCount('0xUserAddress');
"
```

## 🔒 Security Considerations

✅ **What's Secure**
- Mint window control (owner-protected)
- Supply caps enforced
- Persona randomness adequate for art
- No external dependencies in core logic

⚠️ **Trade-offs**
- Pseudo-random (adequate for art, not gambling)
- Single signer deployment (consider multi-sig for mainnet)

❌ **What's NOT Included (By Design)**
- No utility tokens
- No governance rights
- No revenue sharing
- No future promises

## 📞 Support & Feedback

- **GitHub Issues**: Report bugs and requests
- **Basescan**: View transactions and contract
- **OpenSea**: View collection once deployed

## 📄 License

MIT License - See LICENSE file

## 🙏 Credits

- **Azuki** - ERC721A standard
- **OpenZeppelin** - Security libraries
- **Base** - Network infrastructure

---

## Quick Reference Commands

```bash
# Setup
npm install
npm install --save-dev hardhat

# Compile
npx hardhat compile

# Test
npx hardhat test

# Deploy to Base testnet
npx hardhat run scripts/deploy.js --network baseSepolia

# Deploy to Base mainnet
npx hardhat run scripts/deploy.js --network base

# Set mint window
npx hardhat run scripts/setMintWindow.js --network base

# Test mint
npx hardhat run scripts/testMint.js --network base

# Check status
npx hardhat run scripts/status.js --network base

# Close mint
npx hardhat run scripts/closeMint.js --network base

# Freeze metadata
npx hardhat run scripts/freezeMetadata.js --network base

# Verify contract
npx hardhat verify --network base 0xAddress "https://ipfs.io/ipfs/QmXXXXXX/"
```

---

**Built with ❤️ for ETHDenver 2025**

*A cultural artifact. Not a financial instrument.*
