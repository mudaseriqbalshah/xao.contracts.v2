// test/FanMembership.test.js
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;
const DAY = 86_400;
const USDC = (n) => ethers.parseUnits(String(n), 6);
const ScopeType = { BAND: 0, VENUE: 1, PROMOTER: 2, TOUR: 3, SERIES: 4, COLLECTIVE: 5, GLOBAL: 6 };
const ROLE = { OPERATOR: ethers.id("ROLE_OPERATOR"), TREASURER: ethers.id("ROLE_TREASURER"), ADMIN: ethers.id("ROLE_ADMIN"), OWNER: ethers.id("ROLE_OWNER") };
const GRANT = { OWNER: ethers.id("OWNER_GRANT"), ADMIN: ethers.id("ADMIN_GRANT"), OPERATOR: ethers.id("OPERATOR_GRANT") };
const EdgeType = { OWNED_BY: 9 };
const EdgeStatus = { Active: 2 };

describe("FanMembership", function () {
  let usdc, impl, factory, registry;
  let issuer, fan, fan2, stranger, receiver, band;
  let program;

  function programInit(overrides = {}) {
    return {
      issuer: issuer.address,
      scopeType: ScopeType.BAND,
      scopeRef: band.address,
      name: "Band Fans",
      symbol: "FANS",
      baseURI: "ipfs://fans/",
      renewable: true,
      maxSupply: 0,
      paymentToken: usdc.target,
      paymentReceiver: receiver.address,
      saleStart: 0,
      saleEnd: 0,
      ...overrides,
    };
  }

  async function deployProgram(creator, init) {
    const receipt = await (await factory.connect(creator).createProgram(init)).wait();
    const log = receipt.logs
      .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === "FanMembershipProgramDeployed");
    return ethers.getContractAt("FanMembership", log.args.program);
  }

  // tier(name, priority, duration, price, renewalPrice, cap, purchasable)
  const newTier = (who, p = {}) => program.connect(who).createTier(
    p.name ?? "Gold", p.meta ?? "ipfs://gold", p.priority ?? 2, p.duration ?? 30 * DAY,
    p.price ?? USDC(10), p.renewal ?? USDC(8), p.cap ?? 0, p.purchasable ?? true
  );

  async function buyFor(payer, tierId, recipient) {
    const t = await program.getTier(tierId);
    await usdc.mint(payer.address, t.price);
    await usdc.connect(payer).approve(program.target, t.price);
    return program.connect(payer).purchaseMembership(tierId, recipient.address);
  }

  beforeEach(async function () {
    [, issuer, fan, fan2, stranger, receiver, band] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
    registry = await (await ethers.getContractFactory("GraphRegistry")).deploy();
    impl = await (await ethers.getContractFactory("FanMembership")).deploy();
    factory = await (await ethers.getContractFactory("FanMembershipFactory")).deploy(impl.target);
    program = await deployProgram(issuer, programInit());
    await newTier(issuer);            // tier 1: Gold, 30 days, $10, renews at $8
  });

  // ─── FACTORY AND SETUP ──────────────────────────────────────────────────
  describe("creating a program", function () {
    it("rejects a zero implementation", async function () {
      const F = await ethers.getContractFactory("FanMembershipFactory");
      await expect(F.deploy(ZERO_ADDRESS)).to.be.revertedWithCustomError(F, "ZeroImplementation");
    });

    it("is created by the issuer, and recorded", async function () {
      expect(await program.issuer()).to.equal(issuer.address);
      expect(await program.scopeRef()).to.equal(band.address);
      expect(await program.name()).to.equal("Band Fans");
      expect(await factory.getProgramCount()).to.equal(1);
      expect(await factory.getIssuerPrograms(issuer.address)).to.deep.equal([program.target]);
    });

    it("cannot be created for someone else", async function () {
      await expect(factory.connect(stranger).createProgram(programInit()))
        .to.be.revertedWithCustomError(factory, "NotAuthorized");
    });

    it("locks the implementation and cannot be set up twice", async function () {
      await expect(impl.initialize(programInit())).to.be.revertedWithCustomError(impl, "AlreadyInitialized");
      await expect(program.initialize(programInit())).to.be.revertedWithCustomError(program, "AlreadyInitialized");
    });

    it("rejects bad setup", async function () {
      await expect(deployProgram(issuer, programInit({ issuer: ZERO_ADDRESS }))).to.be.reverted;
      await expect(deployProgram(issuer, programInit({ scopeRef: ZERO_ADDRESS })))
        .to.be.revertedWithCustomError(impl, "ZeroScopeRef");
      await deployProgram(issuer, programInit({ scopeType: ScopeType.GLOBAL, scopeRef: ZERO_ADDRESS }));
      await expect(deployProgram(issuer, programInit({ saleStart: 100, saleEnd: 100 })))
        .to.be.revertedWithCustomError(impl, "InvalidSaleWindow");
    });
  });

  // ─── TIERS ──────────────────────────────────────────────────────────────
  describe("tiers", function () {
    it("only the issuer shapes the program", async function () {
      await expect(newTier(stranger)).to.be.revertedWithCustomError(program, "NotManager");
      await expect(program.connect(stranger).setTierPricing(1, 0, 0)).to.be.revertedWithCustomError(program, "NotManager");
      await expect(program.connect(stranger).setPaused(true)).to.be.revertedWithCustomError(program, "NotManager");
      await expect(program.connect(stranger).setPaymentConfig(usdc.target, stranger.address)).to.be.revertedWithCustomError(program, "NotManager");
    });

    it("stores the tier and counts them", async function () {
      const t = await program.getTier(1);
      expect(t.name).to.equal("Gold");
      expect(t.priority).to.equal(2);
      expect(t.baseDuration).to.equal(30 * DAY);
      expect(t.price).to.equal(USDC(10));
      expect(t.active).to.equal(true);
      expect(await program.tierCount()).to.equal(1);
      await expect(program.getTier(0)).to.be.revertedWithCustomError(program, "UnknownTier");
      await expect(program.getTier(2)).to.be.revertedWithCustomError(program, "UnknownTier");
    });

    it("a price needs a payment token and a receiver", async function () {
      const free = await deployProgram(issuer, programInit({ paymentToken: ZERO_ADDRESS, paymentReceiver: ZERO_ADDRESS }));
      await expect(free.connect(issuer).createTier("Paid", "", 1, DAY, 1, 0, 0, true))
        .to.be.revertedWithCustomError(free, "PriceNeedsPaymentToken");
      await free.connect(issuer).createTier("Free", "", 1, DAY, 0, 0, 0, true);
      await expect(free.connect(issuer).setTierPricing(1, 5, 0)).to.be.revertedWithCustomError(free, "PriceNeedsPaymentToken");
    });

    it("allows at most 50 tiers", async function () {
      for (let i = 0; i < 49; i++) await program.connect(issuer).createTier(`T${i}`, "", 1, DAY, 0, 0, 0, false);
      expect(await program.tierCount()).to.equal(50);
      await expect(newTier(issuer)).to.be.revertedWithCustomError(program, "TooManyTiers");
    });

    it("a changed price applies to later purchases only", async function () {
      await buyFor(fan, 1, fan);
      await program.connect(issuer).setTierPricing(1, USDC(20), USDC(15));
      expect((await program.getMembership(1)).tierId).to.equal(1);
      await usdc.mint(fan2.address, USDC(20));
      await usdc.connect(fan2).approve(program.target, USDC(10));
      await expect(program.connect(fan2).purchaseMembership(1, fan2.address)).to.be.reverted;     // $10 allowance is no longer enough
    });
  });

  // ─── BUYING ─────────────────────────────────────────────────────────────
  describe("buying a membership", function () {
    it("takes the price, pays the receiver, and mints a token that expires", async function () {
      const before = await usdc.balanceOf(receiver.address);
      const tx = await buyFor(fan, 1, fan);
      const now = await time.latest();
      await expect(tx).to.emit(program, "MembershipPurchased").withArgs(1, fan.address, 1, fan.address, USDC(10), now + 30 * DAY)
        .and.to.emit(program, "Transfer").withArgs(ZERO_ADDRESS, fan.address, 1)
        .and.to.emit(program, "Locked").withArgs(1);
      expect(await usdc.balanceOf(receiver.address)).to.equal(before + USDC(10));
      expect(await program.ownerOf(1)).to.equal(fan.address);
      expect(await program.balanceOf(fan.address)).to.equal(1);
      expect(await program.supplyMinted()).to.equal(1);
      const m = await program.getMembership(1);
      expect(m.holder).to.equal(fan.address);
      expect(m.expiresAt).to.equal(now + 30 * DAY);
      expect(m.sourceType).to.equal(await program.SOURCE_PURCHASE());
    });

    it("lets someone pay for a friend, who becomes the holder", async function () {
      await buyFor(fan, 1, fan2);
      expect(await program.ownerOf(1)).to.equal(fan2.address);
      expect(await program.isHolderActiveMember(fan2.address, 1)).to.equal(true);
      expect(await program.isHolderActiveMember(fan.address, 1)).to.equal(false);
    });

    it("refuses without enough allowance or balance, and to the zero address", async function () {
      await expect(program.connect(fan).purchaseMembership(1, fan.address)).to.be.reverted;
      await usdc.mint(fan.address, USDC(10));
      await usdc.connect(fan).approve(program.target, USDC(10));
      await expect(program.connect(fan).purchaseMembership(1, ZERO_ADDRESS)).to.be.revertedWithCustomError(program, "ZeroRecipient");
      await expect(program.connect(fan).purchaseMembership(9, fan.address)).to.be.revertedWithCustomError(program, "UnknownTier");
    });

    it("a free tier can only be taken for yourself, so wallets cannot be filled with memberships they did not ask for", async function () {
      await program.connect(issuer).createTier("Free", "", 1, 0, 0, 0, 0, true);      // tier 2
      await expect(program.connect(stranger).purchaseMembership(2, fan.address))
        .to.be.revertedWithCustomError(program, "FreeMembershipIsForSelf");
      await program.connect(fan).purchaseMembership(2, fan.address);
      expect(await program.balanceOf(fan.address)).to.equal(1);
    });

    it("a tier that is not for sale, or switched off, cannot be bought", async function () {
      await program.connect(issuer).createTier("Invite only", "", 3, DAY, 0, 0, 0, false);      // tier 2
      await expect(program.connect(fan).purchaseMembership(2, fan.address)).to.be.revertedWithCustomError(program, "TierNotPurchasable");
      await program.connect(issuer).setTierActive(1, false);
      await expect(program.connect(fan).purchaseMembership(1, fan.address)).to.be.revertedWithCustomError(program, "TierNotActive");
    });

    it("follows the sale window", async function () {
      const now = await time.latest();
      await program.connect(issuer).setSaleWindow(now + 1_000, now + 2_000);
      await expect(program.connect(fan).purchaseMembership(1, fan.address)).to.be.revertedWithCustomError(program, "SaleNotOpen");
      await time.increaseTo(now + 1_500);
      await buyFor(fan, 1, fan);
      await time.increaseTo(now + 2_500);
      await expect(program.connect(fan2).purchaseMembership(1, fan2.address)).to.be.revertedWithCustomError(program, "SaleNotOpen");
      await expect(program.connect(issuer).setSaleWindow(10, 10)).to.be.revertedWithCustomError(program, "InvalidSaleWindow");
    });

    it("stops at the program supply and at the tier cap", async function () {
      const small = await deployProgram(issuer, programInit({ maxSupply: 2 }));
      await small.connect(issuer).createTier("T", "", 1, DAY, 0, 0, 0, false);
      await small.connect(issuer).grantMembership(1, fan.address, ZERO_BYTES32, ZERO_BYTES32);
      await small.connect(issuer).grantMembership(1, fan2.address, ZERO_BYTES32, ZERO_BYTES32);
      await expect(small.connect(issuer).grantMembership(1, stranger.address, ZERO_BYTES32, ZERO_BYTES32))
        .to.be.revertedWithCustomError(small, "SoldOut");

      await program.connect(issuer).createTier("Capped", "", 1, DAY, 0, 0, 1, true);      // tier 2, cap 1
      await program.connect(fan).purchaseMembership(2, fan.address);
      await expect(program.connect(fan2).purchaseMembership(2, fan2.address)).to.be.revertedWithCustomError(program, "TierSoldOut");
    });

    it("one wallet can hold at most 20 memberships", async function () {
      await program.connect(issuer).createTier("Many", "", 1, DAY, 0, 0, 0, false);      // tier 2
      for (let i = 0; i < 20; i++) await program.connect(issuer).grantMembership(2, fan.address, ZERO_BYTES32, ZERO_BYTES32);
      await expect(program.connect(issuer).grantMembership(2, fan.address, ZERO_BYTES32, ZERO_BYTES32))
        .to.be.revertedWithCustomError(program, "TooManyMemberships");
      expect(await program.isHolderActiveMember(fan.address, 0)).to.equal(true);       // queries still work when full
    });

    it("a paused program issues and renews nothing", async function () {
      await buyFor(fan, 1, fan);
      await expect(program.connect(issuer).setPaused(true)).to.emit(program, "ProgramPaused");
      await expect(program.connect(fan2).purchaseMembership(1, fan2.address)).to.be.revertedWithCustomError(program, "ProgramPaused_");
      await expect(program.connect(issuer).grantMembership(1, fan2.address, ZERO_BYTES32, ZERO_BYTES32)).to.be.revertedWithCustomError(program, "ProgramPaused_");
      await expect(program.connect(fan).renewMembership(1)).to.be.revertedWithCustomError(program, "ProgramPaused_");
      await expect(program.connect(issuer).setPaused(false)).to.emit(program, "ProgramUnpaused");
      await program.connect(issuer).grantMembership(1, fan2.address, ZERO_BYTES32, ZERO_BYTES32);
    });
  });

  // ─── GRANTING ───────────────────────────────────────────────────────────
  describe("granting a membership", function () {
    it("lets the issuer give one for free, even for a tier that is not for sale, and records where it came from", async function () {
      await program.connect(issuer).setTierPurchasable(1, false);
      const source = ethers.id("TICKET_BUNDLE");
      const ref = ethers.id("show-42");
      await expect(program.connect(issuer).grantMembership(1, fan.address, source, ref))
        .to.emit(program, "MembershipGranted");
      const m = await program.getMembership(1);
      expect(m.sourceType).to.equal(source);
      expect(m.sourceRef).to.equal(ref);
      expect(await usdc.balanceOf(receiver.address)).to.equal(0);          // nothing was paid
    });

    it("refuses strangers and fans, and inactive tiers", async function () {
      await expect(program.connect(stranger).grantMembership(1, fan.address, ZERO_BYTES32, ZERO_BYTES32))
        .to.be.revertedWithCustomError(program, "NotOperator");
      await expect(program.connect(fan).grantMembership(1, fan.address, ZERO_BYTES32, ZERO_BYTES32))
        .to.be.revertedWithCustomError(program, "NotOperator");
      await program.connect(issuer).setTierActive(1, false);
      await expect(program.connect(issuer).grantMembership(1, fan.address, ZERO_BYTES32, ZERO_BYTES32))
        .to.be.revertedWithCustomError(program, "TierNotActive");
    });
  });

  // ─── EXPIRY AND RENEWAL ─────────────────────────────────────────────────
  describe("expiry and renewal", function () {
    it("is active until its end date, then expired but still held", async function () {
      await buyFor(fan, 1, fan);
      const end = Number((await program.getMembership(1)).expiresAt);
      expect(await program.isMembershipActive(1)).to.equal(true);
      await time.increaseTo(end);                          // the end date itself still counts
      expect(await program.isMembershipActive(1)).to.equal(true);
      await time.increaseTo(end + 1);
      expect(await program.isMembershipActive(1)).to.equal(false);
      expect(await program.isHolderActiveMember(fan.address, 0)).to.equal(false);
      expect(await program.ownerOf(1)).to.equal(fan.address);          // kept as history
      expect(await program.balanceOf(fan.address)).to.equal(1);
    });

    it("a permanent tier never expires, and cannot be renewed", async function () {
      await program.connect(issuer).createTier("Founder", "", 9, 0, 0, 0, 0, false);      // tier 2, permanent
      await program.connect(issuer).grantMembership(2, fan.address, ZERO_BYTES32, ZERO_BYTES32);
      await time.increase(3_650 * DAY);
      expect(await program.isMembershipActive(1)).to.equal(true);
      await expect(program.connect(fan).renewMembership(1)).to.be.revertedWithCustomError(program, "PermanentMembership");
    });

    it("renewing before the end adds a period after the old end", async function () {
      await buyFor(fan, 1, fan);
      const end = Number((await program.getMembership(1)).expiresAt);
      await usdc.mint(fan.address, USDC(8));
      await usdc.connect(fan).approve(program.target, USDC(8));
      const before = await usdc.balanceOf(receiver.address);
      await expect(program.connect(fan).renewMembership(1))
        .to.emit(program, "MembershipRenewed").withArgs(1, fan.address, USDC(8), end + 30 * DAY);
      expect(await usdc.balanceOf(receiver.address)).to.equal(before + USDC(8));
      expect((await program.getMembership(1)).expiresAt).to.equal(end + 30 * DAY);
    });

    it("renewing after it ended starts a new period from now", async function () {
      await buyFor(fan, 1, fan);
      const end = Number((await program.getMembership(1)).expiresAt);
      await time.increaseTo(end + 10 * DAY);
      expect(await program.isMembershipActive(1)).to.equal(false);
      await usdc.mint(fan.address, USDC(8));
      await usdc.connect(fan).approve(program.target, USDC(8));
      await program.connect(fan).renewMembership(1);
      const now = await time.latest();
      expect((await program.getMembership(1)).expiresAt).to.equal(now + 30 * DAY);
      expect(await program.isMembershipActive(1)).to.equal(true);
    });

    it("anyone can pay for a renewal, and a program that is not renewable refuses", async function () {
      await buyFor(fan, 1, fan);
      await usdc.mint(stranger.address, USDC(8));
      await usdc.connect(stranger).approve(program.target, USDC(8));
      await program.connect(stranger).renewMembership(1);
      expect(await usdc.balanceOf(stranger.address)).to.equal(0);

      const fixed = await deployProgram(issuer, programInit({ renewable: false }));
      await fixed.connect(issuer).createTier("T", "", 1, DAY, 0, 0, 0, false);
      await fixed.connect(issuer).grantMembership(1, fan.address, ZERO_BYTES32, ZERO_BYTES32);
      await expect(fixed.connect(fan).renewMembership(1)).to.be.revertedWithCustomError(fixed, "NotRenewable");
      await expect(program.connect(fan).renewMembership(77)).to.be.revertedWithCustomError(program, "NoSuchToken");
    });
  });

  // ─── QUERIES ────────────────────────────────────────────────────────────
  describe("queries", function () {
    beforeEach(async function () {
      await program.connect(issuer).createTier("Silver", "", 1, 10 * DAY, USDC(2), 0, 0, true);      // tier 2, priority 1
      await buyFor(fan, 2, fan);                                                                  // token 1: Silver, 10 days
    });

    it("tells whether a wallet is an active member, in any tier or a given one", async function () {
      expect(await program.isHolderActiveMember(fan.address, 0)).to.equal(true);
      expect(await program.isHolderActiveMember(fan.address, 2)).to.equal(true);
      expect(await program.isHolderActiveMember(fan.address, 1)).to.equal(false);
      expect(await program.isHolderActiveMember(stranger.address, 0)).to.equal(false);
    });

    it("compares tiers by priority", async function () {
      expect(await program.hasActiveTier(fan.address, 1)).to.equal(true);
      expect(await program.hasActiveTier(fan.address, 2)).to.equal(false);      // Silver is priority 1
      await buyFor(fan, 1, fan);                                                  // also Gold (priority 2)
      expect(await program.hasActiveTier(fan.address, 2)).to.equal(true);
    });

    it("looks at every membership a wallet holds, and ignores expired ones", async function () {
      await buyFor(fan, 1, fan);                                                  // token 2: Gold, 30 days
      expect(await program.getHolderMemberships(fan.address)).to.deep.equal([1n, 2n]);
      await time.increase(15 * DAY);                                              // Silver is over, Gold is not
      expect(await program.isHolderActiveMember(fan.address, 2)).to.equal(false);
      expect(await program.isHolderActiveMember(fan.address, 1)).to.equal(true);
      expect(await program.hasActiveTier(fan.address, 1)).to.equal(true);        // Gold (priority 2) still counts
    });

    it("an unknown token is not active and has no owner", async function () {
      expect(await program.isMembershipActive(99)).to.equal(false);
      await expect(program.ownerOf(99)).to.be.revertedWithCustomError(program, "NoSuchToken");
      await expect(program.getMembership(99)).to.be.revertedWithCustomError(program, "NoSuchToken");
    });

    it("works through the IFanMembership interface other modules use", async function () {
      const asModule = await ethers.getContractAt("IFanMembership", program.target);
      expect(await asModule.issuer()).to.equal(issuer.address);
      expect(await asModule.isHolderActiveMember(fan.address, 0)).to.equal(true);
      expect(await asModule.hasActiveTier(fan.address, 1)).to.equal(true);
      expect(await asModule.isMembershipActive(1)).to.equal(true);
    });
  });

  // ─── SOULBOUND ──────────────────────────────────────────────────────────
  describe("soulbound token", function () {
    beforeEach(async function () {
      await buyFor(fan, 1, fan);
    });

    it("can never be moved, approved or handed over", async function () {
      await expect(program.connect(fan).transferFrom(fan.address, fan2.address, 1)).to.be.revertedWithCustomError(program, "Soulbound");
      await expect(program.connect(fan)["safeTransferFrom(address,address,uint256)"](fan.address, fan2.address, 1)).to.be.revertedWithCustomError(program, "Soulbound");
      await expect(program.connect(fan)["safeTransferFrom(address,address,uint256,bytes)"](fan.address, fan2.address, 1, "0x")).to.be.revertedWithCustomError(program, "Soulbound");
      await expect(program.connect(fan).approve(fan2.address, 1)).to.be.revertedWithCustomError(program, "Soulbound");
      await expect(program.connect(fan).setApprovalForAll(fan2.address, true)).to.be.revertedWithCustomError(program, "Soulbound");
      await expect(program.connect(issuer).transferFrom(fan.address, issuer.address, 1)).to.be.revertedWithCustomError(program, "Soulbound");
      expect(await program.ownerOf(1)).to.equal(fan.address);
    });

    it("reads like a normal ERC-721 to a wallet or app, and says it is locked", async function () {
      expect(await program.locked(1)).to.equal(true);
      expect(await program.getApproved(1)).to.equal(ZERO_ADDRESS);
      expect(await program.isApprovedForAll(fan.address, fan2.address)).to.equal(false);
      expect(await program.tokenURI(1)).to.equal("ipfs://fans/1");
      expect(await program.symbol()).to.equal("FANS");
      for (const id of ["0x01ffc9a7", "0x80ac58cd", "0x5b5e139f", "0xb45a3c0e"]) {
        expect(await program.supportsInterface(id)).to.equal(true);
      }
      expect(await program.supportsInterface("0xffffffff")).to.equal(false);
      await expect(program.locked(5)).to.be.revertedWithCustomError(program, "NoSuchToken");
      await expect(program.tokenURI(5)).to.be.revertedWithCustomError(program, "NoSuchToken");
    });

    it("the manager can change where metadata lives", async function () {
      await program.connect(issuer).setBaseURI("ipfs://new/");
      expect(await program.tokenURI(1)).to.equal("ipfs://new/1");
      await expect(program.connect(fan).setBaseURI("x")).to.be.revertedWithCustomError(program, "NotManager");
    });
  });

  // ─── MINI-ORG AS ISSUER ─────────────────────────────────────────────────
  describe("an org wallet as issuer", function () {
    let org, orgProgram, owner, admin, operator, treasurer;

    async function makeOrg() {
      [, , , , , , , owner, admin, operator, treasurer] = await ethers.getSigners();
      const wImpl = await (await ethers.getContractFactory("MiniOrgWallet")).deploy();
      const gImpl = await (await ethers.getContractFactory("MiniOrgGrant")).deploy();
      const of = await (await ethers.getContractFactory("MiniOrgFactory")).deploy(wImpl.target, gImpl.target, registry.target);
      const r = await (await of.connect(owner).createMiniOrg(ethers.id("venue"), ZERO_ADDRESS, [owner.address], ZERO_BYTES32, "")).wait();
      const w = await ethers.getContractAt("MiniOrgWallet", of.interface.parseLog(r.logs.find((l) => l.address === of.target && of.interface.parseLog(l)?.name === "MiniOrgCreated")).args.org);
      const attach = async (type, user, role) => {
        const rr = await (await of.connect(owner).createGrant(w.target, type, 0, 0, ZERO_BYTES32, "", [{ user: user.address, role, expiresAt: 0 }])).wait();
        const g = of.interface.parseLog(rr.logs.find((l) => l.address === of.target && of.interface.parseLog(l)?.name === "GrantCreated")).args.grant;
        await w.connect(owner).addGrant(g);
      };
      await attach(GRANT.ADMIN, admin, ROLE.ADMIN);
      await attach(GRANT.OPERATOR, operator, ROLE.OPERATOR);
      await attach(GRANT.OWNER, owner, ROLE.OWNER);
      return w;
    }

    beforeEach(async function () {
      org = await makeOrg();
      orgProgram = await deployProgram(operator, programInit({ issuer: org.target, scopeType: ScopeType.VENUE, scopeRef: org.target }));
      await orgProgram.connect(owner).createTier("Regular", "", 1, 30 * DAY, 0, 0, 0, false);
    });

    it("lets the org's owners, admins and operators create the program, and nobody else", async function () {
      for (const who of [owner, admin, operator]) await deployProgram(who, programInit({ issuer: org.target, scopeRef: org.target }));
      await expect(factory.connect(treasurer).createProgram(programInit({ issuer: org.target, scopeRef: org.target })))
        .to.be.revertedWithCustomError(factory, "NotAuthorized");
      await expect(factory.connect(stranger).createProgram(programInit({ issuer: org.target, scopeRef: org.target })))
        .to.be.revertedWithCustomError(factory, "NotAuthorized");
    });

    it("owners and admins shape the program; an operator and a treasurer cannot", async function () {
      await orgProgram.connect(owner).createTier("Owner tier", "", 1, DAY, 0, 0, 0, false);
      await orgProgram.connect(admin).createTier("Admin tier", "", 1, DAY, 0, 0, 0, false);
      await expect(orgProgram.connect(operator).createTier("x", "", 1, DAY, 0, 0, 0, false)).to.be.revertedWithCustomError(orgProgram, "NotManager");
      await expect(orgProgram.connect(treasurer).setPaused(true)).to.be.revertedWithCustomError(orgProgram, "NotManager");
      await expect(orgProgram.connect(operator).setPaymentConfig(usdc.target, operator.address)).to.be.revertedWithCustomError(orgProgram, "NotManager");
    });

    it("operators give memberships out, treasurers and strangers cannot", async function () {
      await orgProgram.connect(operator).grantMembership(1, fan.address, ZERO_BYTES32, ZERO_BYTES32);
      await orgProgram.connect(admin).grantMembership(1, fan2.address, ZERO_BYTES32, ZERO_BYTES32);
      await expect(orgProgram.connect(treasurer).grantMembership(1, stranger.address, ZERO_BYTES32, ZERO_BYTES32))
        .to.be.revertedWithCustomError(orgProgram, "NotOperator");
      expect(await orgProgram.isHolderActiveMember(fan.address, 1)).to.equal(true);
    });

    it("a person who leaves the org loses the power at once", async function () {
      let ended = 0;
      for (const g of await org.getGrants()) {
        const grant = await ethers.getContractAt("MiniOrgGrant", g);
        if (await grant.hasRole(operator.address, ROLE.OPERATOR)) {
          await org.connect(owner).disableGrant(g);
          ended++;
        }
      }
      expect(ended).to.equal(1);
      await expect(orgProgram.connect(operator).grantMembership(1, fan.address, ZERO_BYTES32, ZERO_BYTES32))
        .to.be.revertedWithCustomError(orgProgram, "NotOperator");
    });

    it("is a graph node of the org: its operators can link the program to the org with OWNED_BY", async function () {
      expect(await orgProgram.partyA()).to.equal(org.target);
      expect(await orgProgram.partyB()).to.equal(ZERO_ADDRESS);
      expect(await registry.isAuthorizedFor(orgProgram.target, operator.address)).to.equal(true);
      expect(await registry.isAuthorizedFor(orgProgram.target, stranger.address)).to.equal(false);

      const args = [orgProgram.target, org.target, EdgeType.OWNED_BY, ZERO_BYTES32, ""];
      const id = await registry.connect(operator).registerEdge.staticCall(...args);
      await registry.connect(operator).registerEdge(...args);
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Active);
      await expect(registry.connect(stranger).registerEdge(...args)).to.be.reverted;
    });
  });
});
