// test/MiniOrgFlow.test.js
// Mini-Org wallets as the two parties of a real show: signing, funding, payouts,
// and the graph links that point at an org.
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  USDC, ONE_DAY, tier, deploySystem, showConfig, createShow,
} = require("./helpers/show");

const ZERO_BYTES32 = ethers.ZeroHash;
const ZERO_ADDRESS = ethers.ZeroAddress;
const ROLE  = { MEMBER: ethers.id("ROLE_MEMBER"), OPERATOR: ethers.id("ROLE_OPERATOR"), TREASURER: ethers.id("ROLE_TREASURER"), ADMIN: ethers.id("ROLE_ADMIN"), OWNER: ethers.id("ROLE_OWNER") };
const GRANT = { OWNER: ethers.id("OWNER_GRANT"), OPERATOR: ethers.id("OPERATOR_GRANT"), TREASURER: ethers.id("TREASURER_GRANT"), MEMBER: ethers.id("MEMBER_GRANT") };
const EdgeType   = { HAS_MODULE: 0, PARTICIPATES_AS: 8, OWNED_BY: 9, OPERATED_BY: 10 };
const EdgeStatus = { None: 0, Pending: 1, Active: 2, Inactive: 3 };
const Stream = { Guarantee: 0, TicketRevenue: 1 };

const as = (user, role) => ({ user: user.address, role, expiresAt: 0 });

