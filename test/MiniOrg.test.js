// test/MiniOrg.test.js
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;

const ROLE = {
  MEMBER:    ethers.id("ROLE_MEMBER"),
  OPERATOR:  ethers.id("ROLE_OPERATOR"),
  TREASURER: ethers.id("ROLE_TREASURER"),
  ADMIN:     ethers.id("ROLE_ADMIN"),
  OWNER:     ethers.id("ROLE_OWNER"),
};
const GRANT = {
  OWNER:     ethers.id("OWNER_GRANT"),
  ADMIN:     ethers.id("ADMIN_GRANT"),
  TREASURER: ethers.id("TREASURER_GRANT"),
  OPERATOR:  ethers.id("OPERATOR_GRANT"),
  MEMBER:    ethers.id("MEMBER_GRANT"),
  TRIAL:     ethers.id("TRIAL_GRANT"),
  TEMP:      ethers.id("TEMP_GRANT"),
  CUSTOM:    ethers.id("CUSTOM_GRANT"),
};

const as = (user, role, expiresAt = 0) => ({ user: user.address ?? user, role, expiresAt });

describe("Mini-Org (wallet, grants, factory)", function () {
  let registry, walletImpl, grantImpl, factory;
  let deployer, boot, ownerA, ownerB, admin, treasurer, operator, member, stranger;
  let org;

  async function parse(receipt, name) {
    const log = receipt.logs
      .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === name);
    return log;
  }

  async function newOrg(creator = boot, salt = ethers.id("org-1"), rootAdmins = [boot.address], treasury = ZERO_ADDRESS) {
    const receipt = await (await factory.connect(creator)
      .createMiniOrg(salt, treasury, rootAdmins, ethers.id("meta"), "ipfs://org")).wait();
    const log = await parse(receipt, "MiniOrgCreated");
    return ethers.getContractAt("MiniOrgWallet", log.args.org);
  }

  async function makeGrant(wallet, caller, type, assignments, from = 0, to = 0) {
    const receipt = await (await factory.connect(caller)
      .createGrant(wallet.target, type, from, to, ZERO_BYTES32, "", assignments)).wait();
    const log = await parse(receipt, "GrantCreated");
    return ethers.getContractAt("MiniOrgGrant", log.args.grant);
  }

  async function attach(wallet, caller, grant) {
    return wallet.connect(caller).addGrant(grant.target);
  }

  async function grantAndAttach(wallet, caller, type, assignments, from = 0, to = 0) {
    const g = await makeGrant(wallet, caller, type, assignments, from, to);
    await attach(wallet, caller, g);
    return g;
  }

  // An org with a first owner already in place (bootstrap over).
  async function matureOrg() {
    const w = await newOrg(boot, ethers.id("mature"));
    const og = await grantAndAttach(w, boot, GRANT.OWNER, [as(ownerA, ROLE.OWNER), as(ownerA, ROLE.ADMIN)]);
    return { w, og };
  }

  beforeEach(async function () {
    [deployer, boot, ownerA, ownerB, admin, treasurer, operator, member, stranger] = await ethers.getSigners();
    registry   = await (await ethers.getContractFactory("GraphRegistry")).deploy();
    walletImpl = await (await ethers.getContractFactory("MiniOrgWallet")).deploy();
    grantImpl  = await (await ethers.getContractFactory("MiniOrgGrant")).deploy();
    factory    = await (await ethers.getContractFactory("MiniOrgFactory"))
      .deploy(walletImpl.target, grantImpl.target, registry.target);
    org = await newOrg();
  });

  // ─── FACTORY AND SETUP ──────────────────────────────────────────────────
  describe("creating an org", function () {
    it("rejects zero implementations at construction", async function () {
      const F = await ethers.getContractFactory("MiniOrgFactory");
      await expect(F.deploy(ZERO_ADDRESS, grantImpl.target, registry.target)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(walletImpl.target, ZERO_ADDRESS, registry.target)).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("locks the implementations; only clones can be set up", async function () {
      await expect(walletImpl.initialize(ZERO_ADDRESS, [boot.address], ZERO_BYTES32, "", ZERO_ADDRESS, factory.target))
        .to.be.revertedWithCustomError(walletImpl, "AlreadyInitialized");
      await expect(grantImpl.initialize(org.target, boot.address, GRANT.MEMBER, 0, 0, ZERO_BYTES32, "", [as(member, ROLE.MEMBER)]))
        .to.be.revertedWithCustomError(grantImpl, "AlreadyInitialized");
    });

    it("cannot be set up twice", async function () {
      await expect(org.initialize(ZERO_ADDRESS, [boot.address], ZERO_BYTES32, "", ZERO_ADDRESS, factory.target))
        .to.be.revertedWithCustomError(org, "AlreadyInitialized");
    });

    it("lands at the predicted address, and the same creator and salt cannot be used twice", async function () {
      const salt = ethers.id("predicted");
      const predicted = await factory.predictMiniOrg(ownerA.address, salt);
      const w = await newOrg(ownerA, salt, [ownerA.address]);
      expect(w.target).to.equal(predicted);
      await expect(newOrg(ownerA, salt, [ownerA.address])).to.be.reverted;

      // Someone else using the same salt gets a different address; nobody can squat yours.
      const other = await factory.predictMiniOrg(ownerB.address, salt);
      expect(other).to.not.equal(predicted);
    });

    it("needs at least one bootstrap admin, and no zero address among them", async function () {
      await expect(newOrg(boot, ethers.id("none"), [])).to.be.revertedWithCustomError(walletImpl, "NoRootAdmins");
      await expect(newOrg(boot, ethers.id("zero"), [ZERO_ADDRESS])).to.be.revertedWithCustomError(walletImpl, "ZeroAddress");
      const many = Array.from({ length: 11 }, () => ethers.Wallet.createRandom().address);
      await expect(newOrg(boot, ethers.id("many"), many)).to.be.revertedWithCustomError(walletImpl, "TooManyRootAdmins");
    });

    it("keeps the funds in the wallet by default, or points at the Safe it was given", async function () {
      expect(await org.treasury()).to.equal(org.target);
      const safe = ethers.Wallet.createRandom().address;
      const w = await newOrg(boot, ethers.id("safe"), [boot.address], safe);
      expect(await w.treasury()).to.equal(safe);
    });

    it("starts in bootstrap mode with the given admins, and records the org", async function () {
      expect(await org.bootstrapMode()).to.equal(true);
      expect(await org.rootAdmins(boot.address)).to.equal(true);
      expect(await org.rootAdmins(stranger.address)).to.equal(false);
      expect(await factory.isMiniOrg(org.target)).to.equal(true);
      expect(await factory.getOrgCount()).to.equal(1);
      expect(await org.grantRegistry()).to.equal(factory.target);
      expect(await org.orgMetaCID()).to.equal("ipfs://org");
    });
  });

  // ─── BOOTSTRAP ──────────────────────────────────────────────────────────
  describe("bootstrap", function () {
    it("lets only a bootstrap admin create grants before any owner exists", async function () {
      await expect(factory.connect(stranger).createGrant(org.target, GRANT.MEMBER, 0, 0, ZERO_BYTES32, "", [as(member, ROLE.MEMBER)]))
        .to.be.revertedWithCustomError(factory, "NotAuthorized");
      await makeGrant(org, boot, GRANT.MEMBER, [as(member, ROLE.MEMBER)]);
    });

    it("keeps bootstrap on while only non-owner grants are attached", async function () {
      await grantAndAttach(org, boot, GRANT.ADMIN, [as(admin, ROLE.ADMIN)]);
      expect(await org.bootstrapMode()).to.equal(true);
      expect(await org.isAdmin(admin.address)).to.equal(true);
    });

    it("ends the moment the first owner grant is attached, and the bootstrap admin loses all power", async function () {
      const og = await makeGrant(org, boot, GRANT.OWNER, [as(ownerA, ROLE.OWNER)]);
      await expect(org.connect(boot).addGrant(og.target))
        .to.emit(org, "GrantAdded").withArgs(og.target, GRANT.OWNER)
        .and.to.emit(org, "BootstrapModeEnded");
      expect(await org.bootstrapMode()).to.equal(false);
      expect(await org.ownerGrantCount()).to.equal(1);

      // The bootstrap admin can do nothing now.
      await expect(factory.connect(boot).createGrant(org.target, GRANT.MEMBER, 0, 0, ZERO_BYTES32, "", [as(member, ROLE.MEMBER)]))
        .to.be.revertedWithCustomError(factory, "NotAuthorized");
      await expect(org.connect(boot).setTreasury(stranger.address)).to.be.revertedWithCustomError(org, "NotAuthorized");
      const mg = await makeGrant(org, ownerA, GRANT.MEMBER, [as(member, ROLE.MEMBER)]);
      await attach(org, ownerA, mg);
      await expect(org.connect(boot).disableGrant(mg.target)).to.be.revertedWithCustomError(org, "NotAuthorized");
      await expect(org.connect(boot).disableGrant(og.target)).to.be.revertedWithCustomError(org, "NotAuthorized");
    });

    it("lets a bootstrap admin set the treasury before any owner exists", async function () {
      await expect(org.connect(boot).setTreasury(stranger.address)).to.emit(org, "TreasuryUpdated").withArgs(stranger.address);
      await expect(org.connect(stranger).setTreasury(member.address)).to.be.revertedWithCustomError(org, "NotAuthorized");
      await expect(org.connect(boot).setTreasury(ZERO_ADDRESS)).to.be.revertedWithCustomError(org, "ZeroAddress");
    });
  });

  // ─── ATTACHING GRANTS ───────────────────────────────────────────────────
  describe("attaching grants", function () {
    let w;
    beforeEach(async function () {
      ({ w } = await matureOrg());
      await grantAndAttach(w, ownerA, GRANT.ADMIN, [as(admin, ROLE.ADMIN)]);
      await grantAndAttach(w, ownerA, GRANT.OPERATOR, [as(operator, ROLE.OPERATOR)]);
      await grantAndAttach(w, ownerA, GRANT.TREASURER, [as(treasurer, ROLE.TREASURER)]);
    });

    it("refuses a contract that did not come from the official factory", async function () {
      await expect(w.connect(ownerA).addGrant(stranger.address)).to.be.revertedWithCustomError(w, "NotAnOfficialGrant");

      // A genuine grant from a second, unofficial factory is just as foreign to this org.
      const other = await (await ethers.getContractFactory("MiniOrgFactory"))
        .deploy(walletImpl.target, grantImpl.target, registry.target);
      await other.connect(boot).createMiniOrg(ethers.id("x"), ZERO_ADDRESS, [boot.address], ZERO_BYTES32, "");
      const otherOrg = await other.predictMiniOrg(boot.address, ethers.id("x"));
      const receipt = await (await other.connect(boot)
        .createGrant(otherOrg, GRANT.MEMBER, 0, 0, ZERO_BYTES32, "", [as(member, ROLE.MEMBER)])).wait();
      const grantAddr = other.interface.parseLog(receipt.logs.find((l) => l.address === other.target)).args.grant;
      await expect(w.connect(ownerA).addGrant(grantAddr)).to.be.revertedWithCustomError(w, "NotAnOfficialGrant");
      expect(await factory.isOfficialGrant(grantAddr)).to.equal(false);
    });

    it("refuses a grant made for a different org", async function () {
      const w2 = await newOrg(boot, ethers.id("org-2"));
      const foreign = await makeGrant(w2, boot, GRANT.MEMBER, [as(member, ROLE.MEMBER)]);
      await expect(w.connect(ownerA).addGrant(foreign.target)).to.be.revertedWithCustomError(w, "WrongOrg");
    });

    it("refuses attaching the same grant twice", async function () {
      const g = await makeGrant(w, ownerA, GRANT.MEMBER, [as(member, ROLE.MEMBER)]);
      await attach(w, ownerA, g);
      await expect(attach(w, ownerA, g)).to.be.revertedWithCustomError(w, "GrantAlreadyAttached");
    });

    it("lets owners and admins attach ordinary grants, but not operators, treasurers or strangers", async function () {
      for (const who of [ownerA, admin]) {
        const g = await makeGrant(w, who, GRANT.MEMBER, [as(member, ROLE.MEMBER)]);
        await attach(w, who, g);
        await w.connect(ownerA).disableGrant(g.target);
      }
      for (const who of [operator, treasurer, member, stranger]) {
        await expect(factory.connect(who).createGrant(w.target, GRANT.MEMBER, 0, 0, ZERO_BYTES32, "", [as(member, ROLE.MEMBER)]))
          .to.be.revertedWithCustomError(factory, "NotAuthorized");
      }
      // A grant someone else made can still only be attached by someone allowed.
      const g = await makeGrant(w, ownerA, GRANT.MEMBER, [as(member, ROLE.MEMBER)]);
      await expect(attach(w, operator, g)).to.be.revertedWithCustomError(w, "NotAuthorized");
    });

    it("lets only owners create or attach owner grants; an admin cannot make themselves an owner", async function () {
      await expect(factory.connect(admin).createGrant(w.target, GRANT.OWNER, 0, 0, ZERO_BYTES32, "", [as(admin, ROLE.OWNER)]))
        .to.be.revertedWithCustomError(factory, "NotAuthorized");
      const og = await makeGrant(w, ownerA, GRANT.OWNER, [as(ownerB, ROLE.OWNER)]);
      await expect(attach(w, admin, og)).to.be.revertedWithCustomError(w, "NotAuthorized");
      await attach(w, ownerA, og);
      expect(await w.isOwner(ownerB.address)).to.equal(true);
      expect(await w.ownerGrantCount()).to.equal(2);
    });
  });

  // ─── ROLES ──────────────────────────────────────────────────────────────
  describe("roles", function () {
    let w;
    beforeEach(async function () {
      ({ w } = await matureOrg());
    });

    it("answers hasRole and the helpers from the attached grants", async function () {
      await grantAndAttach(w, ownerA, GRANT.ADMIN, [as(admin, ROLE.ADMIN), as(admin, ROLE.TREASURER)]);
      expect(await w.hasRole(admin.address, ROLE.ADMIN)).to.equal(true);
      expect(await w.isAdmin(admin.address)).to.equal(true);
      expect(await w.isTreasurer(admin.address)).to.equal(true);
      expect(await w.isOwner(admin.address)).to.equal(false);
      expect(await w.isOperator(admin.address)).to.equal(false);
      expect(await w.isMember(admin.address)).to.equal(false);
      expect(await w.isAdmin(stranger.address)).to.equal(false);
    });

    it("adds up roles from several grants", async function () {
      await grantAndAttach(w, ownerA, GRANT.MEMBER, [as(member, ROLE.MEMBER)]);
      await grantAndAttach(w, ownerA, GRANT.OPERATOR, [as(member, ROLE.OPERATOR)]);
      expect(await w.isMember(member.address)).to.equal(true);
      expect(await w.isOperator(member.address)).to.equal(true);
    });

    it("a grant that is made but not attached gives nothing", async function () {
      await makeGrant(w, ownerA, GRANT.ADMIN, [as(admin, ROLE.ADMIN)]);
      expect(await w.isAdmin(admin.address)).to.equal(false);
    });

    it("a trial membership stops on its end date", async function () {
      const end = (await time.latest()) + 1_000;
      await grantAndAttach(w, ownerA, GRANT.TRIAL, [as(member, ROLE.MEMBER)], 0, end);
      expect(await w.isMember(member.address)).to.equal(true);
      await time.increaseTo(end + 1);
      expect(await w.isMember(member.address)).to.equal(false);
    });

    it("a grant with a start date gives nothing until then", async function () {
      const start = (await time.latest()) + 1_000;
      await grantAndAttach(w, ownerA, GRANT.TEMP, [as(member, ROLE.MEMBER)], start, 0);
      expect(await w.isMember(member.address)).to.equal(false);
      await time.increaseTo(start + 1);
      expect(await w.isMember(member.address)).to.equal(true);
    });

    it("a single role can expire before the rest of the grant", async function () {
      const soon = (await time.latest()) + 500;
      await grantAndAttach(w, ownerA, GRANT.CUSTOM, [as(member, ROLE.MEMBER), as(member, ROLE.OPERATOR, soon)]);
      expect(await w.isOperator(member.address)).to.equal(true);
      await time.increaseTo(soon + 1);
      expect(await w.isOperator(member.address)).to.equal(false);
      expect(await w.isMember(member.address)).to.equal(true);
    });

    it("tells graph operators apart: owners, admins and operators yes; treasurers and members no", async function () {
      await grantAndAttach(w, ownerA, GRANT.ADMIN, [as(admin, ROLE.ADMIN)]);
      await grantAndAttach(w, ownerA, GRANT.OPERATOR, [as(operator, ROLE.OPERATOR)]);
      await grantAndAttach(w, ownerA, GRANT.TREASURER, [as(treasurer, ROLE.TREASURER)]);
      await grantAndAttach(w, ownerA, GRANT.MEMBER, [as(member, ROLE.MEMBER)]);
      expect(await w.isGraphOperator(ownerA.address)).to.equal(true);
      expect(await w.isGraphOperator(admin.address)).to.equal(true);
      expect(await w.isGraphOperator(operator.address)).to.equal(true);
      expect(await w.isGraphOperator(treasurer.address)).to.equal(false);
      expect(await w.isGraphOperator(member.address)).to.equal(false);
      expect(await w.isGraphOperator(stranger.address)).to.equal(false);
    });

    it("the existing container factory accepts an org operator, so the org wallet plugs into the graph", async function () {
      const sImpl = await (await ethers.getContractFactory("StakingParent")).deploy();
      const sFactory = await (await ethers.getContractFactory("StakingParentFactory")).deploy(sImpl.target, registry.target);
      await grantAndAttach(w, ownerA, GRANT.OPERATOR, [as(operator, ROLE.OPERATOR)]);
      await grantAndAttach(w, ownerA, GRANT.TREASURER, [as(treasurer, ROLE.TREASURER)]);

      await sFactory.connect(operator).createStakingParent(w.target, 1, ZERO_BYTES32, "");
      await expect(sFactory.connect(treasurer).createStakingParent(w.target, 1, ZERO_BYTES32, ""))
        .to.be.revertedWithCustomError(sFactory, "NotAuthorized");
    });
  });

  // ─── ENDING GRANTS ──────────────────────────────────────────────────────
  describe("ending grants", function () {
    let w, og, adminGrant, trial;
    beforeEach(async function () {
      ({ w, og } = await matureOrg());
      adminGrant = await grantAndAttach(w, ownerA, GRANT.ADMIN, [as(admin, ROLE.ADMIN)]);
      trial = await grantAndAttach(w, ownerA, GRANT.TRIAL, [as(member, ROLE.MEMBER)]);
    });

    it("an admin can end a trial member's grant at once", async function () {
      await expect(trial.connect(admin).revoke()).to.emit(trial, "GrantRevoked").withArgs(admin.address);
      expect(await trial.isActive()).to.equal(false);
      expect(await w.isMember(member.address)).to.equal(false);
    });

    it("strangers and the member themselves cannot end it, and it cannot be ended twice", async function () {
      await expect(trial.connect(stranger).revoke()).to.be.revertedWithCustomError(trial, "NotAuthorized");
      await expect(trial.connect(member).revoke()).to.be.revertedWithCustomError(trial, "NotAuthorized");
      await trial.connect(ownerA).revoke();
      await expect(trial.connect(ownerA).revoke()).to.be.revertedWithCustomError(trial, "AlreadyRevoked");
    });

    it("whoever created a grant keeps no power over it once they lose their own", async function () {
      // The admin makes a grant, then their own admin grant is ended.
      const made = await grantAndAttach(w, admin, GRANT.MEMBER, [as(stranger, ROLE.MEMBER)]);
      expect(await made.issuer()).to.equal(admin.address);
      await w.connect(ownerA).disableGrant(adminGrant.target);
      await expect(made.connect(admin).revoke()).to.be.revertedWithCustomError(made, "NotAuthorized");
      await made.connect(ownerA).revoke();
    });

    it("detaching a grant removes its authority and lets the org keep the list short", async function () {
      await expect(w.connect(admin).disableGrant(trial.target)).to.emit(w, "GrantDisabled").withArgs(trial.target);
      expect(await w.isMember(member.address)).to.equal(false);
      expect(await w.isGrantEnabled(trial.target)).to.equal(false);
      await expect(w.connect(admin).disableGrant(trial.target)).to.be.revertedWithCustomError(w, "GrantNotAttached");
      await expect(w.connect(stranger).disableGrant(adminGrant.target)).to.be.revertedWithCustomError(w, "NotAuthorized");
    });

    it("keeps every other grant working after one is detached from the middle of the list", async function () {
      const g3 = await grantAndAttach(w, ownerA, GRANT.OPERATOR, [as(operator, ROLE.OPERATOR)]);
      // list: [og, adminGrant, trial, g3]; remove the first, so the last takes its place.
      expect((await w.getGrants()).length).to.equal(4);
      await w.connect(ownerA).disableGrant(adminGrant.target);
      expect(await w.grantCount()).to.equal(3);
      expect(await w.isOperator(operator.address)).to.equal(true);
      expect(await w.isMember(member.address)).to.equal(true);
      expect(await w.isAdmin(admin.address)).to.equal(false);
      expect(await w.isGrantEnabled(g3.target)).to.equal(true);
      await w.connect(ownerA).disableGrant(g3.target);
      expect(await w.isOperator(operator.address)).to.equal(false);
      expect(await w.isMember(member.address)).to.equal(true);
    });

    it("a detached grant can be attached again", async function () {
      await w.connect(ownerA).disableGrant(trial.target);
      await attach(w, ownerA, trial);
      expect(await w.isMember(member.address)).to.equal(true);
    });
  });

  // ─── OWNERS ─────────────────────────────────────────────────────────────
  describe("owners", function () {
    let w, og;
    beforeEach(async function () {
      ({ w, og } = await matureOrg());
    });

    it("an owner grant cannot be ended on the grant itself, by anyone", async function () {
      for (const who of [ownerA, admin, boot, stranger]) {
        await expect(og.connect(who).revoke()).to.be.revertedWithCustomError(og, "OwnerGrantsEndThroughTheWallet");
      }
      expect(await w.isOwner(ownerA.address)).to.equal(true);
    });

    it("the last owner grant cannot be detached", async function () {
      await expect(w.connect(ownerA).disableGrant(og.target)).to.be.revertedWithCustomError(w, "CannotEndLastOwner");
      expect(await w.isOwner(ownerA.address)).to.equal(true);
    });

    it("an owner can hand over: add the new owner, then end the old grant", async function () {
      const og2 = await grantAndAttach(w, ownerA, GRANT.OWNER, [as(ownerB, ROLE.OWNER)]);
      await expect(w.connect(ownerA).disableGrant(og.target)).to.emit(w, "GrantDisabled");
      expect(await w.isOwner(ownerA.address)).to.equal(false);
      expect(await w.isOwner(ownerB.address)).to.equal(true);
      expect(await w.ownerGrantCount()).to.equal(1);
      // ...and now the new one is the last.
      await expect(w.connect(ownerB).disableGrant(og2.target)).to.be.revertedWithCustomError(w, "CannotEndLastOwner");
    });

    it("an admin cannot end an owner's access, even with two owners", async function () {
      await grantAndAttach(w, ownerA, GRANT.ADMIN, [as(admin, ROLE.ADMIN)]);
      await grantAndAttach(w, ownerA, GRANT.OWNER, [as(ownerB, ROLE.OWNER)]);
      await expect(w.connect(admin).disableGrant(og.target)).to.be.revertedWithCustomError(w, "NotAuthorized");
      expect(await w.isOwner(ownerA.address)).to.equal(true);
    });

    it("an owner can end another owner's grant while one remains", async function () {
      const og2 = await grantAndAttach(w, ownerA, GRANT.OWNER, [as(ownerB, ROLE.OWNER)]);
      await w.connect(ownerA).disableGrant(og2.target);
      expect(await w.isOwner(ownerB.address)).to.equal(false);
      expect(await w.isOwner(ownerA.address)).to.equal(true);
    });

    it("an owner grant must be permanent: no end date, no start delay, no role expiry", async function () {
      const end = (await time.latest()) + 10_000;
      await expect(factory.connect(ownerA).createGrant(w.target, GRANT.OWNER, 0, end, ZERO_BYTES32, "", [as(ownerB, ROLE.OWNER)]))
        .to.be.revertedWithCustomError(grantImpl, "OwnerGrantMustBePermanent");
      await expect(factory.connect(ownerA).createGrant(w.target, GRANT.OWNER, end, 0, ZERO_BYTES32, "", [as(ownerB, ROLE.OWNER)]))
        .to.be.revertedWithCustomError(grantImpl, "OwnerGrantMustBePermanent");
      await expect(factory.connect(ownerA).createGrant(w.target, GRANT.OWNER, 0, 0, ZERO_BYTES32, "", [as(ownerB, ROLE.OWNER, end)]))
        .to.be.revertedWithCustomError(grantImpl, "OwnerGrantMustBePermanent");
    });

    it("only an owner grant can confer the owner role, and an owner grant must confer it", async function () {
      await expect(factory.connect(ownerA).createGrant(w.target, GRANT.ADMIN, 0, 0, ZERO_BYTES32, "", [as(admin, ROLE.OWNER)]))
        .to.be.revertedWithCustomError(grantImpl, "OwnerRoleNeedsOwnerGrant");
      await expect(factory.connect(ownerA).createGrant(w.target, GRANT.OWNER, 0, 0, ZERO_BYTES32, "", [as(admin, ROLE.ADMIN)]))
        .to.be.revertedWithCustomError(grantImpl, "OwnerGrantNeedsOwnerRole");
    });

    it("lets owners (not admins) change the treasury", async function () {
      await grantAndAttach(w, ownerA, GRANT.ADMIN, [as(admin, ROLE.ADMIN)]);
      await expect(w.connect(admin).setTreasury(stranger.address)).to.be.revertedWithCustomError(w, "NotAuthorized");
      await expect(w.connect(ownerA).setTreasury(stranger.address)).to.emit(w, "TreasuryUpdated").withArgs(stranger.address);
      expect(await w.treasury()).to.equal(stranger.address);
    });
  });

  // ─── GRANT CONTENT RULES ────────────────────────────────────────────────
  describe("what a grant can contain", function () {
    let w;
    beforeEach(async function () {
      ({ w } = await matureOrg());
    });

    const create = (type, assignments, from = 0, to = 0, org_ = null) =>
      factory.connect(ownerA).createGrant((org_ ?? w).target, type, from, to, ZERO_BYTES32, "", assignments);

    it("rejects bad input", async function () {
      await expect(create(GRANT.MEMBER, [])).to.be.revertedWithCustomError(grantImpl, "NoAssignments");
      await expect(create(GRANT.MEMBER, [as(ZERO_ADDRESS, ROLE.MEMBER)])).to.be.revertedWithCustomError(grantImpl, "ZeroUser");
      await expect(create(GRANT.MEMBER, [as(member, ethers.id("ROLE_BOSS"))])).to.be.revertedWithCustomError(grantImpl, "InvalidRole");
      await expect(create(ethers.id("MADE_UP"), [as(member, ROLE.MEMBER)])).to.be.revertedWithCustomError(grantImpl, "InvalidGrantType");
      await expect(create(GRANT.MEMBER, [as(member, ROLE.MEMBER)], 100, 50)).to.be.revertedWithCustomError(grantImpl, "InvalidEffectiveWindow");
      await expect(create(GRANT.MEMBER, [as(member, ROLE.MEMBER)], 100, 100)).to.be.revertedWithCustomError(grantImpl, "InvalidEffectiveWindow");
      const tooMany = Array.from({ length: 21 }, () => as(ethers.Wallet.createRandom(), ROLE.MEMBER));
      await expect(create(GRANT.MEMBER, tooMany)).to.be.revertedWithCustomError(grantImpl, "TooManyAssignments");
    });

    it("rejects a grant for an address the factory did not make", async function () {
      await expect(create(GRANT.MEMBER, [as(member, ROLE.MEMBER)], 0, 0, { target: stranger.address }))
        .to.be.revertedWithCustomError(factory, "NotAnOrg");
    });

    it("records who, what and when", async function () {
      const g = await makeGrant(w, ownerA, GRANT.MEMBER, [as(member, ROLE.MEMBER), as(operator, ROLE.OPERATOR)]);
      expect(await g.org()).to.equal(w.target);
      expect(await g.issuer()).to.equal(ownerA.address);
      expect(await g.grantType()).to.equal(GRANT.MEMBER);
      expect(await g.getAssignees()).to.deep.equal([member.address, operator.address]);
      expect(await factory.isOfficialGrant(g.target)).to.equal(true);
      expect((await factory.getOrgGrants(w.target)).length).to.equal(2);   // the owner grant and this one
    });
  });

  // ─── LIMITS ─────────────────────────────────────────────────────────────
  describe("the grant limit", function () {
    it("allows 50 attached grants, refuses the 51st, and frees a slot when one is detached", async function () {
      const { w } = await matureOrg();                      // 1 attached
      const made = [];
      for (let i = 0; i < 49; i++) {
        made.push(await grantAndAttach(w, ownerA, GRANT.MEMBER, [as(ethers.Wallet.createRandom(), ROLE.MEMBER)]));
      }
      expect(await w.grantCount()).to.equal(50);

      const extra = await makeGrant(w, ownerA, GRANT.MEMBER, [as(member, ROLE.MEMBER)]);
      await expect(attach(w, ownerA, extra)).to.be.revertedWithCustomError(w, "TooManyGrants");

      // Permission checks still work with a full list.
      expect(await w.isOwner(ownerA.address)).to.equal(true);
      expect(await w.isMember(member.address)).to.equal(false);

      await w.connect(ownerA).disableGrant(made[0].target);
      await attach(w, ownerA, extra);
      expect(await w.isMember(member.address)).to.equal(true);
    });
  });
});
