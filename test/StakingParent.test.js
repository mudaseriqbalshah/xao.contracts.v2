// test/StakingParent.test.js
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const ZERO_BYTES32 = ethers.ZeroHash;
const ZERO_ADDRESS = ethers.ZeroAddress;
const OwnerMode  = { Personal: 0, Org: 1 };
const EdgeType   = { CHILD_OF: 1, PARENTS: 2, REFERENCES: 12 };
const EdgeStatus = { None: 0, Pending: 1, Active: 2, Inactive: 3 };
const META_HASH  = ethers.id("staking-meta");

function edgeIdOf(from, to, edgeType, metaHash = ZERO_BYTES32) {
  return ethers.solidityPackedKeccak256(
    ["address", "address", "uint8", "bytes32"],
    [from, to, edgeType, metaHash]
  );
}

describe("StakingParent", function () {
  let registry, impl, factory;
  let owner, operator, venue, artist, stranger, orgOperator;
  let parent, show;

  async function createParent(creator, ownerAddr, mode = OwnerMode.Personal) {
    const receipt = await (await factory.connect(creator)
      .createStakingParent(ownerAddr, mode, META_HASH, "ipfs://staking")).wait();
    const log = receipt.logs
      .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((l) => l && l.name === "StakingParentCreated");
    return ethers.getContractAt("StakingParent", log.args.stakingParent);
  }

  beforeEach(async function () {
    [, owner, operator, venue, artist, stranger, orgOperator] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("GraphRegistry")).deploy();
    await registry.waitForDeployment();
    impl = await (await ethers.getContractFactory("StakingParent")).deploy();
    await impl.waitForDeployment();
    factory = await (await ethers.getContractFactory("StakingParentFactory")).deploy(impl.target, registry.target);
    await factory.waitForDeployment();

    parent = await createParent(owner, owner.address);
    show = await (await ethers.getContractFactory("MockGraphNode")).deploy(venue.address, artist.address);
    await show.waitForDeployment();
  });

  describe("StakingParentFactory", function () {
    it("rejects zero addresses at construction", async function () {
      const F = await ethers.getContractFactory("StakingParentFactory");
      await expect(F.deploy(ZERO_ADDRESS, registry.target)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(impl.target, ZERO_ADDRESS)).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("creates a personal container only for its owner, and records it", async function () {
      await expect(factory.connect(stranger).createStakingParent(owner.address, OwnerMode.Personal, ZERO_BYTES32, ""))
        .to.be.revertedWithCustomError(factory, "NotAuthorized");
      await expect(factory.connect(stranger).createStakingParent(ZERO_ADDRESS, OwnerMode.Personal, ZERO_BYTES32, ""))
        .to.be.revertedWithCustomError(factory, "ZeroAddress");

      expect(await factory.getParentCount()).to.equal(1);
      expect(await factory.getOwnerParents(owner.address)).to.deep.equal([parent.target]);
    });

    it("creates an org container for the org wallet or one of its operators", async function () {
      const org = await (await ethers.getContractFactory("MockOrgWallet")).deploy();
      await org.waitForDeployment();
      await org.setOperator(orgOperator.address, true);

      await expect(factory.connect(stranger).createStakingParent(org.target, OwnerMode.Org, ZERO_BYTES32, ""))
        .to.be.revertedWithCustomError(factory, "NotAuthorized");
      // An operator cannot create a personal container in someone else's name.
      await expect(factory.connect(orgOperator).createStakingParent(org.target, OwnerMode.Personal, ZERO_BYTES32, ""))
        .to.be.revertedWithCustomError(factory, "NotAuthorized");

      const orgParent = await createParent(orgOperator, org.target, OwnerMode.Org);
      expect(await orgParent.owner()).to.equal(org.target);
      expect(await orgParent.ownerMode()).to.equal(OwnerMode.Org);
    });
  });

  describe("Container", function () {
    it("stores its owner, mode, registry and metadata", async function () {
      expect(await parent.owner()).to.equal(owner.address);
      expect(await parent.ownerMode()).to.equal(OwnerMode.Personal);
      expect(await parent.graphRegistry()).to.equal(registry.target);
      expect(await parent.metaHash()).to.equal(META_HASH);
      expect(await parent.metaCID()).to.equal("ipfs://staking");
    });

    it("cannot be initialized twice, and the implementation is locked", async function () {
      await expect(parent.initialize(stranger.address, OwnerMode.Personal, registry.target, ZERO_BYTES32, ""))
        .to.be.revertedWithCustomError(parent, "AlreadyInitialized");
      await expect(impl.initialize(stranger.address, OwnerMode.Personal, registry.target, ZERO_BYTES32, ""))
        .to.be.revertedWithCustomError(impl, "AlreadyInitialized");
    });

    it("is a single-party graph node owned by its owner", async function () {
      expect(await parent.partyA()).to.equal(owner.address);
      expect(await parent.partyB()).to.equal(ZERO_ADDRESS);
      expect(await registry.getRequiredConfirmersForNode(parent.target)).to.deep.equal([owner.address]);
    });

    it("lets only the owner manage operators", async function () {
      await expect(parent.connect(stranger).setOperator(operator.address, true))
        .to.be.revertedWithCustomError(parent, "NotOwner");
      await expect(parent.connect(owner).setOperator(operator.address, true))
        .to.emit(parent, "OperatorSet").withArgs(operator.address, true);
      expect(await parent.isGraphOperator(operator.address)).to.equal(true);
      await parent.connect(owner).setOperator(operator.address, false);
      expect(await parent.isGraphOperator(operator.address)).to.equal(false);
    });

    it("holds no funds and has no staking functions yet", async function () {
      expect(parent.interface.getFunction("stake")).to.equal(null);
      expect(parent.interface.getFunction("allocateStake")).to.equal(null);
      expect(await ethers.provider.getBalance(parent.target)).to.equal(0);
    });
  });

  describe("Linking children", function () {
    it("registers a PARENTS link that stays Pending until the child's parties confirm", async function () {
      const id = edgeIdOf(parent.target, show.target, EdgeType.PARENTS);
      await expect(parent.connect(owner).registerChild(show.target, true, ZERO_BYTES32, ""))
        .to.emit(parent, "ChildRegistered").withArgs(show.target, EdgeType.PARENTS, id);

      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);
      expect(await parent.isChildLinked(show.target)).to.equal(false);
      expect(await registry.getRequiredConfirmersForEdge(id)).to.deep.equal([venue.address, artist.address]);

      await registry.connect(venue).confirmEdge(id);
      expect(await parent.isChildLinked(show.target)).to.equal(false);
      await registry.connect(artist).confirmEdge(id);
      expect(await parent.isChildLinked(show.target)).to.equal(true);
      expect(await parent.childEdge(show.target)).to.equal(id);
    });

    it("registers a CHILD_OF link the same way", async function () {
      const id = edgeIdOf(show.target, parent.target, EdgeType.CHILD_OF);
      await parent.connect(owner).registerChild(show.target, false, ZERO_BYTES32, "");
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);
      await registry.connect(venue).confirmEdge(id);
      await registry.connect(artist).confirmEdge(id);
      expect(await parent.isChildLinked(show.target)).to.equal(true);
    });

    it("lets an operator register children, and nobody else", async function () {
      await expect(parent.connect(stranger).registerChild(show.target, true, ZERO_BYTES32, ""))
        .to.be.revertedWithCustomError(parent, "NotManager");
      await expect(parent.connect(operator).registerChild(show.target, true, ZERO_BYTES32, ""))
        .to.be.revertedWithCustomError(parent, "NotManager");

      await parent.connect(owner).setOperator(operator.address, true);
      await parent.connect(operator).registerChild(show.target, true, ZERO_BYTES32, "");
      await expect(parent.connect(owner).registerChild(ZERO_ADDRESS, true, ZERO_BYTES32, ""))
        .to.be.revertedWithCustomError(parent, "ZeroAddress");
    });

    it("lets an operator of an org owner register children", async function () {
      const org = await (await ethers.getContractFactory("MockOrgWallet")).deploy();
      await org.waitForDeployment();
      await org.setOperator(orgOperator.address, true);
      const orgParent = await createParent(orgOperator, org.target, OwnerMode.Org);

      await orgParent.connect(orgOperator).registerChild(show.target, true, ZERO_BYTES32, "");
      await expect(orgParent.connect(stranger).registerChild(show.target, false, ZERO_BYTES32, ""))
        .to.be.revertedWithCustomError(orgParent, "NotManager");
    });

    it("recognises a link the child's side registered directly in the registry", async function () {
      expect(await parent.isChildLinked(show.target)).to.equal(false);

      // A show party registers CHILD_OF (show → container); it needs the owner to confirm.
      const id = edgeIdOf(show.target, parent.target, EdgeType.CHILD_OF);
      await registry.connect(venue).registerEdge(show.target, parent.target, EdgeType.CHILD_OF, ZERO_BYTES32, "");
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);
      expect(await parent.isChildLinked(show.target)).to.equal(false);

      await registry.connect(owner).confirmEdge(id);
      expect(await parent.isChildLinked(show.target)).to.equal(true);
    });

    it("does not count an unrelated or retired link", async function () {
      const other = await (await ethers.getContractFactory("MockGraphNode")).deploy(venue.address, artist.address);
      await other.waitForDeployment();

      // A REFERENCES edge is not a parent/child link.
      await registry.connect(owner).registerEdge(parent.target, other.target, EdgeType.REFERENCES, ZERO_BYTES32, "");
      expect(await parent.isChildLinked(other.target)).to.equal(false);

      // A link replaced by an edge that points somewhere else stops counting.
      const id = edgeIdOf(parent.target, show.target, EdgeType.PARENTS);
      await parent.connect(owner).registerChild(show.target, true, ZERO_BYTES32, "");
      await registry.connect(venue).confirmEdge(id);
      await registry.connect(artist).confirmEdge(id);
      expect(await parent.isChildLinked(show.target)).to.equal(true);

      const elsewhere = edgeIdOf(parent.target, other.target, EdgeType.PARENTS);
      await parent.connect(owner).registerChild(other.target, true, ZERO_BYTES32, "");
      await registry.connect(venue).confirmEdge(elsewhere);
      await registry.connect(artist).confirmEdge(elsewhere);
      await registry.connect(owner).supersedeEdge(id, elsewhere);

      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Inactive);
      expect(await parent.isChildLinked(show.target)).to.equal(false);
      expect(await parent.isChildLinked(other.target)).to.equal(true);
    });

    it("keeps counting a link that was replaced by an edge between the same nodes", async function () {
      const id = edgeIdOf(parent.target, show.target, EdgeType.PARENTS);
      await parent.connect(owner).registerChild(show.target, true, ZERO_BYTES32, "");
      await registry.connect(venue).confirmEdge(id);
      await registry.connect(artist).confirmEdge(id);

      // Same nodes and type, new metadata: a revision of the same link.
      const v2 = edgeIdOf(parent.target, show.target, EdgeType.PARENTS, ethers.id("v2"));
      await registry.connect(owner).registerEdge(parent.target, show.target, EdgeType.PARENTS, ethers.id("v2"), "ipfs://v2");
      await registry.connect(venue).confirmEdge(v2);
      await registry.connect(artist).confirmEdge(v2);
      await registry.connect(owner).supersedeEdge(id, v2);
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Inactive);
      expect(await parent.isChildLinked(show.target)).to.equal(true);

      // Revising it again keeps the link: v1 -> v2 -> v3 are all the same relationship.
      const v3 = edgeIdOf(parent.target, show.target, EdgeType.PARENTS, ethers.id("v3"));
      await registry.connect(owner).registerEdge(parent.target, show.target, EdgeType.PARENTS, ethers.id("v3"), "");
      await registry.connect(venue).confirmEdge(v3);
      await registry.connect(artist).confirmEdge(v3);
      await registry.connect(owner).supersedeEdge(v2, v3);
      expect(await parent.isChildLinked(show.target)).to.equal(true);
    });
  });
});
