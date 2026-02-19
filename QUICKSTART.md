// QUICKSTART.md

# 🚀 XAO ETHDenver NFT - Quick Start Guide

Get your NFT collection deployed in 10 minutes!

## 📋 Prerequisites

- Node.js >= 18.0 ([install](https://nodejs.org/))
- npm >= 9.0 (comes with Node)
- A wallet with Base ETH (~0.5 ETH for deployment)
- Your IPFS metadata URI (from Pinata or NFT.storage)

## ⚡ 5-Minute Setup

### Step 1: Install Dependencies
```bash
npm install
```
That's it! All packages including Hardhat will install.

### Step 2: Configure Environment
```bash
# Copy template
cp .env.example .env

# Edit .env with your values
nano .env
# or use your favorite editor
```

**Required values:**
- `PRIVATE_KEY`: Your wallet's private key (from MetaMask)
- `BASE_URI`: Your IPFS metadata URL

### Step 3: Compile Contracts
```bash
npm run compile
```

### Step 4: Run Tests (Optional but Recommended)
```bash
npm test
```

## 🌐 Deploy to Base

### First Time? Test on Testnet
```bash
npm run deploy:sepolia
```

✅ This deploys to Base Sepolia (testnet) - great for testing!

### Deploy to Base Mainnet
```bash
npm run deploy:base
```

✅ Your contract is now live on Base!

## ⚙️ Configure Collection

### 1. Set Mint Window
```bash
npm run mint:set-window
```
Edit the dates in `scripts/setMintWindow.js` first:
```javascript
const startDate = new Date("2025-02-28T08:00:00Z");  // Your start
const endDate = new Date("2025-03-03T20:00:00Z");    // Your end
```

### 2. Test Minting
```bash
npm run mint:test
```
This mints 1 NFT and shows all traits!

### 3. Check Status Anytime
```bash
npm run status
```
Shows collection stats, personas, and gas costs.

## 🎯 During ETHDenver

### Monitor Activity
```bash
# Run every hour during event
npm run status
```

### Close Mint When Done
```bash
npm run mint:close
```

### Freeze Metadata (Final Step)
```bash
npm run metadata:freeze
```
⚠️ This is PERMANENT! Only do this when you're sure.

## 📊 All Available Commands

```bash
# Compilation
npm run compile          # Compile contracts

# Testing
npm test                 # Run full test suite
npm run test:gas         # Show gas costs

# Deployment
npm run deploy:sepolia   # Deploy to Base testnet
npm run deploy:base      # Deploy to Base mainnet

# Operations
npm run mint:set-window  # Set mint window times
npm run mint:test        # Test minting
npm run status           # Check collection status
npm run mint:close       # Close mint window
npm run metadata:freeze  # Freeze metadata (PERMANENT)

# Verification
npm run verify           # Verify on Basescan

# Cleanup
npm run clean            # Clean build artifacts
```

## 📂 Project Structure

```
xao-ethdenver-nft/
├── contracts/
│   ├── XAOETHDenverNFT_ERC721A.sol    ← Main contract
│   └── XAOETHDenverNFT.sol            ← Alternative
├── scripts/
│   ├── deploy.js                      ← Deploy contract
│   ├── setMintWindow.js               ← Set mint times
│   ├── testMint.js                    ← Test minting
│   ├── status.js                      ← Check status
│   ├── closeMint.js                   ← Close mint
│   └── freezeMetadata.js              ← Freeze (FINAL)
├── test/
│   └── XAOETHDenver.test.js           ← Tests
├── deployments/                       ← Auto-generated
│   └── base-deployment.json           ← Save your address!
├── hardhat.config.js                  ← Hardhat config
├── package.json                       ← Dependencies
├── .env.example                       ← Copy to .env
└── .gitignore                         ← Don't commit secrets
```

## 🔐 Security Checklist

Before deploying:

- [ ] Private key is in `.env` (not committed to git)
- [ ] `BASE_URI` points to your IPFS metadata
- [ ] Tested on Base Sepolia first
- [ ] Wallet has enough ETH (~0.5)
- [ ] `.env` is in `.gitignore`

## 🆘 Troubleshooting

**"Insufficient funds"**
```
Fund your wallet with Base ETH
Get from faucet: https://faucet.base.org/
```

**"Contract does not exist"**
```
npm run compile
# Then try deploy again
```

**"Mint window not open"**
```
Run: npm run mint:set-window
# Edit dates in script first!
```

**"Cannot find module"**
```
npm install
# Reinstall all dependencies
```

## 📖 Full Documentation

For detailed info, see:
- **README.md** - Complete API reference
- **DEPLOYMENT_GUIDE.txt** - Step-by-step guide
- **DELIVERABLES.md** - Feature summary

## 💡 Pro Tips

1. **Always test on testnet first**
   ```bash
   npm run deploy:sepolia
   npm run test
   ```

2. **Save your contract address**
   - Saved in: `deployments/base-deployment.json`
   - You'll need this for everything!

3. **Monitor with status command**
   ```bash
   npm run status  # Run frequently during event
   ```

4. **Backup your private key**
   - Store `.env` securely
   - Never share it with anyone

5. **Verify on Basescan**
   ```bash
   npm run verify 0xYourAddress "https://ipfs.io/ipfs/QmXXX/"
   ```

## 🚀 Example Workflow

```bash
# 1. Setup (5 min)
npm install
cp .env.example .env
# Edit .env with your values

# 2. Test locally (2 min)
npm test

# 3. Deploy to testnet (5 min)
npm run deploy:sepolia

# 4. Test mint on testnet (2 min)
npm run mint:test

# 5. Deploy to mainnet (5 min)
npm run deploy:base

# 6. Configure mint window (1 min)
npm run mint:set-window

# 7. Monitor during event (ongoing)
npm run status

# 8. Close mint window (1 min)
npm run mint:close

# 9. Freeze metadata (1 min) - FINAL STEP
npm run metadata:freeze
```

## 📞 Need Help?

1. Check the **DEPLOYMENT_GUIDE.txt** - has troubleshooting section
2. Check the **README.md** - has API reference
3. Check Hardhat docs: https://hardhat.org/docs
4. Check Base docs: https://docs.base.org/

## 🎉 You're Ready!

Your XAO ETHDenver NFT collection is ready to deploy!

```bash
npm run deploy:base
```

Good luck! 🚀

---

**Built for ETHDenver 2025**

*Questions? Everything is documented in the guide files.*
https://sepolia.basescan.org/address/0xce1960114318676834252fe78447c27501161149#code