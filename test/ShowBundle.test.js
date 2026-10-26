// test/ShowBundle.test.js
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time }   = require("@nomicfoundation/hardhat-network-helpers");
const {
  USDC,
  ONE_DAY,
  ZERO_BYTES32,
  ZERO_ADDRESS,
  MAX_UINT64,
  PartyRole,
  ShowStatus,
  EscrowStatus,
  PayoutKind,
  Resolution,
  TicketType,
  EdgeType,
  EdgeStatus,
  TICKET_PRICE,
  GAS_FEE,
  ESCROWED,
  XAO_FEE,
  tier,
  edgeIdOf,
  deploySystem,
  showConfig,
  createShow,
} = require("./helpers/show");

// ─── TESTS ────────────────────────────────────────────────────────────────────

describe("Show bundle", function () {
  let registry, usdc, factory, showImpl, escrowImpl, ticketImpl, validatorImpl;
  let owner, promoter, artist, treasury, fan1, fan2, fan3, scanner, stranger, marketplace;
  let t0, cfg, show, escrow, ticket, validator;

  async function fund(signer, amount, spender) {
    await usdc.mint(signer.address, amount);
    await usdc.connect(signer).approve(spender, amount);
  }

  async function signBoth() {
    await show.connect(promoter).signTerms();
    await show.connect(artist).signTerms();
  }

  async function buy(signer, tierId = 0) {
    await fund(signer, TICKET_PRICE, ticket.target);
    await ticket.connect(signer).buyTicket(tierId);
  }

  beforeEach(async function () {
    [owner, promoter, artist, treasury, fan1, fan2, fan3, scanner, stranger, marketplace] =
      await ethers.getSigners();
    ({ registry, usdc, factory, showImpl, escrowImpl, ticketImpl, validatorImpl } = await deploySystem());
    t0  = await time.latest();
    cfg = showConfig(promoter, artist, t0);
    ({ show, escrow, ticket, validator } = await createShow(factory, promoter, cfg));
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("ShowFactory", function () {
    it("deploys the bundle at the predicted addresses and wires the modules", async function () {
      const showId = await factory.deriveShowId(promoter.address, cfg);
      const predicted = await factory.predictBundle(showId);

      expect(show.target).to.equal(predicted.showInstance);
      expect(escrow.target).to.equal(predicted.escrow);
      expect(ticket.target).to.equal(predicted.ticketContract);
      expect(validator.target).to.equal(predicted.entryValidator);

      expect(await show.showId()).to.equal(showId);
      expect(await show.escrow()).to.equal(escrow.target);
      expect(await show.ticketContract()).to.equal(ticket.target);
      expect(await show.entryValidator()).to.equal(validator.target);
      expect(await escrow.ticketContract()).to.equal(ticket.target);
      expect(await escrow.show()).to.equal(show.target);
      expect(await ticket.escrow()).to.equal(escrow.target);
      expect(await ticket.entryValidator()).to.equal(validator.target);
      expect(await validator.eventRoot()).to.equal(show.target);
      expect(await validator.ticketContract()).to.equal(ticket.target);
    });

    it("registers the module edges in the graph as Active", async function () {
      for (const module of [escrow, ticket, validator]) {
        expect(await registry.edgeStatus(edgeIdOf(show.target, module.target, EdgeType.HAS_MODULE)))
          .to.equal(EdgeStatus.Active);
      }
      expect(await registry.edgesFromCount(show.target)).to.equal(3);
    });

    it("records the show for both parties", async function () {
      expect(await factory.getShowCount()).to.equal(1);
      expect(await factory.getUserShows(promoter.address)).to.deep.equal([show.target]);
      expect(await factory.getUserShows(artist.address)).to.deep.equal([show.target]);
      expect(await factory.showById(await show.showId())).to.equal(show.target);
    });

    it("skips tickets and the validator when tickets are disabled", async function () {
      const noTix = showConfig(promoter, artist, t0, {
        tickets: { ticketsEnabled: false },
        anchors: { termsHash: ethers.id("terms-no-tickets") },
      });
      const b = await createShow(factory, promoter, noTix);
      expect(b.ticket).to.equal(null);
      expect(b.validator).to.equal(null);
      expect(await b.show.ticketContract()).to.equal(ZERO_ADDRESS);
      expect(await b.escrow.ticketContract()).to.equal(ZERO_ADDRESS);
      expect(await registry.edgesFromCount(b.show.target)).to.equal(1);
    });

    it("cannot create the same show twice", async function () {
      await expect(factory.connect(promoter).createShow(cfg)).to.be.reverted;
    });

    it("ties a client-chosen show id to its creator", async function () {
      const chosen = { ...showConfig(promoter, artist, t0), showId: ethers.id("my-show") };
      const expected = ethers.solidityPackedKeccak256(["address", "bytes32"], [promoter.address, chosen.showId]);
      expect(await factory.deriveShowId(promoter.address, chosen)).to.equal(expected);

      // Someone else using the same chosen id gets a different show, so they
      // cannot block the promoter's.
      const theirs = await createShow(factory, stranger, chosen);
      const mine   = await createShow(factory, promoter, chosen);
      expect(await mine.show.showId()).to.equal(expected);
      expect(theirs.show.target).to.not.equal(mine.show.target);
    });

    it("rejects arbitration until an agent is configured, and new shows while paused", async function () {
      const withArb = { ...showConfig(promoter, artist, t0), arbitrationEnabled: true, showId: ethers.id("arb") };
      await expect(factory.connect(promoter).createShow(withArb))
        .to.be.revertedWithCustomError(factory, "ArbitrationNotAvailable");

      await factory.connect(owner).setPaused(true);
      const other = { ...showConfig(promoter, artist, t0), showId: ethers.id("paused") };
      await expect(factory.connect(promoter).createShow(other))
        .to.be.revertedWithCustomError(factory, "FactoryPaused");
    });

    it("lets only the owner change protocol settings", async function () {
      await expect(factory.connect(stranger).setTreasury(stranger.address))
        .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
      await expect(factory.connect(stranger).setPaused(true))
        .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
      await expect(
        factory.connect(stranger).setImplementations(
          showImpl.target, escrowImpl.target, ticketImpl.target, validatorImpl.target
        )
      ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");

      await factory.connect(owner).setTreasury(stranger.address);
      expect(await factory.treasury()).to.equal(stranger.address);
      await expect(factory.connect(owner).setTreasury(ZERO_ADDRESS))
        .to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("ShowInstance", function () {
    it("stores parties, terms and anchors", async function () {
      expect(await show.partyA()).to.equal(promoter.address);
      expect(await show.partyB()).to.equal(artist.address);
      expect(await show.creator()).to.equal(promoter.address);
      expect((await show.partyAInfo()).role).to.equal(PartyRole.PROMOTER);
      expect((await show.partyBInfo()).role).to.equal(PartyRole.ARTIST);

      const dates = await show.dates();
      expect(dates.doorsOpenTime).to.equal(cfg.dates.doorsOpenTime);
      expect(dates.setTime).to.equal(cfg.dates.setTime);
      expect(dates.setLengthMinutes).to.equal(60);
      expect(dates.eventEndDate).to.equal(cfg.dates.eventStartDate); // defaulted
      expect(await show.showEndTime()).to.equal(cfg.dates.showEndTime);

      const loc = await show.location();
      expect(loc.venueName).to.equal("Test Venue");
      expect(loc.radiusMiles).to.equal(50);

      const fin = await show.financials();
      expect(fin.guaranteeUSDC).to.equal(USDC(1_000));
      expect(fin.backendBPS).to.equal(2_000);

      const terms = await show.ticketTerms();
      expect(terms.totalCapacity).to.equal(100);
      expect(terms.salesTaxBPS).to.equal(800);
      expect(terms.compTickets).to.equal(5);

      expect(await show.eventName()).to.equal("Test Show");
      expect(await show.getGenres()).to.deep.equal(["rock", "indie"]);
      expect(await show.legalTextHash()).to.equal(ethers.id("legal"));
      expect(await show.termsHash()).to.equal(ethers.id("terms"));
      expect(await show.status()).to.equal(ShowStatus.Offer);
    });

    it("takes a username only from the party creating the show", async function () {
      expect((await show.partyAInfo()).xaoUsername).to.equal("promoter1");
      expect((await show.partyBInfo()).xaoUsername).to.equal("");

      await expect(show.connect(artist).setUsername("artist1"))
        .to.emit(show, "UsernameSet").withArgs(artist.address, "artist1");
      expect((await show.partyBInfo()).xaoUsername).to.equal("artist1");
      expect((await show.partyAInfo()).xaoUsername).to.equal("promoter1");

      await expect(show.connect(stranger).setUsername("x"))
        .to.be.revertedWithCustomError(show, "NotAParty");
    });

    it("cannot be initialized twice, and module setters are factory-only", async function () {
      await expect(show.initializeOffer({ ...cfg, creator: promoter.address, arbitrationAgent: ZERO_ADDRESS }))
        .to.be.revertedWithCustomError(show, "AlreadyInitialized");
      await expect(show.connect(promoter).setEscrowModule(stranger.address))
        .to.be.revertedWithCustomError(show, "NotFactory");
      await expect(show.connect(promoter).setTicketingModule(stranger.address, stranger.address))
        .to.be.revertedWithCustomError(show, "NotFactory");
    });

    it("rejects invalid offers", async function () {
      const bad = (overrides, id) => ({ ...showConfig(promoter, artist, t0, overrides), showId: ethers.id(id) });

      await expect(factory.connect(promoter).createShow(bad({ anchors: { termsHash: ZERO_BYTES32 } }, "a")))
        .to.be.revertedWithCustomError(showImpl, "ZeroTermsHash");
      await expect(factory.connect(promoter).createShow(bad({ anchors: { legalTextHash: ZERO_BYTES32 } }, "b")))
        .to.be.revertedWithCustomError(showImpl, "ZeroLegalTextHash");
      await expect(
        factory.connect(promoter).createShow(bad({ dates: { showEndTime: t0 + 30 * ONE_DAY } }, "c"))
      ).to.be.revertedWithCustomError(showImpl, "InvalidTimes");
      await expect(
        factory.connect(promoter).createShow(bad({ financials: { guaranteePctBPS: 5_000 } }, "d"))
      ).to.be.revertedWithCustomError(showImpl, "GuaranteeUseFlatOrPctNotBoth");
      await expect(
        factory.connect(promoter).createShow(bad({ tickets: { resalePartyABPS: 1 } }, "e"))
      ).to.be.revertedWithCustomError(showImpl, "ResaleSplitsMustSumTo10000");

      const noPartyA = bad({}, "f");
      noPartyA.partyA.wallet = ZERO_ADDRESS;
      await expect(factory.connect(promoter).createShow(noPartyA))
        .to.be.revertedWithCustomError(showImpl, "ZeroPartyAddress");
    });

    it("becomes Signed once both parties have signed", async function () {
      await expect(show.connect(promoter).signTerms())
        .to.emit(show, "TermsSigned").withArgs(promoter.address);
      expect(await show.status()).to.equal(ShowStatus.Offer);
      expect(await show.anySigned()).to.equal(true);
      expect(await show.isFinalized()).to.equal(false);

      await expect(show.connect(artist).signTerms())
        .to.emit(show, "ShowSigned").withArgs(ethers.id("terms"));
      expect(await show.status()).to.equal(ShowStatus.Signed);
      expect(await show.isFinalized()).to.equal(true);
    });

    it("rejects a non-party, a second signature, or signing after it is Signed", async function () {
      await expect(show.connect(stranger).signTerms()).to.be.revertedWithCustomError(show, "NotAParty");
      await show.connect(promoter).signTerms();
      await expect(show.connect(promoter).signTerms()).to.be.revertedWithCustomError(show, "AlreadySigned");
      await show.connect(artist).signTerms();
      await expect(show.connect(artist).signTerms()).to.be.revertedWithCustomError(show, "NotOffer");
    });

    it("supports a single-party show", async function () {
      const solo = showConfig(promoter, null, t0);
      const b = await createShow(factory, promoter, solo);
      expect(await b.show.partyB()).to.equal(ZERO_ADDRESS);
      await b.show.connect(promoter).signTerms();
      expect(await b.show.status()).to.equal(ShowStatus.Signed);
      expect(await factory.getUserShows(promoter.address)).to.have.lengthOf(2);
    });

    it("lets parties update promo metadata until doors open, never the terms", async function () {
      await expect(show.connect(artist).updateShowMeta("ipfs://meta2", ethers.id("meta2")))
        .to.emit(show, "ShowMetaUpdated").withArgs(ethers.id("meta2"), "ipfs://meta2");
      expect(await show.showMetaCID()).to.equal("ipfs://meta2");
      await show.connect(promoter).setFlyerDNSLink("ipns://flyer2");
      expect(await show.flyerDNSLink()).to.equal("ipns://flyer2");

      await expect(show.connect(stranger).updateShowMeta("x", ZERO_BYTES32))
        .to.be.revertedWithCustomError(show, "NotAParty");

      await time.increaseTo(cfg.dates.doorsOpenTime);
      await expect(show.connect(artist).updateShowMeta("ipfs://meta3", ethers.id("meta3")))
        .to.be.revertedWithCustomError(show, "MetaLocked");
      expect(await show.termsHash()).to.equal(ethers.id("terms"));
    });

    it("can be marked Expired by anyone only after the show's end", async function () {
      await expect(show.connect(stranger).markExpired()).to.be.revertedWithCustomError(show, "NotExpirable");
      await time.increaseTo(cfg.dates.showEndTime + 1);
      expect(await show.isExpired()).to.equal(true);
      await expect(show.connect(stranger).markExpired()).to.emit(show, "ShowExpired");
      expect(await show.status()).to.equal(ShowStatus.Expired);
      await expect(show.connect(stranger).markExpired()).to.be.revertedWithCustomError(show, "NotExpirable");
    });

    it("accepts escrow hooks only from its escrow", async function () {
      await expect(show.connect(promoter).onCompleted()).to.be.revertedWithCustomError(show, "NotEscrow");
      await expect(show.connect(promoter).onCancelled()).to.be.revertedWithCustomError(show, "NotEscrow");
      await expect(show.connect(promoter).onDisputeOpened(ethers.id("x")))
        .to.be.revertedWithCustomError(show, "NotEscrow");
    });

    it("is a graph node whose parties are the show's parties", async function () {
      expect(await registry.getRequiredConfirmersForNode(show.target))
        .to.deep.equal([promoter.address, artist.address]);
      expect(await show.isGraphOperator(factory.target)).to.equal(true);
      expect(await show.isGraphOperator(promoter.address)).to.equal(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("Linking a show into a tour", function () {
    const PARENTS = 2;
    const CHILD_OF = 1;
    let tpa;

    function linkId(from, to, edgeType) {
      return ethers.solidityPackedKeccak256(
        ["address", "address", "uint8", "bytes32"],
        [from, to, edgeType, ZERO_BYTES32]
      );
    }

    // The promoter also runs a tour here, with the artist as the participant.
    beforeEach(async function () {
      const tpaImpl   = await (await ethers.getContractFactory("TourParticipationAgreement")).deploy();
      const shellImpl = await (await ethers.getContractFactory("TourShell")).deploy();
      const tourFactory = await (await ethers.getContractFactory("TourFactory"))
        .deploy(shellImpl.target, tpaImpl.target, registry.target);

      await tourFactory.connect(promoter).createTourShell(ZERO_BYTES32, "ipfs://tour", ethers.id("tour"));
      const shell = await ethers.getContractAt("TourShell", (await tourFactory.getUserTours(promoter.address))[0]);
      await shell.connect(promoter).createTourParticipationAgreement({
        partyB: artist.address,
        termsHash: ethers.id("tpa"),
        termsCID: "",
        effectiveFrom: 0,
        effectiveTo: 0,
        metaHash: ZERO_BYTES32,
        metaCID: "",
        supersedes: ZERO_ADDRESS,
      });
      tpa = (await shell.getTPAs())[0];
    });

    it("goes live at once when the tour owner is a party on the show", async function () {
      await registry.connect(promoter).registerEdges([
        { from: tpa, to: show.target, edgeType: PARENTS, metaHash: ZERO_BYTES32, metaCID: "" },
        { from: show.target, to: tpa, edgeType: CHILD_OF, metaHash: ZERO_BYTES32, metaCID: "" },
      ]);
      expect(await registry.edgeStatus(linkId(tpa, show.target, PARENTS))).to.equal(EdgeStatus.Active);
      expect(await registry.edgeStatus(linkId(show.target, tpa, CHILD_OF))).to.equal(EdgeStatus.Active);
    });

    it("waits for the show's parties when the tour owner is not on the show", async function () {
      const other = showConfig(fan1, fan2, t0, { anchors: { termsHash: ethers.id("other-show") } });
      const b = await createShow(factory, fan1, other);
      const id = linkId(tpa, b.show.target, PARENTS);

      await registry.connect(promoter).registerEdge(tpa, b.show.target, PARENTS, ZERO_BYTES32, "");
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);

      await registry.connect(fan1).confirmEdge(id);
      await registry.connect(fan2).confirmEdge(id);
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Active);
    });

    it("does not let the artist add the show to the tour alone", async function () {
      const id = linkId(tpa, show.target, PARENTS);
      await registry.connect(artist).registerEdge(tpa, show.target, PARENTS, ZERO_BYTES32, "");
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Pending);
      await registry.connect(promoter).confirmEdge(id);
      expect(await registry.edgeStatus(id)).to.equal(EdgeStatus.Active);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("Tickets", function () {
    it("creates the tiers supplied with the show", async function () {
      expect(await ticket.tierCount()).to.equal(1);
      const t = await ticket.getTier(0);
      expect(t.priceUSDC).to.equal(TICKET_PRICE);
      expect(t.quantity).to.equal(10);
      expect(t.partyAResaleBPS).to.equal(500);
      expect(await ticket.eventName()).to.equal("Test Show");
      expect(await ticket.totalCapacity()).to.equal(100);
      expect(await ticket.hasRole(await ticket.ADMIN_ROLE(), promoter.address)).to.equal(true);
    });

    it("lets the admin add tiers only before anyone signs", async function () {
      await ticket.connect(promoter).addTier(tier({ ticketType: TicketType.VIP, priceUSDC: USDC(120) }));
      await ticket.connect(promoter).addTiers([tier({ customName: "Early" }), tier({ customName: "Late" })]);
      expect(await ticket.tierCount()).to.equal(4);

      await expect(ticket.connect(artist).addTier(tier()))
        .to.be.revertedWithCustomError(ticket, "NotAuthorized");
      await expect(ticket.connect(promoter).addTier(tier({ quantity: 0 })))
        .to.be.revertedWithCustomError(ticket, "ZeroQuantity");
      await expect(ticket.connect(promoter).addTier(tier({ resellerBPS: 1 })))
        .to.be.revertedWithCustomError(ticket, "ResaleBpsMustSumTo10000");

      await show.connect(artist).signTerms();
      await expect(ticket.connect(promoter).addTier(tier()))
        .to.be.revertedWithCustomError(ticket, "TiersLocked");
    });

    it("does not sell before the show is signed", async function () {
      await fund(fan1, TICKET_PRICE, ticket.target);
      await expect(ticket.connect(fan1).buyTicket(0)).to.be.revertedWithCustomError(ticket, "ShowNotSigned");
      await show.connect(promoter).signTerms();
      await expect(ticket.connect(fan1).buyTicket(0)).to.be.revertedWithCustomError(ticket, "ShowNotSigned");
    });

    it("sends $1 to the treasury and the rest to escrow, holding the 2% for XAO", async function () {
      await signBoth();
      await fund(fan1, TICKET_PRICE, ticket.target);

      await expect(ticket.connect(fan1).buyTicket(0))
        .to.emit(ticket, "TicketSold").withArgs(1, 0, fan1.address, TICKET_PRICE)
        .and.to.emit(escrow, "TicketRevenueReceived").withArgs(ESCROWED, XAO_FEE);

      expect(await usdc.balanceOf(fan1.address)).to.equal(0);
      expect(await usdc.balanceOf(treasury.address)).to.equal(GAS_FEE);
      expect(await usdc.balanceOf(escrow.target)).to.equal(ESCROWED);
      expect(await usdc.balanceOf(ticket.target)).to.equal(0);

      expect(await escrow.protocolFeeAccrued()).to.equal(XAO_FEE);
      expect(await escrow.distributable()).to.equal(ESCROWED - XAO_FEE);
      expect(await escrow.totalFunded()).to.equal(ESCROWED - XAO_FEE);
    });

    it("mints sequential ids from 1 and records owner and price", async function () {
      await signBoth();
      await buy(fan1);
      await buy(fan2);

      expect(await ticket.lastMintedId()).to.equal(2);
      expect(await ticket.nextTokenId()).to.equal(3);
      expect(await ticket.balanceOf(fan1.address, 1)).to.equal(1);
      expect(await ticket.ownerOf(1)).to.equal(fan1.address);
      expect(await ticket.ownerOf(2)).to.equal(fan2.address);
      expect(await ticket.getPricePaid(1)).to.equal(TICKET_PRICE);
      expect(await ticket.getRefundBasis(1)).to.deep.equal([ESCROWED, XAO_FEE]);
      expect(await ticket.exists(3)).to.equal(false);
      expect(await ticket.totalSold()).to.equal(2);
      expect((await ticket.getTier(0)).sold).to.equal(2);
    });

    it("caps the fees for very cheap and free tickets", async function () {
      const cheapCfg = showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("cheap") },
        tiers: [
          tier({ priceUSDC: USDC("0.5"), customName: "Cheap" }),
          tier({ priceUSDC: 0, ticketType: TicketType.COMP, customName: "Comp" }),
        ],
      });
      const b = await createShow(factory, promoter, cheapCfg);
      await b.show.connect(promoter).signTerms();
      await b.show.connect(artist).signTerms();

      await usdc.mint(fan1.address, USDC("0.5"));
      await usdc.connect(fan1).approve(b.ticket.target, USDC("0.5"));
      await b.ticket.connect(fan1).buyTicket(0);
      expect(await usdc.balanceOf(treasury.address)).to.equal(USDC("0.5"));
      expect(await usdc.balanceOf(b.escrow.target)).to.equal(0);
      expect(await b.ticket.getRefundBasis(1)).to.deep.equal([0n, 0n]);

      await b.ticket.connect(fan2).buyTicket(1);
      expect(await b.ticket.ownerOf(2)).to.equal(fan2.address);
      expect(await b.ticket.getPricePaid(2)).to.equal(0);
    });

    it("enforces on-sale time, tier quantity and total capacity", async function () {
      const limited = showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("limited") },
        tickets: { totalCapacity: 2 },
        tiers: [
          tier({ quantity: 1 }),
          tier({ quantity: 5, customName: "Second" }),
          tier({ quantity: 5, customName: "Later", onSaleTimestamp: t0 + 5 * ONE_DAY }),
        ],
      });
      const b = await createShow(factory, promoter, limited);
      await b.show.connect(promoter).signTerms();
      await b.show.connect(artist).signTerms();
      await usdc.mint(fan1.address, USDC(500));
      await usdc.connect(fan1).approve(b.ticket.target, USDC(500));

      await expect(b.ticket.connect(fan1).buyTicket(9)).to.be.revertedWithCustomError(b.ticket, "InvalidTier");
      await expect(b.ticket.connect(fan1).buyTicket(2)).to.be.revertedWithCustomError(b.ticket, "NotOnSaleYet");

      await b.ticket.connect(fan1).buyTicket(0);
      await expect(b.ticket.connect(fan1).buyTicket(0)).to.be.revertedWithCustomError(b.ticket, "SoldOut");

      await b.ticket.connect(fan1).buyTicket(1);
      await expect(b.ticket.connect(fan1).buyTicket(1)).to.be.revertedWithCustomError(b.ticket, "CapacityReached");
    });

    it("locks transfers until the show ends, except through an approved marketplace", async function () {
      await signBoth();
      await buy(fan1);

      await expect(ticket.connect(fan1).safeTransferFrom(fan1.address, fan2.address, 1, 1, "0x"))
        .to.be.revertedWithCustomError(ticket, "TransfersLocked");

      await ticket.connect(promoter).setMarketplaceApproval(marketplace.address, true);
      await ticket.connect(fan1).setApprovalForAll(marketplace.address, true);
      await ticket.connect(marketplace).safeTransferFrom(fan1.address, fan2.address, 1, 1, "0x");
      expect(await ticket.ownerOf(1)).to.equal(fan2.address);

      await time.increaseTo(cfg.dates.showEndTime);
      await ticket.connect(fan2).safeTransferFrom(fan2.address, fan3.address, 1, 1, "0x");
      expect(await ticket.ownerOf(1)).to.equal(fan3.address);
    });

    it("does not let a scanned ticket move before the show ends, even through a marketplace", async function () {
      await signBoth();
      await buy(fan1);
      await ticket.connect(promoter).setMarketplaceApproval(marketplace.address, true);
      await ticket.connect(fan1).setApprovalForAll(marketplace.address, true);

      await time.increaseTo(cfg.dates.doorsOpenTime);
      await validator.connect(promoter).scanTicket(1, ZERO_BYTES32);

      await expect(ticket.connect(marketplace).safeTransferFrom(fan1.address, fan2.address, 1, 1, "0x"))
        .to.be.revertedWithCustomError(ticket, "TransfersLocked");

      await time.increaseTo(cfg.dates.showEndTime);
      await ticket.connect(fan1).safeTransferFrom(fan1.address, fan2.address, 1, 1, "0x");
    });

    it("reports resale royalties payable to the escrow", async function () {
      await signBoth();
      await buy(fan1);
      const [receiver, amount] = await ticket.royaltyInfo(1, USDC(100));
      expect(receiver).to.equal(escrow.target);
      expect(amount).to.equal(USDC(10));
      await expect(ticket.royaltyInfo(2, USDC(100))).to.be.revertedWithCustomError(ticket, "InvalidToken");
    });

    it("keeps scan and burn for the validator and the escrow only", async function () {
      await signBoth();
      await buy(fan1);
      await expect(ticket.connect(promoter).scan(1, ZERO_BYTES32))
        .to.be.revertedWithCustomError(ticket, "NotEntryValidator");
      await expect(ticket.connect(promoter).burnRefunded(1))
        .to.be.revertedWithCustomError(ticket, "NotEscrow");
    });

    it("lets the admin pause sales", async function () {
      await signBoth();
      await ticket.connect(promoter).pause();
      await fund(fan1, TICKET_PRICE, ticket.target);
      await expect(ticket.connect(fan1).buyTicket(0)).to.be.revertedWithCustomError(ticket, "EnforcedPause");
      await ticket.connect(promoter).unpause();
      await ticket.connect(fan1).buyTicket(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("EntryValidator", function () {
    beforeEach(async function () {
      await signBoth();
      await buy(fan1);
    });

    it("starts with partyA as a scanner and the doors-to-end scan window", async function () {
      expect(await validator.isScanner(promoter.address)).to.equal(true);
      expect(await validator.scanStart()).to.equal(cfg.dates.doorsOpenTime);
      expect(await validator.scanEnd()).to.equal(cfg.dates.showEndTime);
    });

    it("lets either party manage scanners, through the show or directly", async function () {
      await expect(show.connect(artist).addScanner(scanner.address))
        .to.emit(validator, "ScannerAdded").withArgs(scanner.address);
      expect(await validator.isScanner(scanner.address)).to.equal(true);

      await show.connect(promoter).removeScanner(scanner.address);
      expect(await validator.isScanner(scanner.address)).to.equal(false);

      await validator.connect(artist).addScanner(scanner.address);
      expect(await validator.isScanner(scanner.address)).to.equal(true);

      await expect(validator.connect(stranger).addScanner(stranger.address))
        .to.be.revertedWithCustomError(validator, "NotAdmin");
      await expect(show.connect(stranger).addScanner(stranger.address))
        .to.be.revertedWithCustomError(show, "NotAParty");
    });

    it("only authenticates before doors open", async function () {
      await expect(validator.connect(promoter).scanTicket(1, ZERO_BYTES32))
        .to.emit(validator, "TicketAuthenticated");
      expect(await ticket.isScanned(1)).to.equal(false);
    });

    it("grants entry once inside the window and counts repeat scans", async function () {
      await time.increaseTo(cfg.dates.doorsOpenTime);

      expect(await validator.connect(promoter).scanTicket.staticCall(1, ZERO_BYTES32)).to.equal(true);
      await expect(validator.connect(promoter).scanTicket(1, ZERO_BYTES32))
        .to.emit(ticket, "TicketScanned")
        .and.to.emit(validator, "ScanAttempt");
      expect(await ticket.isScanned(1)).to.equal(true);

      expect(await validator.connect(promoter).scanTicket.staticCall(1, ZERO_BYTES32)).to.equal(false);
      await expect(validator.connect(promoter).scanTicket(1, ZERO_BYTES32))
        .to.emit(ticket, "TicketRescanned").withArgs(1, ZERO_BYTES32, 1);
      expect((await ticket.ticketData(1)).rescanCount).to.equal(1);
    });

    it("returns false for an unknown ticket and does not revert", async function () {
      await time.increaseTo(cfg.dates.doorsOpenTime);
      expect(await validator.connect(promoter).scanTicket.staticCall(99, ZERO_BYTES32)).to.equal(false);
      await expect(validator.connect(promoter).scanTicket(99, ZERO_BYTES32))
        .to.emit(validator, "ScanAttempt");
    });

    it("rejects non-scanners, paused scanning and scans after the window", async function () {
      await time.increaseTo(cfg.dates.doorsOpenTime);
      await expect(validator.connect(stranger).scanTicket(1, ZERO_BYTES32))
        .to.be.revertedWithCustomError(validator, "NotScanner");

      await show.connect(promoter).pauseScanning(true);
      await expect(validator.connect(promoter).scanTicket(1, ZERO_BYTES32))
        .to.be.revertedWithCustomError(validator, "ScanningPaused");
      await show.connect(promoter).pauseScanning(false);

      await time.increaseTo(cfg.dates.showEndTime + 1);
      await expect(validator.connect(promoter).scanTicket(1, ZERO_BYTES32))
        .to.be.revertedWithCustomError(validator, "ScanWindowClosed");
    });

    it("enforces gates when they are enabled", async function () {
      const gateA = ethers.id("gate-a");
      await validator.connect(promoter).setGate(gateA, true);
      await validator.connect(promoter).setGatesEnabled(true);
      await time.increaseTo(cfg.dates.doorsOpenTime);

      await expect(validator.connect(promoter).scanTicket(1, ethers.id("gate-b")))
        .to.be.revertedWithCustomError(validator, "InvalidGate");
      await validator.connect(promoter).scanTicket(1, gateA);
      expect(await ticket.isScanned(1)).to.equal(true);
    });

    it("lets a party move the scan window", async function () {
      await validator.connect(artist).setScanWindow(t0 + ONE_DAY, t0 + 2 * ONE_DAY);
      expect(await validator.scanStart()).to.equal(t0 + ONE_DAY);
      await expect(validator.connect(artist).setScanWindow(10, 10))
        .to.be.revertedWithCustomError(validator, "InvalidScanWindow");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("EventEscrow — funding and payouts", function () {
    it("stores the rules it was created with", async function () {
      const funding = await escrow.getFundingMilestones();
      expect(funding[0].minFunded).to.equal(USDC(1_000));
      const rules = await escrow.getPayoutRules();
      expect(rules[0].to).to.equal(artist.address);
      expect(rules[0].isGuarantee).to.equal(true);
      expect(rules[0].executed).to.equal(false);
      const sweep = await escrow.getSweepRule();
      expect(sweep.recipients).to.deep.equal([promoter.address, artist.address]);
      expect(await escrow.getCancelRules()).to.have.lengthOf(2);
      expect(await escrow.partyA()).to.equal(promoter.address);
      expect(await escrow.treasury()).to.equal(treasury.address);
    });

    it("cannot be initialized twice, and only the factory links tickets", async function () {
      await expect(escrowImpl.setTicketContract(stranger.address))
        .to.be.revertedWithCustomError(escrowImpl, "NotFactory");
      await expect(escrow.connect(promoter).setTicketContract(stranger.address))
        .to.be.revertedWithCustomError(escrow, "NotFactory");
      await expect(escrow.connect(stranger).creditTicketSale(1, 0))
        .to.be.revertedWithCustomError(escrow, "NotTicketContract");
    });

    it("rejects invalid rule sets at creation", async function () {
      const bad = (overrides, id) => ({ ...showConfig(promoter, artist, t0, overrides), showId: ethers.id(id) });
      const end = cfg.dates.showEndTime;

      await expect(factory.connect(promoter).createShow(bad({
        sweep: { recipients: [promoter.address], bps: [9_000], notBefore: end },
      }, "s1"))).to.be.revertedWithCustomError(escrowImpl, "InvalidSweepRule");

      await expect(factory.connect(promoter).createShow(bad({
        cancelRules: [{ notAfter: t0 + ONE_DAY, payBpsToPartyA: 10_000, payBpsToPartyB: 0, treasuryBps: 0 }],
      }, "c1"))).to.be.revertedWithCustomError(escrowImpl, "InvalidCancelRules");

      await expect(factory.connect(promoter).createShow(bad({
        cancelRules: [{ notAfter: MAX_UINT64, payBpsToPartyA: 5_000, payBpsToPartyB: 0, treasuryBps: 0 }],
      }, "c2"))).to.be.revertedWithCustomError(escrowImpl, "InvalidCancelRules");

      await expect(factory.connect(promoter).createShow(bad({
        payoutRules: [
          { to: artist.address, kind: PayoutKind.PercentageOfCurrentBalance, value: 10_001, notBefore: 0, isGuarantee: false },
        ],
      }, "p1"))).to.be.revertedWithCustomError(escrowImpl, "InvalidPayoutRule");

      await expect(factory.connect(promoter).createShow(bad({
        payoutRules: [
          { to: artist.address, kind: PayoutKind.FixedAmount, value: 1, notBefore: 100, isGuarantee: false },
          { to: artist.address, kind: PayoutKind.FixedAmount, value: 1, notBefore: 50, isGuarantee: false },
        ],
      }, "p2"))).to.be.revertedWithCustomError(escrowImpl, "RulesNotSorted");

      await expect(factory.connect(promoter).createShow(
        { ...bad({}, "r1"), defaultCancelRefundBps: 10_001 }
      )).to.be.revertedWithCustomError(escrowImpl, "InvalidBps");
    });

    it("accepts deposits only once the show is signed", async function () {
      await fund(promoter, USDC(1_000), escrow.target);
      await expect(escrow.connect(promoter).deposit(USDC(1_000)))
        .to.be.revertedWithCustomError(escrow, "NotFinalized");

      await signBoth();
      await expect(escrow.connect(promoter).deposit(0)).to.be.revertedWithCustomError(escrow, "ZeroAmount");
      await expect(escrow.connect(promoter).deposit(USDC(1_000)))
        .to.emit(escrow, "Deposited").withArgs(promoter.address, USDC(1_000));
      expect(await escrow.escrowBalance()).to.equal(USDC(1_000));
      expect(await escrow.totalFunded()).to.equal(USDC(1_000));
    });

    it("pays a fixed rule when due, and skips it without failing when short", async function () {
      await signBoth();
      await fund(promoter, USDC(1_000), escrow.target);
      await escrow.connect(promoter).deposit(USDC(300));

      // Not due yet: nothing happens.
      await escrow.connect(stranger).executeAvailablePayouts();
      expect(await usdc.balanceOf(artist.address)).to.equal(0);

      // Due but short: skipped.
      await time.increaseTo(t0 + 15 * ONE_DAY);
      await expect(escrow.connect(stranger).executeAvailablePayouts())
        .to.emit(escrow, "PayoutSkipped").withArgs(0, USDC(500), USDC(300));
      expect((await escrow.getPayoutRules())[0].executed).to.equal(false);

      // Topped up: paid once.
      await escrow.connect(promoter).deposit(USDC(700));
      await expect(escrow.connect(stranger).executeAvailablePayouts())
        .to.emit(escrow, "PayoutExecuted").withArgs(0, artist.address, USDC(500));
      expect(await usdc.balanceOf(artist.address)).to.equal(USDC(500));

      await escrow.connect(stranger).executeAvailablePayouts();
      expect(await usdc.balanceOf(artist.address)).to.equal(USDC(500));
    });

    it("pays a percentage rule from what is distributable, never from XAO's held fee", async function () {
      const pctCfg = showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("pct") },
        payoutRules: [
          { to: artist.address, kind: PayoutKind.PercentageOfCurrentBalance, value: 5_000, notBefore: 0, isGuarantee: false },
        ],
      });
      const b = await createShow(factory, promoter, pctCfg);
      await b.show.connect(promoter).signTerms();
      await b.show.connect(artist).signTerms();
      await usdc.mint(fan1.address, TICKET_PRICE);
      await usdc.connect(fan1).approve(b.ticket.target, TICKET_PRICE);
      await b.ticket.connect(fan1).buyTicket(0);

      await b.escrow.connect(stranger).executeAvailablePayouts();
      // distributable = 49 − 1 held fee = 48; half of it is paid.
      expect(await usdc.balanceOf(artist.address)).to.equal(USDC(24));
      expect(await b.escrow.protocolFeeAccrued()).to.equal(XAO_FEE);
      expect(await b.escrow.distributable()).to.equal(USDC(24));
    });

    it("does not use up a percentage rule while the escrow is empty", async function () {
      const pctCfg = showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("pct-empty") },
        payoutRules: [
          { to: artist.address, kind: PayoutKind.PercentageOfCurrentBalance, value: 5_000, notBefore: 0, isGuarantee: false },
        ],
      });
      const b = await createShow(factory, promoter, pctCfg);
      await b.show.connect(promoter).signTerms();
      await b.show.connect(artist).signTerms();

      await expect(b.escrow.connect(stranger).executeAvailablePayouts())
        .to.emit(b.escrow, "PayoutSkipped").withArgs(0, 0, 0);
      expect((await b.escrow.getPayoutRules())[0].executed).to.equal(false);
    });

    it("pays the payouts that are due before the final sweep, so the sweep cannot skip them", async function () {
      // Everything left after the sweep goes to the promoter. If the sweep ran
      // first it would take the artist's guarantee too.
      const skip = showConfig(promoter, artist, t0, {
        funding: [], anchors: { termsHash: ethers.id("skip-test") },
        sweep: { recipients: [promoter.address], bps: [10_000], notBefore: cfg.dates.showEndTime },
      });
      const b = await createShow(factory, promoter, skip);
      await b.show.connect(promoter).signTerms();
      await b.show.connect(artist).signTerms();
      await usdc.mint(promoter.address, USDC(1_000));
      await usdc.connect(promoter).approve(b.escrow.target, USDC(1_000));
      await b.escrow.connect(promoter).deposit(USDC(1_000));

      await time.increaseTo(cfg.dates.showEndTime);
      await b.escrow.connect(stranger).executeFinalSweep();   // nobody paid out first

      expect(await usdc.balanceOf(artist.address)).to.equal(USDC(500));      // the guarantee
      expect(await usdc.balanceOf(promoter.address)).to.equal(USDC(500));    // what was left
      expect(await usdc.balanceOf(b.escrow.target)).to.equal(0);
    });

    it("rejects a final payout due before the show ends or before a scheduled payout", async function () {
      const end = cfg.dates.showEndTime;
      const bad = (overrides, id) => ({ ...showConfig(promoter, artist, t0, overrides), showId: ethers.id(id) });

      await expect(factory.connect(promoter).createShow(bad({
        sweep: { recipients: [promoter.address], bps: [10_000], notBefore: end - 1 },
      }, "early-sweep"))).to.be.revertedWithCustomError(escrowImpl, "SweepBeforeShowEnd");

      await expect(factory.connect(promoter).createShow(bad({
        payoutRules: [{ to: artist.address, kind: PayoutKind.FixedAmount, value: 1, notBefore: end + 1, isGuarantee: false }],
      }, "late-payout"))).to.be.revertedWithCustomError(escrowImpl, "SweepBeforePayouts");
    });

    it("does not pay out on an unsigned show", async function () {
      await expect(escrow.connect(stranger).executeAvailablePayouts())
        .to.be.revertedWithCustomError(escrow, "NotFinalized");
      await time.increaseTo(cfg.dates.showEndTime);
      await expect(escrow.connect(stranger).executeFinalSweep())
        .to.be.revertedWithCustomError(escrow, "NotFinalized");
    });

    it("final sweep pays XAO its fee, splits the rest and completes the show", async function () {
      await signBoth();
      await fund(promoter, USDC(1_000), escrow.target);
      await escrow.connect(promoter).deposit(USDC(1_000));
      await buy(fan1);
      await buy(fan2);

      await expect(escrow.connect(stranger).executeFinalSweep())
        .to.be.revertedWithCustomError(escrow, "SweepNotDue");

      await time.increaseTo(cfg.dates.showEndTime);
      await escrow.connect(stranger).executeAvailablePayouts(); // artist's 500 guarantee
      await expect(escrow.connect(stranger).executeFinalSweep())
        .to.emit(escrow, "ProtocolFeePaid").withArgs(USDC(2))
        .and.to.emit(escrow, "EscrowCompleted")
        .and.to.emit(show, "ShowCompleted");

      // In: 1000 deposit + 2 × 49 = 1098. Out: 500 guarantee, 2 fee, 596 swept 40/60.
      expect(await usdc.balanceOf(treasury.address)).to.equal(USDC(2) + USDC(2));  // 2 × $1 + 2 × 2%
      expect(await usdc.balanceOf(promoter.address)).to.equal(USDC("238.4"));
      expect(await usdc.balanceOf(artist.address)).to.equal(USDC(500) + USDC("357.6"));
      expect(await usdc.balanceOf(escrow.target)).to.equal(0);

      expect(await escrow.status()).to.equal(EscrowStatus.Completed);
      expect(await escrow.sweepExecuted()).to.equal(true);
      expect(await show.status()).to.equal(ShowStatus.Completed);

      await expect(escrow.connect(stranger).executeFinalSweep())
        .to.be.revertedWithCustomError(escrow, "NotActive");
    });

    it("splits funds that arrive after completion, such as resale royalties", async function () {
      await signBoth();
      await time.increaseTo(cfg.dates.showEndTime);
      await escrow.connect(stranger).executeFinalSweep();
      await expect(escrow.connect(stranger).distributeLateFunds())
        .to.be.revertedWithCustomError(escrow, "NothingToDistribute");

      await usdc.mint(escrow.target, USDC(10));
      await escrow.connect(stranger).distributeLateFunds();
      expect(await usdc.balanceOf(promoter.address)).to.equal(USDC(4));
      expect(await usdc.balanceOf(artist.address)).to.equal(USDC(6));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("EventEscrow — cancellation and refunds", function () {
    beforeEach(async function () {
      await signBoth();
      await fund(promoter, USDC(1_000), escrow.target);
      await escrow.connect(promoter).deposit(USDC(1_000));
      await buy(fan1);
      await buy(fan2);
      await buy(fan3);
    });

    it("lets either party cancel, which starts refunding and cancels the show", async function () {
      await expect(escrow.connect(stranger).cancel()).to.be.revertedWithCustomError(escrow, "NotAParty");

      await expect(escrow.connect(artist).cancel())
        .to.emit(escrow, "RefundingStarted").withArgs(0, 10_000, 3)
        .and.to.emit(show, "ShowCancelled");

      expect(await escrow.status()).to.equal(EscrowStatus.Refunding);
      expect(await show.status()).to.equal(ShowStatus.Cancelled);
      expect(await escrow.refundCursor()).to.equal(1);
      expect(await escrow.maxRefundTokenId()).to.equal(3);

      await expect(escrow.connect(promoter).cancel()).to.be.revertedWithCustomError(escrow, "NotActive");
    });

    it("refunds every buyer everything except the $1, and burns the tickets", async function () {
      await escrow.connect(promoter).cancel();

      await expect(escrow.connect(stranger).continueRefunds(10))
        .to.emit(escrow, "RefundProcessed").withArgs(1, fan1.address, ESCROWED)
        .and.to.emit(ticket, "TicketRefunded").withArgs(1, fan1.address);

      for (const fan of [fan1, fan2, fan3]) {
        expect(await usdc.balanceOf(fan.address)).to.equal(ESCROWED);  // $50 − $1
      }
      for (const id of [1, 2, 3]) {
        expect(await ticket.exists(id)).to.equal(false);
        expect(await ticket.isRefunded(id)).to.equal(true);
        expect(await escrow.refunded(id)).to.equal(true);
      }
      expect(await ticket.balanceOf(fan1.address, 1)).to.equal(0);
      expect(await escrow.refundedCount()).to.equal(3);
      // XAO's held 2% went back to the buyers; only the $1s stay with the treasury.
      expect(await escrow.protocolFeeAccrued()).to.equal(0);
      expect(await usdc.balanceOf(treasury.address)).to.equal(USDC(3));
    });

    it("processes refunds in bounded batches that anyone can continue", async function () {
      await escrow.connect(promoter).cancel();
      await expect(escrow.connect(stranger).continueRefunds(0))
        .to.be.revertedWithCustomError(escrow, "InvalidBatchSize");
      await expect(escrow.connect(stranger).continueRefunds(201))
        .to.be.revertedWithCustomError(escrow, "InvalidBatchSize");

      await expect(escrow.connect(stranger).continueRefunds(2))
        .to.emit(escrow, "RefundProgress").withArgs(3, 2);
      expect(await usdc.balanceOf(fan3.address)).to.equal(0);
      await expect(escrow.connect(stranger).finalizeCancellationPayout())
        .to.be.revertedWithCustomError(escrow, "RefundsNotFinished");

      await escrow.connect(fan3).continueRefunds(2);
      expect(await usdc.balanceOf(fan3.address)).to.equal(ESCROWED);
      expect(await escrow.refundCursor()).to.equal(4);
    });

    it("refunds whoever holds the ticket now", async function () {
      await ticket.connect(promoter).setMarketplaceApproval(marketplace.address, true);
      await ticket.connect(fan1).setApprovalForAll(marketplace.address, true);
      await ticket.connect(marketplace).safeTransferFrom(fan1.address, stranger.address, 1, 1, "0x");

      await escrow.connect(promoter).cancel();
      await escrow.connect(stranger).continueRefunds(10);
      expect(await usdc.balanceOf(stranger.address)).to.equal(ESCROWED);
      expect(await usdc.balanceOf(fan1.address)).to.equal(0);
    });

    it("splits what is left by the cancel rule in force when it was cancelled", async function () {
      // Cancelled inside the first window: everything left goes back to partyA.
      await escrow.connect(promoter).cancel();
      await escrow.connect(stranger).continueRefunds(10);
      await expect(escrow.connect(stranger).finalizeCancellationPayout())
        .to.emit(escrow, "CancellationFinalized").withArgs(0, USDC(1_000), 0, 0);

      expect(await usdc.balanceOf(promoter.address)).to.equal(USDC(1_000));
      expect(await usdc.balanceOf(artist.address)).to.equal(0);
      expect(await usdc.balanceOf(escrow.target)).to.equal(0);
      expect(await escrow.status()).to.equal(EscrowStatus.Completed);
      expect(await show.status()).to.equal(ShowStatus.Cancelled);
    });

    it("uses the later cancel rule for a late cancellation", async function () {
      await time.increaseTo(t0 + 25 * ONE_DAY);
      await escrow.connect(artist).cancel();
      await escrow.connect(stranger).continueRefunds(10);
      // The artist's 500 guarantee was never executed, so 1000 remains: 50/40/10.
      await expect(escrow.connect(stranger).finalizeCancellationPayout())
        .to.emit(escrow, "CancellationFinalized").withArgs(1, USDC(500), USDC(400), USDC(100));
      expect(await usdc.balanceOf(artist.address)).to.equal(USDC(400));
      expect(await usdc.balanceOf(treasury.address)).to.equal(USDC(3) + USDC(100));
    });

    it("stops ticket sales, deposits-as-usual payouts and the sweep once cancelled", async function () {
      await escrow.connect(promoter).cancel();
      await fund(stranger, TICKET_PRICE, ticket.target);
      await expect(ticket.connect(stranger).buyTicket(0)).to.be.revertedWithCustomError(escrow, "NotActive");
      await expect(escrow.connect(stranger).executeAvailablePayouts())
        .to.be.revertedWithCustomError(escrow, "NotActive");
      await expect(escrow.connect(promoter).raiseDispute())
        .to.be.revertedWithCustomError(escrow, "NotActive");
    });

    it("cannot be cancelled by a party once the show has ended", async function () {
      await time.increaseTo(cfg.dates.showEndTime);
      await expect(escrow.connect(promoter).cancel())
        .to.be.revertedWithCustomError(escrow, "ShowAlreadyEnded");
    });

    it("stops and waits for a top-up when the escrow cannot cover a refund", async function () {
      // The artist's guarantee is paid out, then the promoter's deposit is not
      // enough to make every buyer whole after a late cancellation.
      const drainCfg = showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("drain") },
        funding: [],
        payoutRules: [
          { to: artist.address, kind: PayoutKind.PercentageOfCurrentBalance, value: 10_000, notBefore: 0, isGuarantee: false },
        ],
      });
      const b = await createShow(factory, promoter, drainCfg);
      await b.show.connect(promoter).signTerms();
      await b.show.connect(artist).signTerms();
      await usdc.mint(fan1.address, TICKET_PRICE);
      await usdc.connect(fan1).approve(b.ticket.target, TICKET_PRICE);
      await b.ticket.connect(fan1).buyTicket(0);
      await b.escrow.connect(stranger).executeAvailablePayouts();   // pays out the 48

      await b.escrow.connect(promoter).cancel();
      await expect(b.escrow.connect(stranger).continueRefunds(10))
        .to.be.revertedWithCustomError(b.escrow, "InsufficientFundsForRefund");

      await usdc.mint(promoter.address, USDC(48));
      await usdc.connect(promoter).approve(b.escrow.target, USDC(48));
      await b.escrow.connect(promoter).deposit(USDC(48));
      const before = await usdc.balanceOf(fan1.address);
      await b.escrow.connect(stranger).continueRefunds(10);
      expect((await usdc.balanceOf(fan1.address)) - before).to.equal(ESCROWED);
    });

    it("applies a partial refund rate and keeps XAO's fee on the part not refunded", async function () {
      const halfCfg = showConfig(promoter, artist, t0, {
        anchors: { termsHash: ethers.id("half") },
        funding: [],
        defaultCancelRefundBps: 5_000,
      });
      const b = await createShow(factory, promoter, halfCfg);
      await b.show.connect(promoter).signTerms();
      await b.show.connect(artist).signTerms();
      await usdc.mint(stranger.address, TICKET_PRICE);
      await usdc.connect(stranger).approve(b.ticket.target, TICKET_PRICE);
      await b.ticket.connect(stranger).buyTicket(0);

      const treasuryBefore = await usdc.balanceOf(treasury.address);
      await b.escrow.connect(promoter).cancel();
      await b.escrow.connect(stranger).continueRefunds(10);
      expect(await usdc.balanceOf(stranger.address)).to.equal(USDC("24.5"));
      expect(await b.escrow.protocolFeeAccrued()).to.equal(USDC("0.5"));

      await b.escrow.connect(stranger).finalizeCancellationPayout();
      expect((await usdc.balanceOf(treasury.address)) - treasuryBefore).to.equal(USDC("0.5"));
      expect(await usdc.balanceOf(b.escrow.target)).to.equal(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("EventEscrow — missed funding", function () {
    it("lets anyone cancel after a funding deadline passes unmet", async function () {
      await signBoth();
      await expect(escrow.connect(stranger).cancelForMissedFunding(0))
        .to.be.revertedWithCustomError(escrow, "MilestoneNotMissed");

      await time.increaseTo(t0 + 10 * ONE_DAY + 1);
      await expect(escrow.connect(stranger).cancelForMissedFunding(0))
        .to.emit(escrow, "RefundingStarted").withArgs(1, 10_000, 0);
      expect(await show.status()).to.equal(ShowStatus.Cancelled);
    });

    it("does not count a milestone as missed once it was funded, even after payouts", async function () {
      await signBoth();
      await fund(promoter, USDC(1_000), escrow.target);
      await escrow.connect(promoter).deposit(USDC(1_000));

      await time.increaseTo(t0 + 15 * ONE_DAY);
      await escrow.connect(stranger).executeAvailablePayouts();   // balance drops to 500
      expect(await escrow.escrowBalance()).to.equal(USDC(500));

      await expect(escrow.connect(stranger).cancelForMissedFunding(0))
        .to.be.revertedWithCustomError(escrow, "MilestoneNotMissed");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("EventEscrow — disputes", function () {
    beforeEach(async function () {
      await signBoth();
      await fund(promoter, USDC(2_000), escrow.target);
      await escrow.connect(promoter).deposit(USDC(1_000));
      await buy(fan1);
    });

    it("freezes deposits, payouts, cancellation, sales and the sweep", async function () {
      await expect(escrow.connect(stranger).raiseDispute()).to.be.revertedWithCustomError(escrow, "NotAParty");

      await expect(escrow.connect(artist).raiseDispute())
        .to.emit(escrow, "DisputeRaised")
        .and.to.emit(show, "DisputeOpened");
      expect(await show.isFrozen()).to.equal(true);
      expect(await show.status()).to.equal(ShowStatus.InDispute);

      await expect(escrow.connect(promoter).deposit(USDC(1))).to.be.revertedWithCustomError(escrow, "Frozen");
      await expect(escrow.connect(stranger).executeAvailablePayouts())
        .to.be.revertedWithCustomError(escrow, "Frozen");
      await expect(escrow.connect(promoter).cancel()).to.be.revertedWithCustomError(escrow, "Frozen");
      await expect(escrow.connect(promoter).raiseDispute()).to.be.revertedWithCustomError(escrow, "Frozen");

      await fund(fan2, TICKET_PRICE, ticket.target);
      await expect(ticket.connect(fan2).buyTicket(0)).to.be.revertedWithCustomError(escrow, "Frozen");

      await time.increaseTo(cfg.dates.showEndTime);
      await expect(escrow.connect(stranger).executeFinalSweep())
        .to.be.revertedWithCustomError(escrow, "Frozen");
    });

    it("resumes as before when both parties vote to resume", async function () {
      await escrow.connect(artist).raiseDispute();
      await escrow.connect(artist).resolveDispute(Resolution.Resume);
      expect(await show.isFrozen()).to.equal(true);

      await expect(escrow.connect(promoter).resolveDispute(Resolution.Resume))
        .to.emit(escrow, "DisputeSettled")
        .and.to.emit(show, "DisputeResolved");
      expect(await show.isFrozen()).to.equal(false);
      expect(await show.status()).to.equal(ShowStatus.Signed);
      expect(await escrow.status()).to.equal(EscrowStatus.Active);

      await escrow.connect(promoter).deposit(USDC(1));
    });

    it("stays frozen while the parties disagree, and a party can change its vote", async function () {
      await escrow.connect(artist).raiseDispute();
      await escrow.connect(artist).resolveDispute(Resolution.ReleaseToPartyB);
      await escrow.connect(promoter).resolveDispute(Resolution.ReleaseToPartyA);
      expect(await show.isFrozen()).to.equal(true);

      await expect(escrow.connect(promoter).resolveDispute(Resolution.None))
        .to.be.revertedWithCustomError(escrow, "InvalidResolution");
      await expect(escrow.connect(stranger).resolveDispute(Resolution.Resume))
        .to.be.revertedWithCustomError(escrow, "NotAParty");

      await escrow.connect(promoter).resolveDispute(Resolution.ReleaseToPartyB);
      expect(await show.isFrozen()).to.equal(false);
    });

    it("releases the escrow to the agreed party, after XAO's fee, and completes", async function () {
      await escrow.connect(artist).raiseDispute();
      await escrow.connect(artist).resolveDispute(Resolution.ReleaseToPartyB);
      await escrow.connect(promoter).resolveDispute(Resolution.ReleaseToPartyB);

      // 1000 deposit + 49 ticket − 1 fee = 1048 to the artist.
      expect(await usdc.balanceOf(artist.address)).to.equal(USDC(1_048));
      expect(await usdc.balanceOf(treasury.address)).to.equal(GAS_FEE + XAO_FEE);
      expect(await escrow.status()).to.equal(EscrowStatus.Completed);
      expect(await show.status()).to.equal(ShowStatus.Completed);
    });

    it("ends a dispute nobody settled after 30 days, with no breach", async function () {
      const DAY = 24 * 60 * 60;
      await escrow.connect(artist).raiseDispute();
      await escrow.connect(artist).resolveDispute(Resolution.ReleaseToPartyB);   // only one side votes
      const opened = await escrow.disputeOpenedAt();
      expect(await escrow.disputeDeadline()).to.equal(opened + BigInt(30 * DAY));
      expect(await escrow.DISPUTE_TIMEOUT()).to.equal(30 * DAY);

      await expect(escrow.connect(stranger).finalizeDisputeTimeout())
        .to.be.revertedWithCustomError(escrow, "DisputeNotExpired");
      await time.increaseTo(Number(opened) + 30 * DAY - 10);
      await expect(escrow.connect(stranger).finalizeDisputeTimeout())
        .to.be.revertedWithCustomError(escrow, "DisputeNotExpired");

      await time.increaseTo(Number(opened) + 30 * DAY);
      const balance = await escrow.escrowBalance();
      await expect(escrow.connect(stranger).finalizeDisputeTimeout())
        .to.emit(escrow, "DisputeTimedOut")
        .and.to.emit(show, "DisputeResolved");

      // No breach: nothing was paid out, the freeze is lifted and the escrow carries on.
      expect(await escrow.escrowBalance()).to.equal(balance);
      expect(await show.isFrozen()).to.equal(false);
      expect(await show.status()).to.equal(ShowStatus.Signed);
      expect(await escrow.status()).to.equal(EscrowStatus.Active);
      expect(await escrow.disputeDeadline()).to.equal(0);
      await escrow.connect(promoter).deposit(USDC(1));
      await buy(fan2);
    });

    it("cannot be finalized without a dispute, or twice", async function () {
      await expect(escrow.connect(stranger).finalizeDisputeTimeout())
        .to.be.revertedWithCustomError(escrow, "NotFrozen");

      await escrow.connect(artist).raiseDispute();
      await time.increase(30 * 24 * 60 * 60);
      await escrow.connect(stranger).finalizeDisputeTimeout();
      await expect(escrow.connect(stranger).finalizeDisputeTimeout())
        .to.be.revertedWithCustomError(escrow, "NotFrozen");
    });

    it("lets a party settle by agreement before the timeout instead", async function () {
      await escrow.connect(artist).raiseDispute();
      await escrow.connect(artist).resolveDispute(Resolution.Resume);
      await escrow.connect(promoter).resolveDispute(Resolution.Resume);
      expect(await escrow.disputeDeadline()).to.equal(0);
      await time.increase(31 * 24 * 60 * 60);
      await expect(escrow.connect(stranger).finalizeDisputeTimeout())
        .to.be.revertedWithCustomError(escrow, "NotFrozen");
    });

    it("lets the final sweep run once a freeze that outlasted the show times out", async function () {
      await time.increaseTo(cfg.dates.showEndTime - 1_000);
      await escrow.connect(promoter).raiseDispute();
      await time.increaseTo(cfg.dates.showEndTime + 1);
      await expect(escrow.connect(stranger).executeFinalSweep())
        .to.be.revertedWithCustomError(escrow, "Frozen");

      await time.increase(30 * 24 * 60 * 60);
      await escrow.connect(stranger).finalizeDisputeTimeout();
      await escrow.connect(stranger).executeFinalSweep();
      expect(await escrow.status()).to.equal(EscrowStatus.Completed);
      expect(await show.status()).to.equal(ShowStatus.Completed);
    });

    it("can be raised up to the show's end time and not after, even before the payout is closed", async function () {
      await time.increaseTo(cfg.dates.showEndTime - 5);
      await escrow.connect(promoter).raiseDispute();
      expect(await show.isFrozen()).to.equal(true);
      await escrow.connect(promoter).resolveDispute(Resolution.Resume);
      await escrow.connect(artist).resolveDispute(Resolution.Resume);

      await time.increaseTo(cfg.dates.showEndTime + 1);
      expect(await escrow.status()).to.equal(EscrowStatus.Active);   // nobody has closed it
      await expect(escrow.connect(promoter).raiseDispute())
        .to.be.revertedWithCustomError(escrow, "DisputeWindowClosed");
      await expect(escrow.connect(artist).raiseDispute())
        .to.be.revertedWithCustomError(escrow, "DisputeWindowClosed");
    });

    it("keeps an open dispute running past the end time until it is settled or times out", async function () {
      await time.increaseTo(cfg.dates.showEndTime - 5);
      await escrow.connect(promoter).raiseDispute();
      await time.increaseTo(cfg.dates.showEndTime + 1);
      expect(await show.isFrozen()).to.equal(true);

      await escrow.connect(promoter).resolveDispute(Resolution.Resume);
      await escrow.connect(artist).resolveDispute(Resolution.Resume);
      expect(await show.isFrozen()).to.equal(false);
      await escrow.connect(stranger).executeFinalSweep();
      expect(await escrow.status()).to.equal(EscrowStatus.Completed);
    });

    it("cannot be raised once the contract is closed", async function () {
      await time.increaseTo(cfg.dates.showEndTime);
      await escrow.connect(stranger).executeFinalSweep();
      await expect(escrow.connect(promoter).raiseDispute())
        .to.be.revertedWithCustomError(escrow, "NotActive");
    });

    it("has nothing to resolve when there is no dispute", async function () {
      await expect(escrow.connect(promoter).resolveDispute(Resolution.Resume))
        .to.be.revertedWithCustomError(escrow, "NotFrozen");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("EventEscrow — payments the token refuses", function () {
    it("parks a blocked recipient's refund and carries on with everyone else", async function () {
      const sys = await deploySystem("MockBlockableERC20");
      const c = showConfig(promoter, artist, t0, { funding: [] });
      const b = await createShow(sys.factory, promoter, c);
      await b.show.connect(promoter).signTerms();
      await b.show.connect(artist).signTerms();

      for (const fan of [fan1, fan2]) {
        await sys.usdc.mint(fan.address, TICKET_PRICE);
        await sys.usdc.connect(fan).approve(b.ticket.target, TICKET_PRICE);
        await b.ticket.connect(fan).buyTicket(0);
      }

      await sys.usdc.setBlocked(fan1.address, true);
      await b.escrow.connect(promoter).cancel();
      await expect(b.escrow.connect(stranger).continueRefunds(10))
        .to.emit(b.escrow, "PaymentHeld").withArgs(fan1.address, ESCROWED);

      expect(await sys.usdc.balanceOf(fan2.address)).to.equal(ESCROWED);
      expect(await b.escrow.unclaimed(fan1.address)).to.equal(ESCROWED);
      expect(await b.escrow.unclaimedTotal()).to.equal(ESCROWED);

      // The held refund is not swept away with the remainder.
      await b.escrow.connect(stranger).finalizeCancellationPayout();
      expect(await sys.usdc.balanceOf(b.escrow.target)).to.equal(ESCROWED);

      await expect(b.escrow.connect(fan1).claim()).to.be.revertedWithCustomError(b.escrow, "TransferFailed");
      await sys.usdc.setBlocked(fan1.address, false);
      await expect(b.escrow.connect(fan1).claim())
        .to.emit(b.escrow, "Claimed").withArgs(fan1.address, ESCROWED);
      expect(await sys.usdc.balanceOf(fan1.address)).to.equal(ESCROWED);
      await expect(b.escrow.connect(fan1).claim()).to.be.revertedWithCustomError(b.escrow, "NothingToClaim");
    });
  });
});
