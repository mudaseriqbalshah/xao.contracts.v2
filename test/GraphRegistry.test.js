// test/GraphRegistry.test.js
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const ZERO_BYTES32 = ethers.ZeroHash;
const ZERO_ADDRESS = ethers.ZeroAddress;

const EdgeType = {
  HAS_MODULE: 0, CHILD_OF: 1, PARENTS: 2, APPLIES_TO: 3,
  SPONSORED_BY: 4, UNDER_TOUR: 5, UNDER_STAKING: 6, REPLACES: 7,
  PARTICIPATES_AS: 8, OWNED_BY: 9, OPERATED_BY: 10,
  DERIVES_FROM: 11, REFERENCES: 12, PAYOUT_ROUTED_TO: 13, FUNDS_HELD_BY: 14, DELEGATED_TO: 15,
};
const EdgeStatus   = { None: 0, Pending: 1, Active: 2, Inactive: 3 };
const ConfirmPolicy = { Immediate: 0, Counterparty: 1, AllParties: 2 };

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function deployRegistry() {
  const F = await ethers.getContractFactory("GraphRegistry");
  const registry = await F.deploy();
  await registry.waitForDeployment();
  return registry;
}

async function deployNode(partyA, partyB) {
  const F = await ethers.getContractFactory("MockGraphNode");
  const node = await F.deploy(partyA, partyB);
  await node.waitForDeployment();
  return node;
}