describe("Mini-Org wallets as show parties", function () {
  let sys, usdc, orgFactory;
  let boot, ownerA, opA, trA, memberA, ownerB, opB, trB, stranger;
  let orgA, orgB;           // A is the venue/promoter (partyA), B is the band (partyB)
  let t0, showEnd;

  async function parse(receipt, name) {
    return receipt.logs
      .map((l) => { try { return orgFactory.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === name);
  }

  // An org with one owner, one operator, one treasurer (and optionally a member).
  async function buildOrg(salt, owner, operator, treasurer, member = null) {
    const receipt = await (await orgFactory.connect(boot)
      .createMiniOrg(ethers.id(salt), ZERO_ADDRESS, [boot.address], ZERO_BYTES32, "")).wait();
    const wallet = await ethers.getContractAt("MiniOrgWallet", (await parse(receipt, "MiniOrgCreated")).args.org);

    const attach = async (type, assignments) => {
      const r = await (await orgFactory.connect(boot)
        .createGrant(wallet.target, type, 0, 0, ZERO_BYTES32, "", assignments)).wait();
      const g = (await parse(r, "GrantCreated")).args.grant;
      await wallet.connect(boot).addGrant(g);
    };
    await attach(GRANT.OPERATOR, [as(operator, ROLE.OPERATOR)]);
    await attach(GRANT.TREASURER, [as(treasurer, ROLE.TREASURER)]);
    if (member) await attach(GRANT.MEMBER, [as(member, ROLE.MEMBER)]);
    await attach(GRANT.OWNER, [as(owner, ROLE.OWNER)]);          // last: this ends bootstrap
    return wallet;
  }

  async function newShow(name, overrides = {}) {
    return createShow(sys.factory, opA, showConfig({ address: orgA.target }, { address: orgB.target }, t0, {
      anchors: { termsHash: ethers.id(name) },
      funding: [],
      tiers: [tier({ quantity: 100 })],
      ...overrides,
    }));
  }

  const call = (wallet, who, target, iface, fn, args = []) =>
    wallet.connect(who).executeAsParty(target.target ?? target, iface.interface.encodeFunctionData(fn, args));

  async function signedShow(name, overrides) {
    const b = await newShow(name, overrides);
    await call(orgA, opA, b.show, b.show, "signTerms");
    await call(orgB, ownerB, b.show, b.show, "signTerms");
    return b;
  }

  async function fund(b, amount) {
    await usdc.mint(orgA.target, amount);
    await orgA.connect(trA).approveERC20(usdc.target, b.escrow.target, amount);
    await call(orgA, opA, b.escrow, b.escrow, "deposit", [amount]);
  }

  beforeEach(async function () {
    [boot, , , , , ownerA, opA, trA, memberA, ownerB, opB, trB, stranger] = await ethers.getSigners();
    sys = await deploySystem();
    usdc = sys.usdc;
    orgFactory = await (await ethers.getContractFactory("MiniOrgFactory")).deploy(
      (await (await ethers.getContractFactory("MiniOrgWallet")).deploy()).target,
      (await (await ethers.getContractFactory("MiniOrgGrant")).deploy()).target,
      sys.registry.target
    );
    orgA = await buildOrg("venue", ownerA, opA, trA, memberA);
    orgB = await buildOrg("band", ownerB, opB, trB);
    t0 = await time.latest();
    showEnd = t0 + 30 * ONE_DAY + 7_200;
  });

  // ─── THE WHOLE SHOW ─────────────────────────────────────────────────────
  describe("a whole show between two orgs", function () {
    it("is signed by the orgs' people, funded from org funds, and pays the orgs", async function () {
      const b = await newShow("whole-show");
      expect(await b.show.partyA()).to.equal(orgA.target);
      expect(await b.show.partyB()).to.equal(orgB.target);

      // An operator signs for the venue; the band's owner signs for the band.
      await expect(call(orgA, opA, b.show, b.show, "signTerms"))
        .to.emit(orgA, "ExecutedAsParty").withArgs(opA.address, b.show.target, b.show.interface.getFunction("signTerms").selector)
        .and.to.emit(b.show, "TermsSigned").withArgs(orgA.target);
      expect(await b.show.isFinalized()).to.equal(false);
      await call(orgB, ownerB, b.show, b.show, "signTerms");
      expect(await b.show.isFinalized()).to.equal(true);

      // The venue's treasurer lets the escrow take $1,000; the venue's operator funds the show.
      await fund(b, USDC(1_000));
      expect(await usdc.balanceOf(b.escrow.target)).to.equal(USDC(1_000));
      expect(await usdc.balanceOf(orgA.target)).to.equal(0);

      // Pay-outs are not tied to any person: the band's $500 guarantee goes to the band's wallet.
      await time.increaseTo(t0 + 15 * ONE_DAY);
      await b.escrow.connect(stranger).executeAvailablePayouts();
      expect(await usdc.balanceOf(orgB.target)).to.equal(USDC(500));

      // After the show the rest is split 40/60 between the two org wallets.
      await time.increaseTo(showEnd);
      await b.escrow.connect(stranger).executeFinalSweep();
      expect(await usdc.balanceOf(orgA.target)).to.equal(USDC(200));
      expect(await usdc.balanceOf(orgB.target)).to.equal(USDC(800));

      // What each org earned is recorded under the org's own address.
      expect(await b.escrow.earnedBy(orgB.target, Stream.Guarantee)).to.equal(USDC(500));
      expect(await b.escrow.earnedBy(orgB.target, Stream.TicketRevenue)).to.equal(USDC(300));
      expect(await b.escrow.earnedBy(orgA.target, Stream.TicketRevenue)).to.equal(USDC(200));
      expect(await b.escrow.earnedBy(opB.address, Stream.Guarantee)).to.equal(0);      // not the person
    });

    it("lets the band's treasurer, not an operator, pay out of what the band earned", async function () {
      const b = await signedShow("spend");
      await fund(b, USDC(1_000));
      await time.increaseTo(showEnd);
      await b.escrow.connect(stranger).executeFinalSweep();

      await expect(orgB.connect(opB).transferERC20(usdc.target, stranger.address, USDC(100)))
        .to.be.revertedWithCustomError(orgB, "NotAuthorized");
      await orgB.connect(trB).transferERC20(usdc.target, stranger.address, USDC(100));
      await expect(orgB.connect(ownerB).transferERC20(usdc.target, stranger.address, USDC(100)))
        .to.emit(orgB, "ERC20Transferred").withArgs(usdc.target, stranger.address, USDC(100));
      expect(await usdc.balanceOf(stranger.address)).to.equal(USDC(200));
      expect(await usdc.balanceOf(orgB.target)).to.equal(USDC(600));
    });

    it("passes the show's own error up when a call fails", async function () {
      const b = await signedShow("errors");
      await expect(call(orgA, opA, b.show, b.show, "signTerms")).to.be.reverted;      // already signed
      await expect(call(orgA, opA, b.escrow, b.escrow, "claim")).to.be.revertedWithCustomError(b.escrow, "NothingToClaim");
    });
  });

  // ─── WHO MAY ACT FOR THE ORG ────────────────────────────────────────────
  describe("who may act for the org", function () {
    let b;
    beforeEach(async function () {
      b = await newShow("auth");
    });

    it("owners and operators can act; treasurers, members and strangers cannot", async function () {
      for (const who of [trA, memberA, stranger, opB]) {
        await expect(call(orgA, who, b.show, b.show, "signTerms")).to.be.revertedWithCustomError(orgA, "NotAuthorized");
      }
      expect(await b.show.hasSigned(orgA.target)).to.equal(false);
      await call(orgA, ownerA, b.show, b.show, "signTerms");
      expect(await b.show.hasSigned(orgA.target)).to.equal(true);
    });

    it("a person who left the org can no longer act for it", async function () {
      const operatorGrant = (await orgA.getGrants())[0];          // attached first, in buildOrg
      expect(await (await ethers.getContractAt("MiniOrgGrant", operatorGrant)).hasRole(opA.address, ROLE.OPERATOR)).to.equal(true);
      await orgA.connect(ownerA).disableGrant(operatorGrant);
      await expect(call(orgA, opA, b.show, b.show, "signTerms")).to.be.revertedWithCustomError(orgA, "NotAuthorized");
    });

    it("only reaches contracts the org is a party of", async function () {
      // A token, a person, and a show the org has nothing to do with.
      const data = b.show.interface.encodeFunctionData("signTerms");
      await expect(orgA.connect(opA).executeAsParty(usdc.target, data)).to.be.revertedWithCustomError(orgA, "NotAPartyContract");
      await expect(orgA.connect(opA).executeAsParty(stranger.address, data)).to.be.revertedWithCustomError(orgA, "NotAPartyContract");
      await expect(orgA.connect(opA).executeAsParty(orgA.target, data)).to.be.revertedWithCustomError(orgA, "NotAPartyContract");

      const other = await createShow(sys.factory, stranger, showConfig(stranger, { address: orgB.target }, t0, {
        anchors: { termsHash: ethers.id("not-orgA") }, funding: [], tiers: [tier({ quantity: 10 })],
      }));
      await expect(orgA.connect(opA).executeAsParty(other.show.target, data)).to.be.revertedWithCustomError(orgA, "NotAPartyContract");
      await orgB.connect(opB).executeAsParty(other.show.target, data);     // orgB is a party there
    });

    it("an operator cannot move the org's tokens or create an allowance, so funding stays with treasurers", async function () {
      await call(orgA, ownerA, b.show, b.show, "signTerms");
      await call(orgB, ownerB, b.show, b.show, "signTerms");
      await usdc.mint(orgA.target, USDC(1_000));

      await expect(orgA.connect(opA).approveERC20(usdc.target, b.escrow.target, USDC(1_000)))
        .to.be.revertedWithCustomError(orgA, "NotAuthorized");
      await expect(orgA.connect(memberA).transferERC20(usdc.target, stranger.address, 1))
        .to.be.revertedWithCustomError(orgA, "NotAuthorized");
      // Without an allowance the operator's deposit moves nothing.
      await expect(call(orgA, opA, b.escrow, b.escrow, "deposit", [USDC(1_000)])).to.be.reverted;
      expect(await usdc.balanceOf(orgA.target)).to.equal(USDC(1_000));

      // And it can move no more than the treasurer approved.
      await orgA.connect(trA).approveERC20(usdc.target, b.escrow.target, USDC(400));
      await expect(call(orgA, opA, b.escrow, b.escrow, "deposit", [USDC(500)])).to.be.reverted;
      await call(orgA, opA, b.escrow, b.escrow, "deposit", [USDC(400)]);
      expect(await usdc.balanceOf(b.escrow.target)).to.equal(USDC(400));
    });

    it("token functions are off when the org's funds are in an external Safe", async function () {
      const safe = ethers.Wallet.createRandom().address;
      await orgA.connect(ownerA).setTreasury(safe);
      await expect(orgA.connect(trA).transferERC20(usdc.target, stranger.address, 1))
        .to.be.revertedWithCustomError(orgA, "TreasuryIsElsewhere");
      await expect(orgA.connect(trA).approveERC20(usdc.target, stranger.address, 1))
        .to.be.revertedWithCustomError(orgA, "TreasuryIsElsewhere");
      // Acting as a party still works.
      await call(orgA, opA, b.show, b.show, "signTerms");
    });
  });

  // ─── GRAPH LINKS ────────────────────────────────────────────────────────
  describe("graph links for an org", function () {
    let b;
    beforeEach(async function () {
      b = await signedShow("graph");
    });

    it("recognises the org's owners, admins and operators, and nobody else", async function () {
      expect(await sys.registry.isAuthorizedFor(orgA.target, opA.address)).to.equal(true);
      expect(await sys.registry.isAuthorizedFor(orgA.target, ownerA.address)).to.equal(true);
      expect(await sys.registry.isAuthorizedFor(orgA.target, trA.address)).to.equal(false);
      expect(await sys.registry.isAuthorizedFor(orgA.target, memberA.address)).to.equal(false);
      expect(await sys.registry.isAuthorizedFor(orgA.target, opB.address)).to.equal(false);
      // The same people also act for the show, because the org is its partyA.
      expect(await sys.registry.isAuthorizedFor(b.show.target, opA.address)).to.equal(true);
      expect(await sys.registry.isAuthorizedFor(b.show.target, trA.address)).to.equal(false);
    });

    it("an operator links the show to the org with OWNED_BY, active at once", async function () {
      const id = await sys.registry.connect(opA).registerEdge.staticCall(b.show.target, orgA.target, EdgeType.OWNED_BY, ZERO_BYTES32, "");
      await sys.registry.connect(opA).registerEdge(b.show.target, orgA.target, EdgeType.OWNED_BY, ZERO_BYTES32, "");
      expect(await sys.registry.edgeStatus(id)).to.equal(EdgeStatus.Active);
    });

    it("a treasurer, a member or a stranger cannot link anything to the org", async function () {
      for (const who of [trA, memberA, stranger]) {
        await expect(sys.registry.connect(who).registerEdge(b.show.target, orgA.target, EdgeType.OWNED_BY, ZERO_BYTES32, ""))
          .to.be.revertedWithCustomError(sys.registry, "NotAuthorized");
      }
    });

    it("the other org's operator confirms a link the venue proposes; a treasurer cannot", async function () {
      // The venue's operator says: the band takes part in this show. The venue's side
      // is covered by the operator, so the band's side stays pending.
      const args = [orgB.target, b.show.target, EdgeType.PARTICIPATES_AS, ZERO_BYTES32, ""];
      const id = await sys.registry.connect(opA).registerEdge.staticCall(...args);
      await sys.registry.connect(opA).registerEdge(...args);
      expect(await sys.registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);

      await expect(sys.registry.connect(trB).confirmEdge(id)).to.be.revertedWithCustomError(sys.registry, "NothingToConfirm");
      await expect(sys.registry.connect(opA).confirmEdge(id)).to.be.revertedWithCustomError(sys.registry, "NothingToConfirm");
      expect(await sys.registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);

      await sys.registry.connect(opB).confirmEdge(id);
      expect(await sys.registry.edgeStatus(id)).to.equal(EdgeStatus.Active);
    });

    it("someone outside both orgs cannot link anything to the venue's show", async function () {
      await expect(sys.registry.connect(stranger).registerEdge(b.show.target, orgA.target, EdgeType.OWNED_BY, ZERO_BYTES32, ""))
        .to.be.revertedWithCustomError(sys.registry, "NotAuthorized");

      // The band is the show's partyB, so its operator may propose the link, but it is the
      // venue that must agree to be named the owner: the edge waits for the venue.
      const args = [b.show.target, orgA.target, EdgeType.OWNED_BY, ZERO_BYTES32, ""];
      const id = await sys.registry.connect(opB).registerEdge.staticCall(...args);
      await sys.registry.connect(opB).registerEdge(...args);
      expect(await sys.registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);
      await expect(sys.registry.connect(opB).confirmEdge(id)).to.be.revertedWithCustomError(sys.registry, "NothingToConfirm");
      await sys.registry.connect(opA).confirmEdge(id);
      expect(await sys.registry.edgeStatus(id)).to.equal(EdgeStatus.Active);
    });
  });
});
