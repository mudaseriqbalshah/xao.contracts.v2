// test/StandingAgreement.test.js
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time }   = require("@nomicfoundation/hardhat-network-helpers");

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const ZERO_BYTES32 = ethers.ZeroHash;
const ZERO_ADDRESS = ethers.ZeroAddress;
const TERMS_HASH   = ethers.id("standing-terms");

const Kind   = { Generic: 0, Membership: 1, Representation: 2, Employment: 3, Partnership: 4, Sponsorship: 5, Crew: 6 };
const Status = { Draft: 0, Active: 1, Terminated: 2, Superseded: 3 };
const Stream = { Guarantee: 0, TicketRevenue: 1, MerchRevenue: 2, BarRevenue: 3, SponsorshipRevenue: 4, Other: 5 };
const EdgeType   = { APPLIES_TO: 3 };
const EdgeStatus = { None: 0, Pending: 1, Active: 2, Inactive: 3 };

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function init(partyA, partyB, overrides = {}) {
  return {
    partyA,
    partyB,
    kind: Kind.Representation,
    effectiveFrom: 0,
    effectiveTo: 0,
    termsHash: TERMS_HASH,
    termsCID: "ipfs://standing-terms",
    supersedes: ZERO_ADDRESS,
    streams: [],
    flatPayments: [],
    flags: [],
    ...overrides,
  };
}

async function deploySystem() {
  const impl = await (await ethers.getContractFactory("StandingAgreement")).deploy();
  await impl.waitForDeployment();
  const factory = await (await ethers.getContractFactory("StandingAgreementFactory")).deploy(impl.target);
  await factory.waitForDeployment();
  const registry = await (await ethers.getContractFactory("GraphRegistry")).deploy();
  await registry.waitForDeployment();
  return { impl, factory, registry };
}

async function create(factory, creator, args) {
  const receipt = await (await factory.connect(creator).createAgreement(args)).wait();
  const log = receipt.logs
    .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((l) => l && l.name === "AgreementCreated");
  return ethers.getContractAt("StandingAgreement", log.args.agreement);
}