function edgeIdOf(from, to, edgeType, metaHash = ZERO_BYTES32) {
  return ethers.solidityPackedKeccak256(
    ["address", "address", "uint8", "bytes32"],
    [from, to, edgeType, metaHash]
  );
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

describe("GraphRegistry", function () {
  let registry;
  let venue, artist, agent, band, stranger, operator, module_;

  beforeEach(async function () {
    [, venue, artist, agent, band, stranger, operator, module_] = await ethers.getSigners();
    registry = await deployRegistry();
  });

  describe("Confirmation policy", function () {
    it("sets the policy table at deployment", async function () {
      expect(await registry.confirmPolicy(EdgeType.HAS_MODULE)).to.equal(ConfirmPolicy.Immediate);
      expect(await registry.confirmPolicy(EdgeType.CHILD_OF)).to.equal(ConfirmPolicy.Counterparty);
      expect(await registry.confirmPolicy(EdgeType.PARENTS)).to.equal(ConfirmPolicy.Counterparty);
      expect(await registry.confirmPolicy(EdgeType.UNDER_TOUR)).to.equal(ConfirmPolicy.Counterparty);
      expect(await registry.confirmPolicy(EdgeType.UNDER_STAKING)).to.equal(ConfirmPolicy.Counterparty);
      expect(await registry.confirmPolicy(EdgeType.APPLIES_TO)).to.equal(ConfirmPolicy.AllParties);
      expect(await registry.confirmPolicy(EdgeType.SPONSORED_BY)).to.equal(ConfirmPolicy.AllParties);
      expect(await registry.confirmPolicy(EdgeType.REPLACES)).to.equal(ConfirmPolicy.AllParties);
      expect(await registry.confirmPolicy(EdgeType.PARTICIPATES_AS)).to.equal(ConfirmPolicy.Counterparty);
      expect(await registry.confirmPolicy(EdgeType.OWNED_BY)).to.equal(ConfirmPolicy.Counterparty);
      expect(await registry.confirmPolicy(EdgeType.OPERATED_BY)).to.equal(ConfirmPolicy.Counterparty);
      expect(await registry.confirmPolicy(EdgeType.DERIVES_FROM)).to.equal(ConfirmPolicy.Counterparty);
      expect(await registry.confirmPolicy(EdgeType.REFERENCES)).to.equal(ConfirmPolicy.Counterparty);
      expect(await registry.confirmPolicy(EdgeType.PAYOUT_ROUTED_TO)).to.equal(ConfirmPolicy.Counterparty);
      expect(await registry.confirmPolicy(EdgeType.DELEGATED_TO)).to.equal(ConfirmPolicy.Counterparty);
      expect(await registry.confirmPolicy(EdgeType.FUNDS_HELD_BY)).to.equal(ConfirmPolicy.Immediate);
    });

    it("reports which edge types need all parties to confirm", async function () {
      expect(await registry.requiresPartyConfirmation(EdgeType.APPLIES_TO)).to.equal(true);
      expect(await registry.requiresPartyConfirmation(EdgeType.SPONSORED_BY)).to.equal(true);
      expect(await registry.requiresPartyConfirmation(EdgeType.HAS_MODULE)).to.equal(false);
      expect(await registry.requiresPartyConfirmation(EdgeType.PARENTS)).to.equal(false);
    });
  });

  describe("registerEdge validation", function () {
    let show;

    beforeEach(async function () {
      show = await deployNode(venue.address, artist.address);
    });

    it("rejects a zero endpoint", async function () {
      await expect(
        registry.connect(venue).registerEdge(ZERO_ADDRESS, show.target, EdgeType.HAS_MODULE, ZERO_BYTES32, "")
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
      await expect(
        registry.connect(venue).registerEdge(show.target, ZERO_ADDRESS, EdgeType.HAS_MODULE, ZERO_BYTES32, "")
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("rejects an edge from a node to itself", async function () {
      await expect(
        registry.connect(venue).registerEdge(show.target, show.target, EdgeType.HAS_MODULE, ZERO_BYTES32, "")
      ).to.be.revertedWithCustomError(registry, "SelfEdge");
    });

    it("rejects a caller with no authority on either endpoint", async function () {
      await expect(
        registry.connect(stranger).registerEdge(show.target, module_.address, EdgeType.HAS_MODULE, ZERO_BYTES32, "")
      ).to.be.revertedWithCustomError(registry, "NotAuthorized");
    });

    it("rejects registering the same edge twice", async function () {
      await registry.connect(venue).registerEdge(show.target, module_.address, EdgeType.HAS_MODULE, ZERO_BYTES32, "");
      await expect(
        registry.connect(venue).registerEdge(show.target, module_.address, EdgeType.HAS_MODULE, ZERO_BYTES32, "")
      ).to.be.revertedWithCustomError(registry, "EdgeExists");
    });

    it("uses the deterministic edge id and stores the record", async function () {
      const metaHash = ethers.id("meta-v1");
      const expected = edgeIdOf(show.target, module_.address, EdgeType.HAS_MODULE, metaHash);
      expect(await registry.computeEdgeId(show.target, module_.address, EdgeType.HAS_MODULE, metaHash))
        .to.equal(expected);

      await registry.connect(venue).registerEdge(show.target, module_.address, EdgeType.HAS_MODULE, metaHash, "ipfs://meta");
      const edge = await registry.edges(expected);
      expect(edge.from).to.equal(show.target);
      expect(edge.to).to.equal(module_.address);
      expect(edge.edgeType).to.equal(EdgeType.HAS_MODULE);
      expect(edge.metaHash).to.equal(metaHash);
      expect(edge.metaCID).to.equal("ipfs://meta");
      expect(edge.createdAt).to.be.gt(0);
    });

    it("lets revisions of the same relationship coexist under different metaHash", async function () {
      const v1 = ethers.id("v1");
      const v2 = ethers.id("v2");
      await registry.connect(venue).registerEdge(show.target, module_.address, EdgeType.HAS_MODULE, v1, "");
      await registry.connect(venue).registerEdge(show.target, module_.address, EdgeType.HAS_MODULE, v2, "");
      expect(await registry.isEdgeActive(edgeIdOf(show.target, module_.address, EdgeType.HAS_MODULE, v1))).to.equal(true);
      expect(await registry.isEdgeActive(edgeIdOf(show.target, module_.address, EdgeType.HAS_MODULE, v2))).to.equal(true);
    });
  });

  describe("Who may register", function () {
    let show;

    beforeEach(async function () {
      show = await deployNode(venue.address, artist.address);
    });

    it("either party of a node", async function () {
      await registry.connect(venue).registerEdge(show.target, module_.address, EdgeType.HAS_MODULE, ethers.id("a"), "");
      await registry.connect(artist).registerEdge(show.target, module_.address, EdgeType.HAS_MODULE, ethers.id("b"), "");
    });

    it("an operator named by the node", async function () {
      await show.setOperator(operator.address, true);
      await registry.connect(operator).registerEdge(show.target, module_.address, EdgeType.HAS_MODULE, ZERO_BYTES32, "");
    });

    it("the endpoint address itself, but a module claim then waits for the show's parties", async function () {
      const id = edgeIdOf(show.target, module_.address, EdgeType.HAS_MODULE);
      await registry.connect(module_).registerEdge(show.target, module_.address, EdgeType.HAS_MODULE, ZERO_BYTES32, "");
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);
      expect(await registry.getRequiredConfirmersForEdge(id)).to.deep.equal([venue.address, artist.address]);
    });

    it("an operator of a party that is an org wallet", async function () {
      const Org = await ethers.getContractFactory("MockOrgWallet");
      const org = await Org.deploy();
      await org.waitForDeployment();
      await org.setOperator(operator.address, true);
      const orgShow = await deployNode(org.target, artist.address);

      await registry.connect(operator).registerEdge(orgShow.target, module_.address, EdgeType.HAS_MODULE, ZERO_BYTES32, "");
      expect(await registry.isAuthorizedFor(orgShow.target, operator.address)).to.equal(true);
      expect(await registry.isAuthorizedFor(orgShow.target, stranger.address)).to.equal(false);
    });
  });

  describe("Immediate edges are claims by the `from` node", function () {
    let show;

    beforeEach(async function () {
      show = await deployNode(venue.address, artist.address);
    });

    it("FUNDS_HELD_BY is Active at once when registered for the show", async function () {
      const id = edgeIdOf(show.target, module_.address, EdgeType.FUNDS_HELD_BY);
      await registry.connect(venue).registerEdge(show.target, module_.address, EdgeType.FUNDS_HELD_BY, ZERO_BYTES32, "");
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Active);
    });

    it("an outsider cannot register itself as the module or escrow of someone else's show", async function () {
      for (const type of [EdgeType.HAS_MODULE, EdgeType.FUNDS_HELD_BY]) {
        const id = edgeIdOf(show.target, stranger.address, type);
        await registry.connect(stranger).registerEdge(show.target, stranger.address, type, ZERO_BYTES32, "");
        expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);
        expect(await registry.isEdgeActive(id)).to.equal(false);
      }
    });

    it("the show's parties can still approve a module that registered itself", async function () {
      const id = edgeIdOf(show.target, module_.address, EdgeType.HAS_MODULE);
      await registry.connect(module_).registerEdge(show.target, module_.address, EdgeType.HAS_MODULE, ZERO_BYTES32, "");
      await registry.connect(venue).confirmEdge(id);
      await registry.connect(artist).confirmEdge(id);
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Active);
    });

    it("a node's operator, such as a factory, registers its modules as Active", async function () {
      await show.setOperator(operator.address, true);
      const id = edgeIdOf(show.target, module_.address, EdgeType.HAS_MODULE);
      await registry.connect(operator).registerEdge(show.target, module_.address, EdgeType.HAS_MODULE, ZERO_BYTES32, "");
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Active);
    });
  });

  describe("Other consent edges (DERIVES_FROM / REFERENCES / PAYOUT_ROUTED_TO / DELEGATED_TO)", function () {
    it("each waits for the other endpoint's parties when registered from one side", async function () {
      const standing = await deployNode(agent.address, band.address);
      const show = await deployNode(venue.address, artist.address);
      for (const type of [EdgeType.DERIVES_FROM, EdgeType.REFERENCES, EdgeType.PAYOUT_ROUTED_TO, EdgeType.DELEGATED_TO]) {
        const id = edgeIdOf(show.target, standing.target, type);
        await registry.connect(venue).registerEdge(show.target, standing.target, type, ZERO_BYTES32, "");
        expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);
        expect(await registry.getRequiredConfirmersForEdge(id)).to.deep.equal([agent.address, band.address]);

        await registry.connect(agent).confirmEdge(id);
        await registry.connect(band).confirmEdge(id);
        expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Active);
      }
    });
  });

  describe("Nodes that name a registrar", function () {
    let node;

    beforeEach(async function () {
      const F = await ethers.getContractFactory("MockRegistrarNode");
      node = await F.deploy(agent.address, band.address, agent.address);
      await node.waitForDeployment();
    });

    it("lets only the registrar register on the node's behalf", async function () {
      expect(await registry.isAuthorizedFor(node.target, agent.address)).to.equal(true);
      expect(await registry.isAuthorizedFor(node.target, band.address)).to.equal(false);

      await registry.connect(agent).registerEdge(node.target, module_.address, EdgeType.HAS_MODULE, ZERO_BYTES32, "");
      await expect(
        registry.connect(band).registerEdge(node.target, module_.address, EdgeType.HAS_MODULE, ethers.id("b"), "")
      ).to.be.revertedWithCustomError(registry, "NotAuthorized");
    });

    it("still asks both parties to confirm", async function () {
      expect(await registry.getRequiredConfirmersForNode(node.target))
        .to.deep.equal([agent.address, band.address]);
    });

    it("accepts an operator of a registrar that is an org wallet", async function () {
      const Org = await ethers.getContractFactory("MockOrgWallet");
      const org = await Org.deploy();
      await org.waitForDeployment();
      await org.setOperator(operator.address, true);
      const F = await ethers.getContractFactory("MockRegistrarNode");
      const orgNode = await F.deploy(org.target, band.address, org.target);
      await orgNode.waitForDeployment();

      expect(await registry.isAuthorizedFor(orgNode.target, operator.address)).to.equal(true);
      expect(await registry.isAuthorizedFor(orgNode.target, band.address)).to.equal(false);
    });

    it("falls back to the party rule when the registrar is unset", async function () {
      const F = await ethers.getContractFactory("MockRegistrarNode");
      const openNode = await F.deploy(agent.address, band.address, ZERO_ADDRESS);
      await openNode.waitForDeployment();
      expect(await registry.isAuthorizedFor(openNode.target, band.address)).to.equal(true);
    });
  });

  describe("Immediate edges (HAS_MODULE)", function () {
    it("is Active on registration with no confirmers", async function () {
      const show = await deployNode(venue.address, artist.address);
      const edgeId = edgeIdOf(show.target, module_.address, EdgeType.HAS_MODULE);

      await expect(
        registry.connect(venue).registerEdge(show.target, module_.address, EdgeType.HAS_MODULE, ZERO_BYTES32, "")
      ).to.emit(registry, "EdgeRegistered")
        .withArgs(edgeId, show.target, module_.address, EdgeType.HAS_MODULE, EdgeStatus.Active);

      expect(await registry.edgeStatus(edgeId)).to.equal(EdgeStatus.Active);
      expect(await registry.getRequiredConfirmersForEdge(edgeId)).to.deep.equal([]);
      expect(await registry.isFullyConfirmed(edgeId)).to.equal(true);
    });
  });

  describe("Counterparty edges (PARENTS / CHILD_OF)", function () {
    let tpa, show, edgeId;

    beforeEach(async function () {
      tpa  = await deployNode(agent.address, band.address);
      show = await deployNode(venue.address, artist.address);
      edgeId = edgeIdOf(tpa.target, show.target, EdgeType.PARENTS);
    });

    it("is Active immediately when the registrar is authorized on both endpoints", async function () {
      const child = await deployNode(agent.address, stranger.address);
      const id = edgeIdOf(tpa.target, child.target, EdgeType.PARENTS);

      await expect(
        registry.connect(agent).registerEdge(tpa.target, child.target, EdgeType.PARENTS, ZERO_BYTES32, "")
      ).to.emit(registry, "EdgeRegistered")
        .withArgs(id, tpa.target, child.target, EdgeType.PARENTS, EdgeStatus.Active);
      expect(await registry.pendingSides(id)).to.equal(0);
    });

    it("stays Pending when the registrar is authorized on one endpoint only", async function () {
      await expect(
        registry.connect(agent).registerEdge(tpa.target, show.target, EdgeType.PARENTS, ZERO_BYTES32, "")
      ).to.emit(registry, "EdgeRegistered")
        .withArgs(edgeId, tpa.target, show.target, EdgeType.PARENTS, EdgeStatus.Pending);

      expect(await registry.edgeStatus(edgeId)).to.equal(EdgeStatus.Pending);
      expect(await registry.isEdgeActive(edgeId)).to.equal(false);
      // Only the other endpoint's parties are asked to confirm.
      expect(await registry.getRequiredConfirmersForEdge(edgeId))
        .to.deep.equal([venue.address, artist.address]);
    });

    it("activates once every party of the other endpoint has confirmed", async function () {
      await registry.connect(agent).registerEdge(tpa.target, show.target, EdgeType.PARENTS, ZERO_BYTES32, "");

      await expect(registry.connect(venue).confirmEdge(edgeId))
        .to.emit(registry, "EdgeConfirmed").withArgs(edgeId, venue.address);
      expect(await registry.edgeStatus(edgeId)).to.equal(EdgeStatus.Pending);
      expect(await registry.confirmCount(edgeId)).to.equal(1);

      await expect(registry.connect(artist).confirmEdge(edgeId))
        .to.emit(registry, "EdgeActivated").withArgs(edgeId);
      expect(await registry.edgeStatus(edgeId)).to.equal(EdgeStatus.Active);
      expect(await registry.confirmCount(edgeId)).to.equal(2);
    });

    it("asks the `from` side when the registrar is authorized on `to` only", async function () {
      const id = edgeIdOf(show.target, tpa.target, EdgeType.CHILD_OF);
      await registry.connect(agent).registerEdge(show.target, tpa.target, EdgeType.CHILD_OF, ZERO_BYTES32, "");

      expect(await registry.pendingSides(id)).to.equal(1);
      expect(await registry.getRequiredConfirmersForEdge(id))
        .to.deep.equal([venue.address, artist.address]);
    });

    it("rejects confirmation from the registrar's side, a stranger, or twice", async function () {
      await registry.connect(agent).registerEdge(tpa.target, show.target, EdgeType.PARENTS, ZERO_BYTES32, "");

      await expect(registry.connect(agent).confirmEdge(edgeId))
        .to.be.revertedWithCustomError(registry, "NothingToConfirm");
      await expect(registry.connect(stranger).confirmEdge(edgeId))
        .to.be.revertedWithCustomError(registry, "NothingToConfirm");

      await registry.connect(venue).confirmEdge(edgeId);
      await expect(registry.connect(venue).confirmEdge(edgeId))
        .to.be.revertedWithCustomError(registry, "NothingToConfirm");
    });

    it("does not let a node operator confirm in place of the parties", async function () {
      await show.setOperator(operator.address, true);
      await registry.connect(agent).registerEdge(tpa.target, show.target, EdgeType.PARENTS, ZERO_BYTES32, "");

      await expect(registry.connect(operator).confirmEdge(edgeId))
        .to.be.revertedWithCustomError(registry, "NothingToConfirm");
    });

    it("rejects confirming an unknown or already Active edge", async function () {
      await expect(registry.connect(venue).confirmEdge(edgeId))
        .to.be.revertedWithCustomError(registry, "EdgeNotFound");

      await registry.connect(agent).registerEdge(tpa.target, show.target, EdgeType.PARENTS, ZERO_BYTES32, "");
      await registry.connect(venue).confirmEdge(edgeId);
      await registry.connect(artist).confirmEdge(edgeId);
      await expect(registry.connect(venue).confirmEdge(edgeId))
        .to.be.revertedWithCustomError(registry, "EdgeNotPending");
    });
  });

  describe("Role and authority edges (PARTICIPATES_AS / OWNED_BY / OPERATED_BY)", function () {
    let show;
    const headliner = ethers.id("role:headliner");

    beforeEach(async function () {
      show = await deployNode(venue.address, artist.address);
    });

    it("a show party names a participant, who has to confirm the role", async function () {
      const id = edgeIdOf(band.address, show.target, EdgeType.PARTICIPATES_AS, headliner);
      await registry.connect(venue)
        .registerEdge(band.address, show.target, EdgeType.PARTICIPATES_AS, headliner, "ipfs://role");

      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);
      expect(await registry.getRequiredConfirmersForEdge(id)).to.deep.equal([band.address]);

      await registry.connect(band).confirmEdge(id);
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Active);
      expect((await registry.edges(id)).metaCID).to.equal("ipfs://role");
    });

    it("a participant claiming a role waits for the show's parties", async function () {
      const id = edgeIdOf(band.address, show.target, EdgeType.PARTICIPATES_AS, headliner);
      await registry.connect(band)
        .registerEdge(band.address, show.target, EdgeType.PARTICIPATES_AS, headliner, "");

      expect(await registry.getRequiredConfirmersForEdge(id))
        .to.deep.equal([venue.address, artist.address]);
      await registry.connect(venue).confirmEdge(id);
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);
      await registry.connect(artist).confirmEdge(id);
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Active);
    });

    it("is Active at once when a show party records its own role", async function () {
      const id = edgeIdOf(artist.address, show.target, EdgeType.PARTICIPATES_AS, headliner);
      await registry.connect(artist)
        .registerEdge(artist.address, show.target, EdgeType.PARTICIPATES_AS, headliner, "");
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Active);
    });

    it("an ownership or operator claim needs the named owner or operator to agree", async function () {
      const Org = await ethers.getContractFactory("MockOrgWallet");
      const org = await Org.deploy();
      await org.waitForDeployment();
      await org.setOperator(operator.address, true);

      const ownedId = edgeIdOf(show.target, org.target, EdgeType.OWNED_BY);
      await registry.connect(venue).registerEdge(show.target, org.target, EdgeType.OWNED_BY, ZERO_BYTES32, "");
      expect(await registry.edgeStatus(ownedId)).to.equal(EdgeStatus.Pending);
      await expect(registry.connect(stranger).confirmEdge(ownedId))
        .to.be.revertedWithCustomError(registry, "NothingToConfirm");
      await registry.connect(operator).confirmEdge(ownedId);
      expect(await registry.edgeStatus(ownedId)).to.equal(EdgeStatus.Active);

      const operatedId = edgeIdOf(show.target, stranger.address, EdgeType.OPERATED_BY);
      await registry.connect(venue)
        .registerEdge(show.target, stranger.address, EdgeType.OPERATED_BY, ZERO_BYTES32, "");
      expect(await registry.edgeStatus(operatedId)).to.equal(EdgeStatus.Pending);
      await registry.connect(stranger).confirmEdge(operatedId);
      expect(await registry.edgeStatus(operatedId)).to.equal(EdgeStatus.Active);
    });

    it("a stranger cannot claim to own someone else's contract", async function () {
      const id = edgeIdOf(show.target, stranger.address, EdgeType.OWNED_BY);
      await registry.connect(stranger)
        .registerEdge(show.target, stranger.address, EdgeType.OWNED_BY, ZERO_BYTES32, "");
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);
      expect(await registry.getRequiredConfirmersForEdge(id))
        .to.deep.equal([venue.address, artist.address]);
    });
  });

  describe("AllParties edges (APPLIES_TO / SPONSORED_BY)", function () {
    let standing, show, edgeId;

    beforeEach(async function () {
      standing = await deployNode(agent.address, band.address);
      show     = await deployNode(venue.address, artist.address);
      edgeId   = edgeIdOf(standing.target, show.target, EdgeType.APPLIES_TO);
    });

    it("needs every party of both endpoints, and records the registrar's own confirmation", async function () {
      await expect(
        registry.connect(agent).registerEdge(standing.target, show.target, EdgeType.APPLIES_TO, ZERO_BYTES32, "")
      ).to.emit(registry, "EdgeRegistered")
        .withArgs(edgeId, standing.target, show.target, EdgeType.APPLIES_TO, EdgeStatus.Pending)
        .and.to.emit(registry, "EdgeConfirmed").withArgs(edgeId, agent.address);

      expect(await registry.getRequiredConfirmersForEdge(edgeId))
        .to.deep.equal([agent.address, band.address, venue.address, artist.address]);
      expect(await registry.confirmedBy(edgeId, agent.address)).to.equal(true);

      await registry.connect(band).confirmEdge(edgeId);
      await registry.connect(venue).confirmEdge(edgeId);
      expect(await registry.edgeStatus(edgeId)).to.equal(EdgeStatus.Pending);

      await expect(registry.connect(artist).confirmEdge(edgeId))
        .to.emit(registry, "EdgeActivated").withArgs(edgeId);
      expect(await registry.isFullyConfirmed(edgeId)).to.equal(true);
    });

    it("stays Pending even when the registrar is authorized on both endpoints", async function () {
      const other = await deployNode(agent.address, artist.address);
      const id = edgeIdOf(standing.target, other.target, EdgeType.APPLIES_TO);

      await registry.connect(agent).registerEdge(standing.target, other.target, EdgeType.APPLIES_TO, ZERO_BYTES32, "");
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);
      // agent is a party of both endpoints and is listed once.
      expect(await registry.getRequiredConfirmersForEdge(id))
        .to.deep.equal([agent.address, band.address, artist.address]);
    });

    it("activates in one call when the registrar is the only party on both endpoints", async function () {
      const a = await deployNode(agent.address, ZERO_ADDRESS);
      const b = await deployNode(agent.address, ZERO_ADDRESS);
      const id = edgeIdOf(a.target, b.target, EdgeType.SPONSORED_BY);

      await expect(
        registry.connect(agent).registerEdge(a.target, b.target, EdgeType.SPONSORED_BY, ZERO_BYTES32, "")
      ).to.emit(registry, "EdgeActivated").withArgs(id);
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Active);
    });

    it("treats an EOA endpoint as its own confirmer", async function () {
      const id = edgeIdOf(standing.target, stranger.address, EdgeType.APPLIES_TO);
      await registry.connect(agent).registerEdge(standing.target, stranger.address, EdgeType.APPLIES_TO, ZERO_BYTES32, "");

      expect(await registry.getRequiredConfirmersForEdge(id))
        .to.deep.equal([agent.address, band.address, stranger.address]);
      await registry.connect(band).confirmEdge(id);
      await registry.connect(stranger).confirmEdge(id);
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Active);
    });

    it("treats a contract without the parties interface as its own confirmer", async function () {
      const Token = await ethers.getContractFactory("MockERC20");
      const plain = await Token.deploy("Plain", "PLN", 6);
      await plain.waitForDeployment();

      expect(await registry.getRequiredConfirmersForNode(plain.target)).to.deep.equal([plain.target]);
      expect(await registry.isAuthorizedFor(plain.target, stranger.address)).to.equal(false);
    });

    it("lets an org wallet's operator confirm as the org", async function () {
      const Org = await ethers.getContractFactory("MockOrgWallet");
      const org = await Org.deploy();
      await org.waitForDeployment();
      await org.setOperator(operator.address, true);

      const orgShow = await deployNode(org.target, artist.address);
      const id = edgeIdOf(standing.target, orgShow.target, EdgeType.APPLIES_TO);
      await registry.connect(agent).registerEdge(standing.target, orgShow.target, EdgeType.APPLIES_TO, ZERO_BYTES32, "");

      await expect(registry.connect(operator).confirmEdge(id))
        .to.emit(registry, "EdgeConfirmed").withArgs(id, org.target);
      expect(await registry.confirmedBy(id, org.target)).to.equal(true);

      await expect(registry.connect(stranger).confirmEdge(id))
        .to.be.revertedWithCustomError(registry, "NothingToConfirm");
    });
  });

  describe("supersedeEdge", function () {
    let show, oldId, newId;
    const v1 = ethers.id("v1");
    const v2 = ethers.id("v2");

    beforeEach(async function () {
      show  = await deployNode(venue.address, artist.address);
      oldId = edgeIdOf(show.target, module_.address, EdgeType.HAS_MODULE, v1);
      newId = edgeIdOf(show.target, module_.address, EdgeType.HAS_MODULE, v2);
      await registry.connect(venue).registerEdge(show.target, module_.address, EdgeType.HAS_MODULE, v1, "");
      await registry.connect(venue).registerEdge(show.target, module_.address, EdgeType.HAS_MODULE, v2, "");
    });

    it("marks the old edge Inactive and points it at the new one, keeping the record", async function () {
      await expect(registry.connect(artist).supersedeEdge(oldId, newId))
        .to.emit(registry, "EdgeDeactivated").withArgs(oldId, newId);

      expect(await registry.edgeStatus(oldId)).to.equal(EdgeStatus.Inactive);
      expect(await registry.supersededBy(oldId)).to.equal(newId);
      expect(await registry.edgeStatus(newId)).to.equal(EdgeStatus.Active);
      expect((await registry.edges(oldId)).from).to.equal(show.target);
    });

    it("rejects a caller with no authority on the old edge", async function () {
      await expect(registry.connect(stranger).supersedeEdge(oldId, newId))
        .to.be.revertedWithCustomError(registry, "NotAuthorized");
    });

    it("rejects an unknown old edge, a non-Active new edge, or the same edge", async function () {
      await expect(registry.connect(venue).supersedeEdge(ethers.id("missing"), newId))
        .to.be.revertedWithCustomError(registry, "EdgeNotFound");
      await expect(registry.connect(venue).supersedeEdge(oldId, ethers.id("missing")))
        .to.be.revertedWithCustomError(registry, "NewEdgeNotActive");
      await expect(registry.connect(venue).supersedeEdge(oldId, oldId))
        .to.be.revertedWithCustomError(registry, "SameEdge");
    });

    it("rejects superseding an edge that is already Inactive, and re-registering it", async function () {
      await registry.connect(venue).supersedeEdge(oldId, newId);

      await expect(registry.connect(venue).supersedeEdge(oldId, newId))
        .to.be.revertedWithCustomError(registry, "EdgeInactive");
      await expect(
        registry.connect(venue).registerEdge(show.target, module_.address, EdgeType.HAS_MODULE, v1, "")
      ).to.be.revertedWithCustomError(registry, "EdgeExists");
    });

    it("can retire a Pending edge", async function () {
      const tpa = await deployNode(agent.address, band.address);
      const pendingId = edgeIdOf(tpa.target, show.target, EdgeType.PARENTS);
      await registry.connect(agent).registerEdge(tpa.target, show.target, EdgeType.PARENTS, ZERO_BYTES32, "");

      await registry.connect(venue).supersedeEdge(pendingId, newId);
      expect(await registry.edgeStatus(pendingId)).to.equal(EdgeStatus.Inactive);
      await expect(registry.connect(artist).confirmEdge(pendingId))
        .to.be.revertedWithCustomError(registry, "EdgeNotPending");
    });
  });

  describe("Traversal", function () {
    it("lists a node's outgoing and incoming edges with paging", async function () {
      const show = await deployNode(venue.address, artist.address);
      const metas = [ethers.id("m0"), ethers.id("m1"), ethers.id("m2")];
      for (const m of metas) {
        await registry.connect(venue).registerEdge(show.target, module_.address, EdgeType.HAS_MODULE, m, "");
      }
      const ids = metas.map((m) => edgeIdOf(show.target, module_.address, EdgeType.HAS_MODULE, m));

      expect(await registry.edgesFromCount(show.target)).to.equal(3);
      expect(await registry.edgesToCount(module_.address)).to.equal(3);
      expect(await registry.edgesToCount(show.target)).to.equal(0);

      expect(await registry.getEdgesFrom(show.target, 0, 10)).to.deep.equal(ids);
      expect(await registry.getEdgesTo(module_.address, 0, 10)).to.deep.equal(ids);
      expect(await registry.getEdgesFrom(show.target, 1, 1)).to.deep.equal([ids[1]]);
      expect(await registry.getEdgesFrom(show.target, 2, ethers.MaxUint256)).to.deep.equal([ids[2]]);
      expect(await registry.getEdgesFrom(show.target, 3, 10)).to.deep.equal([]);
    });
  });
});
