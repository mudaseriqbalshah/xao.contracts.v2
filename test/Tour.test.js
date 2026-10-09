// test/Tour.test.js
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const ZERO_BYTES32 = ethers.ZeroHash;
const ZERO_ADDRESS = ethers.ZeroAddress;

const EdgeType   = { HAS_MODULE: 0, CHILD_OF: 1, PARENTS: 2 };
const EdgeStatus = { None: 0, Pending: 1, Active: 2, Inactive: 3 };
const TPAStatus  = { Draft: 0, Active: 1, Terminated: 2, Superseded: 3 };

const TOUR_META_CID  = "ipfs://tour-meta";
const TOUR_META_HASH = ethers.id("tour-meta");
const TERMS_HASH     = ethers.id("tpa-terms");

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function edgeIdOf(from, to, edgeType, metaHash = ZERO_BYTES32) {
  return ethers.solidityPackedKeccak256(
    ["address", "address", "uint8", "bytes32"],
    [from, to, edgeType, metaHash]
  );
}

function tpaConfig(partyB, overrides = {}) {
  return {
    partyB,
    termsHash: TERMS_HASH,
    termsCID: "ipfs://tpa-terms",
    effectiveFrom: 0,
    effectiveTo: 0,
    metaHash: ZERO_BYTES32,
    metaCID: "",
    supersedes: ZERO_ADDRESS,
    ...overrides,
  };
}

async function deployTourSystem() {
  const registry = await (await ethers.getContractFactory("GraphRegistry")).deploy();
  await registry.waitForDeployment();
  const tpaImpl = await (await ethers.getContractFactory("TourParticipationAgreement")).deploy();
  await tpaImpl.waitForDeployment();
  const shellImpl = await (await ethers.getContractFactory("TourShell")).deploy();
  await shellImpl.waitForDeployment();
  const factory = await (await ethers.getContractFactory("TourFactory"))
    .deploy(shellImpl.target, tpaImpl.target, registry.target);
  await factory.waitForDeployment();
  return { registry, tpaImpl, shellImpl, factory };
}

async function createShell(factory, owner, tourId = ZERO_BYTES32) {
  const tx = await factory.connect(owner).createTourShell(tourId, TOUR_META_CID, TOUR_META_HASH);
  const receipt = await tx.wait();
  const log = receipt.logs
    .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((l) => l && l.name === "TourShellCreated");
  return ethers.getContractAt("TourShell", log.args.tourShell);
}

async function createTPA(shell, caller, partyB, overrides = {}) {
  const tx = await shell.connect(caller).createTourParticipationAgreement(tpaConfig(partyB, overrides));
  const receipt = await tx.wait();
  const log = receipt.logs
    .map((l) => { try { return shell.interface.parseLog(l); } catch { return null; } })
    .find((l) => l && l.name === "TPACreated");
  return ethers.getContractAt("TourParticipationAgreement", log.args.tpa);
}