function edgeIdOf(from, to, edgeType) {
  return ethers.solidityPackedKeccak256(
    ["address", "address", "uint8", "bytes32"],
    [from, to, edgeType, ZERO_BYTES32]
  );
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

describe("StandingAgreement", function () {
  let impl, factory, registry;
  let agent, band, venue, artist, stranger, member;

  beforeEach(async function () {
    [, agent, band, venue, artist, stranger, member] = await ethers.getSigners();
    ({ impl, factory, registry } = await deploySystem());
  });

  describe("StandingAgreementFactory", function () {
    it("rejects a zero implementation", async function () {
      const F = await ethers.getContractFactory("StandingAgreementFactory");
      await expect(F.deploy(ZERO_ADDRESS)).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("lets only one of the agreement's own parties create it", async function () {
      await expect(factory.connect(stranger).createAgreement(init(agent.address, band.address)))
        .to.be.revertedWithCustomError(factory, "NotAParty");
      await expect(factory.connect(stranger).createAgreement(init(agent.address, ZERO_ADDRESS)))
        .to.be.revertedWithCustomError(factory, "NotAParty");

      await create(factory, agent, init(agent.address, band.address));
      await create(factory, band, init(agent.address, band.address, { termsHash: ethers.id("other") }));
    });

    it("records the agreement for both parties", async function () {
      const a = await create(factory, agent, init(agent.address, band.address, { kind: Kind.Membership }));
      expect(await factory.getAgreementCount()).to.equal(1);
      expect(await factory.getUserAgreements(agent.address)).to.deep.equal([a.target]);
      expect(await factory.getUserAgreements(band.address)).to.deep.equal([a.target]);
      expect(await factory.getUserAgreements(stranger.address)).to.deep.equal([]);
    });
  });

  describe("Initialization", function () {
    it("stores the terms and starts as a Draft", async function () {
      const a = await create(factory, agent, init(agent.address, band.address, {
        kind: Kind.Membership, effectiveFrom: 100, effectiveTo: 200,
      }));
      expect(await a.partyA()).to.equal(agent.address);
      expect(await a.partyB()).to.equal(band.address);
      expect(await a.kind()).to.equal(Kind.Membership);
      expect(await a.effectiveFrom()).to.equal(100);
      expect(await a.effectiveTo()).to.equal(200);
      expect(await a.termsHash()).to.equal(TERMS_HASH);
      expect(await a.termsCID()).to.equal("ipfs://standing-terms");
      expect(await a.status()).to.equal(Status.Draft);
      expect(await registry.getRequiredConfirmersForNode(a.target))
        .to.deep.equal([agent.address, band.address]);
    });

    it("cannot be initialized twice, and the implementation is locked", async function () {
      const a = await create(factory, agent, init(agent.address, band.address));
      await expect(a.initialize(init(agent.address, band.address)))
        .to.be.revertedWithCustomError(a, "AlreadyInitialized");
      await expect(impl.initialize(init(agent.address, band.address)))
        .to.be.revertedWithCustomError(impl, "AlreadyInitialized");
    });

    it("rejects missing parties, missing terms and a bad window", async function () {
      await expect(factory.connect(agent).createAgreement(init(ZERO_ADDRESS, agent.address)))
        .to.be.reverted;
      await expect(factory.connect(agent).createAgreement(init(agent.address, agent.address)))
        .to.be.revertedWithCustomError(impl, "SamePartyOnBothSides");
      await expect(factory.connect(agent).createAgreement(init(agent.address, band.address, { termsHash: ZERO_BYTES32 })))
        .to.be.revertedWithCustomError(impl, "ZeroTermsHash");
      await expect(factory.connect(agent).createAgreement(
        init(agent.address, band.address, { effectiveFrom: 200, effectiveTo: 200 })
      )).to.be.revertedWithCustomError(impl, "InvalidEffectiveWindow");
    });
  });

  describe("Signing", function () {
    it("becomes Active once both parties have signed", async function () {
      const a = await create(factory, agent, init(agent.address, band.address));
      await expect(a.connect(agent).sign()).to.emit(a, "Signed").withArgs(agent.address);
      expect(await a.status()).to.equal(Status.Draft);
      await expect(a.connect(band).sign()).to.emit(a, "Activated");
      expect(await a.status()).to.equal(Status.Active);
    });

    it("becomes Active after one signature when there is only one party", async function () {
      const a = await create(factory, agent, init(agent.address, ZERO_ADDRESS, { kind: Kind.Employment }));
      await a.connect(agent).sign();
      expect(await a.status()).to.equal(Status.Active);
    });

    it("rejects a non-party, a second signature, or signing once Active", async function () {
      const a = await create(factory, agent, init(agent.address, band.address));
      await expect(a.connect(stranger).sign()).to.be.revertedWithCustomError(a, "NotAParty");
      await a.connect(agent).sign();
      await expect(a.connect(agent).sign()).to.be.revertedWithCustomError(a, "AlreadySigned");
      await a.connect(band).sign();
      await expect(a.connect(band).sign()).to.be.revertedWithCustomError(a, "NotDraft");
    });

    it("is only in effect while Active and inside its window", async function () {
      const now = await time.latest();
      const a = await create(factory, agent, init(agent.address, band.address, {
        effectiveFrom: now + 1_000, effectiveTo: now + 2_000,
      }));
      expect(await a.isInEffect()).to.equal(false);   // Draft
      await a.connect(agent).sign();
      await a.connect(band).sign();
      expect(await a.isInEffect()).to.equal(false);   // before the window
      await time.increaseTo(now + 1_500);
      expect(await a.isInEffect()).to.equal(true);
      await time.increaseTo(now + 2_500);
      expect(await a.isInEffect()).to.equal(false);   // after the window
    });
  });

  describe("Termination", function () {
    it("lets either party end it on its own", async function () {
      const a = await create(factory, agent, init(agent.address, band.address));
      await a.connect(agent).sign();
      await a.connect(band).sign();

      await expect(a.connect(stranger).terminate("")).to.be.revertedWithCustomError(a, "NotAParty");
      await expect(a.connect(band).terminate("ipfs://why"))
        .to.emit(a, "Terminated").withArgs(band.address, "ipfs://why");
      expect(await a.status()).to.equal(Status.Terminated);
      expect(await a.terminatedBy()).to.equal(band.address);
      expect(await a.isInEffect()).to.equal(false);

      await expect(a.connect(agent).terminate("")).to.be.revertedWithCustomError(a, "NotDraftOrActive");
      await expect(a.connect(agent).sign()).to.be.revertedWithCustomError(a, "NotDraft");
    });

    it("can be ended before it is signed", async function () {
      const a = await create(factory, agent, init(agent.address, band.address));
      await a.connect(band).terminate("");
      expect(await a.status()).to.equal(Status.Terminated);
    });
  });

  describe("Superseding", function () {
    let old;

    beforeEach(async function () {
      old = await create(factory, agent, init(agent.address, band.address));
      await old.connect(agent).sign();
      await old.connect(band).sign();
    });

    it("is replaced when both parties name the same new agreement that points back", async function () {
      const next = await create(factory, agent, init(agent.address, band.address, {
        termsHash: ethers.id("v2"), supersedes: old.target,
      }));
      expect(await next.supersedes()).to.equal(old.target);

      await old.connect(agent).supersedeWith(next.target);
      expect(await old.status()).to.equal(Status.Active);
      await expect(old.connect(band).supersedeWith(next.target))
        .to.emit(old, "Superseded").withArgs(next.target);
      expect(await old.status()).to.equal(Status.Superseded);
      expect(await old.supersededBy()).to.equal(next.target);
    });

    it("needs both parties to name the same replacement", async function () {
      const a = await create(factory, agent, init(agent.address, band.address, { termsHash: ethers.id("a"), supersedes: old.target }));
      const b = await create(factory, agent, init(agent.address, band.address, { termsHash: ethers.id("b"), supersedes: old.target }));
      await old.connect(agent).supersedeWith(a.target);
      await old.connect(band).supersedeWith(b.target);
      expect(await old.status()).to.equal(Status.Active);
      await old.connect(band).supersedeWith(a.target);
      expect(await old.status()).to.equal(Status.Superseded);
    });

    it("rejects a replacement that does not point back, a zero address, or an outsider", async function () {
      const unrelated = await create(factory, agent, init(agent.address, band.address, { termsHash: ethers.id("u") }));
      await expect(old.connect(agent).supersedeWith(unrelated.target))
        .to.be.revertedWithCustomError(old, "NewAgreementDoesNotPointBack");
      await expect(old.connect(agent).supersedeWith(ZERO_ADDRESS)).to.be.revertedWithCustomError(old, "ZeroAddress");
      await expect(old.connect(stranger).supersedeWith(unrelated.target)).to.be.revertedWithCustomError(old, "NotAParty");
    });

    it("cannot supersede an agreement that is not Active", async function () {
      const draft = await create(factory, agent, init(agent.address, band.address, { termsHash: ethers.id("d") }));
      const next = await create(factory, agent, init(agent.address, band.address, { termsHash: ethers.id("n"), supersedes: draft.target }));
      await expect(draft.connect(agent).supersedeWith(next.target)).to.be.revertedWithCustomError(draft, "NotActive");
    });

    it("a single-party agreement is superseded by its one party", async function () {
      const solo = await create(factory, agent, init(agent.address, ZERO_ADDRESS, { kind: Kind.Employment }));
      await solo.connect(agent).sign();
      const next = await create(factory, agent, init(agent.address, ZERO_ADDRESS, {
        kind: Kind.Employment, termsHash: ethers.id("solo-v2"), supersedes: solo.target,
      }));
      await solo.connect(agent).supersedeWith(next.target);
      expect(await solo.status()).to.equal(Status.Superseded);
    });
  });

  describe("Compensation schema", function () {
    const flagCommission = ethers.id("commissionOnGuarantee");
    const flagTips       = ethers.id("tipsEligible");

    it("stores streams, splits, flat payments and flags exactly as given", async function () {
      const a = await create(factory, agent, init(agent.address, band.address, {
        kind: Kind.Membership,
        streams: [
          { stream: Stream.Guarantee, splits: [
              { recipient: band.address, bps: 8_500 }, { recipient: member.address, bps: 1_500 } ] },
          { stream: Stream.MerchRevenue, splits: [{ recipient: member.address, bps: 10_000 }] },
        ],
        flatPayments: [{ recipient: member.address, amount: 250, streamTag: Stream.Other }],
        flags: [flagCommission, flagTips, flagTips],
      }));

      expect(await a.streamEnabled(Stream.Guarantee)).to.equal(true);
      expect(await a.streamEnabled(Stream.MerchRevenue)).to.equal(true);
      expect(await a.streamEnabled(Stream.TicketRevenue)).to.equal(false);

      const splits = await a.getStreamSplits(Stream.Guarantee);
      expect(splits.map((s) => [s.recipient, s.bps])).to.deep.equal([
        [band.address, 8_500n], [member.address, 1_500n],
      ]);
      expect(await a.getStreamSplits(Stream.TicketRevenue)).to.have.lengthOf(0);

      const flat = await a.getFlatPayments();
      expect(flat).to.have.lengthOf(1);
      expect(flat[0].amount).to.equal(250);
      expect(flat[0].streamTag).to.equal(Stream.Other);

      expect(await a.flags(flagCommission)).to.equal(true);
      expect(await a.flags(ethers.id("unset"))).to.equal(false);
      expect(await a.getFlags()).to.deep.equal([flagCommission, flagTips]);
    });

    it("has no compensation unless it is configured", async function () {
      const a = await create(factory, agent, init(agent.address, band.address));
      for (const s of Object.values(Stream)) {
        expect(await a.streamEnabled(s)).to.equal(false);
      }
      expect(await a.getFlatPayments()).to.have.lengthOf(0);
    });

    it("rejects splits that do not add up, empty or repeated streams, and bad entries", async function () {
      const bad = (extra) => factory.connect(agent).createAgreement(init(agent.address, band.address, extra));

      await expect(bad({ streams: [{ stream: Stream.Guarantee, splits: [{ recipient: band.address, bps: 9_999 }] }] }))
        .to.be.revertedWithCustomError(impl, "SplitsMustSumTo10000");
      await expect(bad({ streams: [{ stream: Stream.Guarantee, splits: [] }] }))
        .to.be.revertedWithCustomError(impl, "EmptyStream");
      await expect(bad({ streams: [
        { stream: Stream.Guarantee, splits: [{ recipient: band.address, bps: 10_000 }] },
        { stream: Stream.Guarantee, splits: [{ recipient: band.address, bps: 10_000 }] },
      ] })).to.be.revertedWithCustomError(impl, "DuplicateStream");
      await expect(bad({ streams: [{ stream: Stream.Guarantee, splits: [{ recipient: ZERO_ADDRESS, bps: 10_000 }] }] }))
        .to.be.revertedWithCustomError(impl, "ZeroRecipient");
      await expect(bad({ flatPayments: [{ recipient: band.address, amount: 0, streamTag: Stream.Other }] }))
        .to.be.revertedWithCustomError(impl, "ZeroAmount");
      await expect(bad({ flatPayments: [{ recipient: ZERO_ADDRESS, amount: 1, streamTag: Stream.Other }] }))
        .to.be.revertedWithCustomError(impl, "ZeroRecipient");
      await expect(bad({ flags: [ZERO_BYTES32] })).to.be.revertedWithCustomError(impl, "ZeroFlag");
    });

    it("limits how many splits, flat payments and flags one agreement can carry", async function () {
      const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
      const bad = (extra) => factory.connect(agent).createAgreement(init(agent.address, band.address, extra));

      await expect(bad({ streams: [{ stream: Stream.Guarantee,
        splits: many(21, () => ({ recipient: band.address, bps: 1 })) }] }))
        .to.be.revertedWithCustomError(impl, "TooManySplits");
      await expect(bad({ flatPayments: many(51, () => ({ recipient: band.address, amount: 1, streamTag: Stream.Other })) }))
        .to.be.revertedWithCustomError(impl, "TooManyFlatPayments");
      await expect(bad({ flags: many(51, (i) => ethers.id("f" + i)) }))
        .to.be.revertedWithCustomError(impl, "TooManyFlags");
    });
  });

  describe("Applying to a show through the graph", function () {
    it("needs every party of the agreement and of the show before it is Active", async function () {
      const standing = await create(factory, agent, init(agent.address, band.address));
      const show = await (await ethers.getContractFactory("MockGraphNode")).deploy(venue.address, artist.address);
      await show.waitForDeployment();
      const id = edgeIdOf(standing.target, show.target, EdgeType.APPLIES_TO);

      await registry.connect(agent).registerEdge(standing.target, show.target, EdgeType.APPLIES_TO, ZERO_BYTES32, "");
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);
      expect(await registry.getRequiredConfirmersForEdge(id))
        .to.deep.equal([agent.address, band.address, venue.address, artist.address]);

      await registry.connect(band).confirmEdge(id);
      await registry.connect(venue).confirmEdge(id);
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);
      await registry.connect(artist).confirmEdge(id);
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Active);
    });

    it("a show party cannot claim an agreement applies to its show on its own", async function () {
      const standing = await create(factory, agent, init(agent.address, band.address));
      const show = await (await ethers.getContractFactory("MockGraphNode")).deploy(venue.address, artist.address);
      await show.waitForDeployment();
      const id = edgeIdOf(standing.target, show.target, EdgeType.APPLIES_TO);

      await registry.connect(venue).registerEdge(standing.target, show.target, EdgeType.APPLIES_TO, ZERO_BYTES32, "");
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);
      expect(await registry.isEdgeActive(id)).to.equal(false);
    });
  });
});