async function deployShow(partyA, partyB) {
  const show = await (await ethers.getContractFactory("MockGraphNode")).deploy(partyA, partyB);
  await show.waitForDeployment();
  return show;
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

describe("Tour contracts", function () {
  let registry, tpaImpl, shellImpl, factory;
  let agent, band1, band2, venue, artist, operator, stranger;
  let shell;

  beforeEach(async function () {
    [, agent, band1, band2, venue, artist, operator, stranger] = await ethers.getSigners();
    ({ registry, tpaImpl, shellImpl, factory } = await deployTourSystem());
    shell = await createShell(factory, agent);
  });

  describe("TourFactory", function () {
    it("rejects zero addresses at construction", async function () {
      const F = await ethers.getContractFactory("TourFactory");
      await expect(F.deploy(ZERO_ADDRESS, tpaImpl.target, registry.target))
        .to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(shellImpl.target, ZERO_ADDRESS, registry.target))
        .to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(shellImpl.target, tpaImpl.target, ZERO_ADDRESS))
        .to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("creates a shell owned by the caller and records it", async function () {
      expect(await shell.owner()).to.equal(agent.address);
      expect(await shell.graphRegistry()).to.equal(registry.target);
      expect(await shell.tpaImplementation()).to.equal(tpaImpl.target);
      expect(await shell.tourMetaCID()).to.equal(TOUR_META_CID);
      expect(await shell.tourMetaHash()).to.equal(TOUR_META_HASH);

      expect(await factory.getTourCount()).to.equal(1);
      expect(await factory.getUserTours(agent.address)).to.deep.equal([shell.target]);
    });

    it("derives the tour id when none is supplied, and keeps a supplied one", async function () {
      const derived = ethers.solidityPackedKeccak256(
        ["address", "bytes32", "string"],
        [agent.address, TOUR_META_HASH, TOUR_META_CID]
      );
      expect(await shell.tourId()).to.equal(derived);

      const supplied = ethers.id("my-tour");
      const shell2 = await createShell(factory, agent, supplied);
      expect(await shell2.tourId()).to.equal(supplied);
    });
  });

  describe("TourShell", function () {
    it("cannot be initialized twice, and the implementation is locked", async function () {
      await expect(
        shell.initialize(stranger.address, registry.target, tpaImpl.target, ZERO_BYTES32, "", ZERO_BYTES32)
      ).to.be.revertedWithCustomError(shell, "AlreadyInitialized");
      await expect(
        shellImpl.initialize(stranger.address, registry.target, tpaImpl.target, ZERO_BYTES32, "", ZERO_BYTES32)
      ).to.be.revertedWithCustomError(shellImpl, "AlreadyInitialized");
    });

    it("acts as a single-party graph node", async function () {
      expect(await shell.partyA()).to.equal(agent.address);
      expect(await shell.partyB()).to.equal(ZERO_ADDRESS);
      expect(await registry.getRequiredConfirmersForNode(shell.target)).to.deep.equal([agent.address]);
    });

    it("lets only the owner manage operators", async function () {
      await expect(shell.connect(stranger).setOperator(operator.address, true))
        .to.be.revertedWithCustomError(shell, "NotOwner");

      await expect(shell.connect(agent).setOperator(operator.address, true))
        .to.emit(shell, "OperatorSet").withArgs(operator.address, true);
      expect(await shell.isOperator(operator.address)).to.equal(true);
      expect(await shell.isGraphOperator(operator.address)).to.equal(true);

      await shell.connect(agent).setOperator(operator.address, false);
      expect(await shell.isGraphOperator(operator.address)).to.equal(false);
    });
  });

  describe("Creating a Tour Participation Agreement", function () {
    it("deploys a Draft TPA between the tour owner and the participant", async function () {
      const tpa = await createTPA(shell, agent, band1.address, { effectiveFrom: 100, effectiveTo: 200 });

      expect(await tpa.partyA()).to.equal(agent.address);
      expect(await tpa.partyB()).to.equal(band1.address);
      expect(await tpa.tourShell()).to.equal(shell.target);
      expect(await tpa.graphRegistry()).to.equal(registry.target);
      expect(await tpa.termsHash()).to.equal(TERMS_HASH);
      expect(await tpa.termsCID()).to.equal("ipfs://tpa-terms");
      expect(await tpa.effectiveFrom()).to.equal(100);
      expect(await tpa.effectiveTo()).to.equal(200);
      expect(await tpa.status()).to.equal(TPAStatus.Draft);

      expect(await shell.isTPA(tpa.target)).to.equal(true);
      expect(await shell.tpaCount()).to.equal(1);
      expect(await shell.getTPAs()).to.deep.equal([tpa.target]);
    });

    it("registers both shell ↔ TPA edges as Active", async function () {
      const tpa = await createTPA(shell, agent, band1.address);

      expect(await registry.edgeStatus(edgeIdOf(shell.target, tpa.target, EdgeType.PARENTS)))
        .to.equal(EdgeStatus.Active);
      expect(await registry.edgeStatus(edgeIdOf(tpa.target, shell.target, EdgeType.CHILD_OF)))
        .to.equal(EdgeStatus.Active);
      expect(await registry.edgesFromCount(shell.target)).to.equal(1);
      expect(await registry.edgesToCount(shell.target)).to.equal(1);
    });

    it("keeps the tour owner as partyA when an operator creates the TPA", async function () {
      await shell.connect(agent).setOperator(operator.address, true);
      const tpa = await createTPA(shell, operator, band1.address);
      expect(await tpa.partyA()).to.equal(agent.address);
    });

    it("rejects a caller who is neither owner nor operator", async function () {
      await expect(
        shell.connect(stranger).createTourParticipationAgreement(tpaConfig(band1.address))
      ).to.be.revertedWithCustomError(shell, "NotOwnerOrOperator");
    });

    it("rejects a missing participant, missing terms, or an invalid window", async function () {
      await expect(
        shell.connect(agent).createTourParticipationAgreement(tpaConfig(ZERO_ADDRESS))
      ).to.be.revertedWithCustomError(tpaImpl, "ZeroParty");
      await expect(
        shell.connect(agent).createTourParticipationAgreement(tpaConfig(band1.address, { termsHash: ZERO_BYTES32 }))
      ).to.be.revertedWithCustomError(tpaImpl, "ZeroTermsHash");
      await expect(
        shell.connect(agent).createTourParticipationAgreement(
          tpaConfig(band1.address, { effectiveFrom: 200, effectiveTo: 200 })
        )
      ).to.be.revertedWithCustomError(tpaImpl, "InvalidEffectiveWindow");
    });
  });

  describe("Registering an existing TPA", function () {
    it("registers a TPA that names this shell", async function () {
      const cloner = await (await ethers.getContractFactory("MockCloner")).deploy();
      await cloner.waitForDeployment();
      const receipt = await (await cloner.clone(tpaImpl.target)).wait();
      const cloneAddr = cloner.interface.parseLog(receipt.logs[0]).args.clone;
      const tpa = await ethers.getContractAt("TourParticipationAgreement", cloneAddr);
      await tpa.initialize(
        agent.address, band1.address, shell.target, registry.target,
        0, 0, TERMS_HASH, "", ZERO_BYTES32, "", ZERO_ADDRESS
      );

      await expect(shell.connect(agent).registerTourParticipationAgreement(tpa.target, ZERO_BYTES32, ""))
        .to.emit(shell, "TPARegistered").withArgs(tpa.target);
      expect(await shell.isTPA(tpa.target)).to.equal(true);
      expect(await registry.edgeStatus(edgeIdOf(shell.target, tpa.target, EdgeType.PARENTS)))
        .to.equal(EdgeStatus.Active);
    });

    it("rejects a TPA that belongs to another shell, or one already registered", async function () {
      const tpa = await createTPA(shell, agent, band1.address);
      const otherShell = await createShell(factory, agent, ethers.id("other-tour"));

      await expect(
        otherShell.connect(agent).registerTourParticipationAgreement(tpa.target, ZERO_BYTES32, "")
      ).to.be.revertedWithCustomError(otherShell, "TPANotForThisShell");
      await expect(
        shell.connect(agent).registerTourParticipationAgreement(tpa.target, ZERO_BYTES32, "")
      ).to.be.revertedWithCustomError(shell, "TPAAlreadyRegistered");
    });
  });

  describe("TourParticipationAgreement lifecycle", function () {
    let tpa;

    beforeEach(async function () {
      tpa = await createTPA(shell, agent, band1.address);
    });

    it("cannot be initialized twice, and the implementation is locked", async function () {
      const args = [
        agent.address, band1.address, shell.target, registry.target,
        0, 0, TERMS_HASH, "", ZERO_BYTES32, "", ZERO_ADDRESS,
      ];
      await expect(tpa.initialize(...args)).to.be.revertedWithCustomError(tpa, "AlreadyInitialized");
      await expect(tpaImpl.initialize(...args)).to.be.revertedWithCustomError(tpaImpl, "AlreadyInitialized");
    });

    it("becomes Active once both parties have signed", async function () {
      await expect(tpa.connect(agent).sign()).to.emit(tpa, "Signed").withArgs(agent.address);
      expect(await tpa.status()).to.equal(TPAStatus.Draft);

      await expect(tpa.connect(band1).sign()).to.emit(tpa, "Activated");
      expect(await tpa.status()).to.equal(TPAStatus.Active);
    });

    it("rejects a non-party, a second signature, or signing after activation", async function () {
      await expect(tpa.connect(stranger).sign()).to.be.revertedWithCustomError(tpa, "NotAParty");

      await tpa.connect(agent).sign();
      await expect(tpa.connect(agent).sign()).to.be.revertedWithCustomError(tpa, "AlreadySigned");

      await tpa.connect(band1).sign();
      await expect(tpa.connect(band1).sign()).to.be.revertedWithCustomError(tpa, "NotDraft");
    });

    it("terminates only when both parties agree", async function () {
      await tpa.connect(agent).sign();
      await tpa.connect(band1).sign();

      await expect(tpa.connect(band1).terminate("ipfs://reason"))
        .to.emit(tpa, "TerminationRequested").withArgs(band1.address, "ipfs://reason");
      expect(await tpa.status()).to.equal(TPAStatus.Active);
      await expect(tpa.connect(band1).terminate("ipfs://reason"))
        .to.be.revertedWithCustomError(tpa, "AlreadyVoted");

      await expect(tpa.connect(agent).terminate("ipfs://agreed"))
        .to.emit(tpa, "Terminated").withArgs("ipfs://agreed");
      expect(await tpa.status()).to.equal(TPAStatus.Terminated);

      await expect(tpa.connect(agent).terminate("")).to.be.revertedWithCustomError(tpa, "NotDraftOrActive");
    });

    it("leaves the tour and the other bands untouched when one band drops out", async function () {
      const tpa2 = await createTPA(shell, agent, band2.address);
      for (const t of [tpa, tpa2]) {
        await t.connect(agent).sign();
      }
      await tpa.connect(band1).sign();
      await tpa2.connect(band2).sign();

      await tpa2.connect(band2).terminate("");
      await tpa2.connect(agent).terminate("");

      expect(await tpa2.status()).to.equal(TPAStatus.Terminated);
      expect(await tpa.status()).to.equal(TPAStatus.Active);
      expect(await shell.tpaCount()).to.equal(2);
      expect(await registry.edgeStatus(edgeIdOf(shell.target, tpa.target, EdgeType.PARENTS)))
        .to.equal(EdgeStatus.Active);
    });

    it("is superseded when both parties name the same replacement", async function () {
      await tpa.connect(agent).sign();
      await tpa.connect(band1).sign();
      const next = await createTPA(shell, agent, band1.address, {
        termsHash: ethers.id("tpa-terms-v2"),
        supersedes: tpa.target,
      });
      expect(await next.supersedes()).to.equal(tpa.target);

      await expect(tpa.connect(agent).supersedeWith(next.target))
        .to.emit(tpa, "SupersedeRequested").withArgs(agent.address, next.target);
      expect(await tpa.status()).to.equal(TPAStatus.Active);

      await expect(tpa.connect(band1).supersedeWith(next.target))
        .to.emit(tpa, "Superseded").withArgs(next.target);
      expect(await tpa.status()).to.equal(TPAStatus.Superseded);
      expect(await tpa.supersededBy()).to.equal(next.target);
    });

    it("rejects superseding before activation or with a replacement that does not point back", async function () {
      const unrelated = await createTPA(shell, agent, band2.address);
      await expect(tpa.connect(agent).supersedeWith(unrelated.target))
        .to.be.revertedWithCustomError(tpa, "NotActive");

      await tpa.connect(agent).sign();
      await tpa.connect(band1).sign();
      await expect(tpa.connect(agent).supersedeWith(unrelated.target))
        .to.be.revertedWithCustomError(tpa, "NewTPADoesNotPointBack");
      await expect(tpa.connect(agent).supersedeWith(ZERO_ADDRESS))
        .to.be.revertedWithCustomError(tpa, "ZeroAddress");
      await expect(tpa.connect(stranger).supersedeWith(unrelated.target))
        .to.be.revertedWithCustomError(tpa, "NotAParty");
    });

    it("names only its tour shell as graph operator", async function () {
      expect(await tpa.isGraphOperator(shell.target)).to.equal(true);
      expect(await tpa.isGraphOperator(agent.address)).to.equal(false);
    });
  });

  describe("Linking a show under a TPA", function () {
    let tpa, show, parentsId, childOfId;

    beforeEach(async function () {
      tpa  = await createTPA(shell, agent, band1.address);
      show = await deployShow(venue.address, artist.address);
      parentsId = edgeIdOf(tpa.target, show.target, EdgeType.PARENTS);
      childOfId = edgeIdOf(show.target, tpa.target, EdgeType.CHILD_OF);
    });

    it("registers both edges as Pending", async function () {
      await expect(shell.connect(agent).linkShowToTPA(tpa.target, show.target, ZERO_BYTES32, ""))
        .to.emit(shell, "ShowLinkedPending")
        .withArgs(tpa.target, show.target, parentsId, childOfId);

      expect(await registry.edgeStatus(parentsId)).to.equal(EdgeStatus.Pending);
      expect(await registry.edgeStatus(childOfId)).to.equal(EdgeStatus.Pending);
      expect(await registry.getRequiredConfirmersForEdge(parentsId))
        .to.deep.equal([venue.address, artist.address]);
      expect(await registry.getRequiredConfirmersForEdge(childOfId))
        .to.deep.equal([venue.address, artist.address]);
    });

    it("activates only after both show parties confirm", async function () {
      await shell.connect(agent).linkShowToTPA(tpa.target, show.target, ZERO_BYTES32, "");

      for (const id of [parentsId, childOfId]) {
        await registry.connect(venue).confirmEdge(id);
        expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);
        await registry.connect(artist).confirmEdge(id);
        expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Active);
      }
    });

    it("does not let the tour side confirm for the show", async function () {
      await shell.connect(agent).linkShowToTPA(tpa.target, show.target, ZERO_BYTES32, "");

      for (const signer of [agent, band1, stranger]) {
        await expect(registry.connect(signer).confirmEdge(parentsId))
          .to.be.revertedWithCustomError(registry, "NothingToConfirm");
      }
    });

    it("lets an operator start the link", async function () {
      await shell.connect(agent).setOperator(operator.address, true);
      await shell.connect(operator).linkShowToTPA(tpa.target, show.target, ZERO_BYTES32, "");
      expect(await registry.edgeStatus(parentsId)).to.equal(EdgeStatus.Pending);
    });

    it("rejects an outsider, an unknown TPA, or a zero show address", async function () {
      await expect(
        shell.connect(stranger).linkShowToTPA(tpa.target, show.target, ZERO_BYTES32, "")
      ).to.be.revertedWithCustomError(shell, "NotOwnerOrOperator");

      const otherShell = await createShell(factory, agent, ethers.id("other-tour"));
      const foreignTPA = await createTPA(otherShell, agent, band2.address);
      await expect(
        shell.connect(agent).linkShowToTPA(foreignTPA.target, show.target, ZERO_BYTES32, "")
      ).to.be.revertedWithCustomError(shell, "UnknownTPA");

      await expect(
        shell.connect(agent).linkShowToTPA(tpa.target, ZERO_ADDRESS, ZERO_BYTES32, "")
      ).to.be.revertedWithCustomError(shell, "ZeroAddress");
    });

    it("cannot link a show directly through the registry without authority on the tour", async function () {
      await expect(
        registry.connect(stranger).registerEdge(tpa.target, show.target, EdgeType.PARENTS, ZERO_BYTES32, "")
      ).to.be.revertedWithCustomError(registry, "NotAuthorized");
    });
  });
});