describe("XaoRoles", function () {
  it("exposes role and grant ids as the keccak256 of their names", async function () {
    const roles = await (await ethers.getContractFactory("MockRoles")).deploy();
    await roles.waitForDeployment();

    expect(await roles.roleMember()).to.equal(ethers.id("ROLE_MEMBER"));
    expect(await roles.roleOperator()).to.equal(ethers.id("ROLE_OPERATOR"));
    expect(await roles.roleTreasurer()).to.equal(ethers.id("ROLE_TREASURER"));
    expect(await roles.roleAdmin()).to.equal(ethers.id("ROLE_ADMIN"));
    expect(await roles.roleOwner()).to.equal(ethers.id("ROLE_OWNER"));

    expect(await roles.ownerGrant()).to.equal(ethers.id("OWNER_GRANT"));
    expect(await roles.adminGrant()).to.equal(ethers.id("ADMIN_GRANT"));
    expect(await roles.treasurerGrant()).to.equal(ethers.id("TREASURER_GRANT"));
    expect(await roles.operatorGrant()).to.equal(ethers.id("OPERATOR_GRANT"));
    expect(await roles.memberGrant()).to.equal(ethers.id("MEMBER_GRANT"));
    expect(await roles.trialGrant()).to.equal(ethers.id("TRIAL_GRANT"));
    expect(await roles.tempGrant()).to.equal(ethers.id("TEMP_GRANT"));
    expect(await roles.customGrant()).to.equal(ethers.id("CUSTOM_GRANT"));
  });
});
