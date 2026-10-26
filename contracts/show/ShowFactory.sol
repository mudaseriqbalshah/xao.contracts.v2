// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "../interfaces/IGraphRegistry.sol";
import "./ShowInstance.sol";
import "./EventEscrow.sol";
import "./XAOTicketV2.sol";
import "./EntryValidator.sol";

/// @title ShowFactory — deploy and wire one show bundle per show (Phase 2A)
/// @notice One call turns the create-show form into a ShowInstance, its
///         EventEscrow and, when tickets are enabled, a ticket collection and
///         an EntryValidator. Every module is a CREATE2 minimal-proxy clone, so
///         addresses are predictable and the factory stays small.
///         The factory never holds funds.
contract ShowFactory is Ownable {

    error ZeroAddress();
    error FactoryPaused();
    error ArbitrationNotAvailable();

    struct ShowConfig {
        bytes32 showId;                               // optional client-chosen id; see deriveShowId

        ShowInstance.PartyConfig      partyA;
        ShowInstance.PartyConfig      partyB;         // wallet may be address(0)
        ShowInstance.DatesConfig      dates;
        ShowInstance.LocationConfig   location;
        ShowInstance.TicketTerms      tickets;
        ShowInstance.FinancialConfig  financials;
        ShowInstance.PromoConfig      promo;
        ShowInstance.AnchorConfig     anchors;
        ShowInstance.ReputationPolicy reputation;
        bool arbitrationEnabled;

        // Ticket tiers, used only when tickets are enabled
        XAOTicketV2.TierInput[] tiers;

        // Escrow rules, enforced on-chain
        EventEscrow.FundingMilestone[] funding;
        EventEscrow.PayoutRuleInput[]  payoutRules;
        EventEscrow.SweepRule          sweep;
        EventEscrow.CancelRule[]       cancelRules;
        uint16 defaultCancelRefundBps;                // 10000 = full refund
    }

    struct ShowBundle {
        address showInstance;
        address escrow;
        address ticketContract;     // 0 if tickets are disabled
        address entryValidator;     // 0 if tickets are disabled
    }

    // ─── PROTOCOL REFERENCES (owner-managed) ──────────────────────────────
    address public graphRegistry;
    address public arbitrationAgent;   // zero until the ArbitrationAgent exists
    address public payoutToken;        // USDC
    address public treasury;
    bool    public paused;

    address public showInstanceImpl;
    address public eventEscrowImpl;
    address public ticketImpl;
    address public validatorImpl;

    // ─── REGISTRY OF SHOWS ────────────────────────────────────────────────
    address[] public allShows;
    mapping(address => address[]) public userShows;
    mapping(bytes32 => address)   public showById;

    /// @notice True for every EventEscrow this factory deployed. Escrows use it
    ///         to check that an opener's agreement they are asked to link is real.
    mapping(address => bool) public isEscrow;

    event ShowCreated(
        bytes32 indexed showId,
        address indexed showInstance,
        address escrow,
        address indexed creator,
        address partyA,
        address partyB,
        address ticketContract,
        address entryValidator,
        bool ticketsEnabled,
        bool arbitrationEnabled,
        string showMetaCID
    );
    event ImplementationsSet(address showInstance, address eventEscrow, address ticket, address validator);
    event GraphRegistrySet(address graphRegistry);
    event ArbitrationAgentSet(address arbitrationAgent);
    event TreasurySet(address treasury);
    event PausedSet(bool paused);

    constructor(
        address _owner,
        address _graphRegistry,
        address _payoutToken,
        address _treasury,
        address _showInstanceImpl,
        address _eventEscrowImpl,
        address _ticketImpl,
        address _validatorImpl
    ) Ownable(_owner) {
        if (_graphRegistry == address(0) || _payoutToken == address(0) || _treasury == address(0)) {
            revert ZeroAddress();
        }
        graphRegistry = _graphRegistry;
        payoutToken   = _payoutToken;
        treasury      = _treasury;
        _setImplementations(_showInstanceImpl, _eventEscrowImpl, _ticketImpl, _validatorImpl);
    }

    // ─── CREATE ───────────────────────────────────────────────────────────

    /// @notice Deploy and wire a show bundle. The show starts as an Offer.
    function createShow(ShowConfig calldata cfg) external returns (ShowBundle memory bundle) {
        if (paused) revert FactoryPaused();
        if (cfg.arbitrationEnabled && arbitrationAgent == address(0)) revert ArbitrationNotAvailable();

        bytes32 showId = _showIdFor(msg.sender, cfg);

        // 1. ShowInstance
        bundle.showInstance = Clones.cloneDeterministic(showInstanceImpl, _salt("SHOW", showId));
        ShowInstance(bundle.showInstance).initializeOffer(
            ShowInstance.ShowInit({
                showId:             showId,
                creator:            msg.sender,
                partyA:             cfg.partyA,
                partyB:             cfg.partyB,
                dates:              cfg.dates,
                location:           cfg.location,
                tickets:            cfg.tickets,
                financials:         cfg.financials,
                promo:              cfg.promo,
                anchors:            cfg.anchors,
                reputation:         cfg.reputation,
                arbitrationEnabled: cfg.arbitrationEnabled,
                arbitrationAgent:   cfg.arbitrationEnabled ? arbitrationAgent : address(0)
            })
        );

        // 2. EventEscrow
        bundle.escrow = Clones.cloneDeterministic(eventEscrowImpl, _salt("ESCROW", showId));
        EventEscrow(bundle.escrow).initialize(
            EventEscrow.EscrowInit({
                showId:                 showId,
                show:                   bundle.showInstance,
                partyA:                 cfg.partyA.wallet,
                partyB:                 cfg.partyB.wallet,
                payoutToken:            payoutToken,
                treasury:               treasury,
                funding:                cfg.funding,
                payoutRules:            cfg.payoutRules,
                sweep:                  cfg.sweep,
                cancelRules:            cfg.cancelRules,
                defaultCancelRefundBps: cfg.defaultCancelRefundBps
            })
        );
        ShowInstance(bundle.showInstance).setEscrowModule(bundle.escrow);
        isEscrow[bundle.escrow] = true;

        // 3. Tickets + entry validator
        if (cfg.tickets.ticketsEnabled) {
            bundle.ticketContract = Clones.cloneDeterministic(ticketImpl, _salt("TICKET", showId));
            bundle.entryValidator = Clones.cloneDeterministic(validatorImpl, _salt("VALIDATOR", showId));

            XAOTicketV2(bundle.ticketContract).initialize(
                XAOTicketV2.TicketInit({
                    show:           bundle.showInstance,
                    escrow:         bundle.escrow,
                    entryValidator: bundle.entryValidator,
                    usdc:           payoutToken,
                    treasury:       treasury,
                    admin:          cfg.partyA.wallet,
                    eventName:      cfg.promo.eventName,
                    totalCapacity:  cfg.tickets.totalCapacity,
                    tiers:          cfg.tiers
                })
            );
            // Entry opens at doors and closes when the show ends; partyA can
            // scan from the start.
            EntryValidator(bundle.entryValidator).initialize(
                bundle.showInstance,
                bundle.ticketContract,
                cfg.dates.doorsOpenTime,
                cfg.dates.showEndTime,
                cfg.partyA.wallet
            );

            EventEscrow(bundle.escrow).setTicketContract(bundle.ticketContract);
            ShowInstance(bundle.showInstance).setTicketingModule(bundle.ticketContract, bundle.entryValidator);
        }

        // 4. Graph edges. Best-effort: a registry failure must not block show creation.
        _registerModule(bundle.showInstance, bundle.escrow);
        if (bundle.ticketContract != address(0)) {
            _registerModule(bundle.showInstance, bundle.ticketContract);
            _registerModule(bundle.showInstance, bundle.entryValidator);
        }

        // 5. Bookkeeping
        allShows.push(bundle.showInstance);
        showById[showId] = bundle.showInstance;
        userShows[cfg.partyA.wallet].push(bundle.showInstance);
        if (cfg.partyB.wallet != address(0) && cfg.partyB.wallet != cfg.partyA.wallet) {
            userShows[cfg.partyB.wallet].push(bundle.showInstance);
        }

        emit ShowCreated(
            showId,
            bundle.showInstance,
            bundle.escrow,
            msg.sender,
            cfg.partyA.wallet,
            cfg.partyB.wallet,
            bundle.ticketContract,
            bundle.entryValidator,
            cfg.tickets.ticketsEnabled,
            cfg.arbitrationEnabled,
            cfg.anchors.showMetaCID
        );
    }

    // ─── VIEWS ────────────────────────────────────────────────────────────

    function getShowCount() external view returns (uint256) {
        return allShows.length;
    }

    function getUserShows(address user) external view returns (address[] memory) {
        return userShows[user];
    }

    /// @notice Addresses a show id will deploy to, before it is created.
    function predictBundle(bytes32 showId) external view returns (ShowBundle memory bundle) {
        bundle.showInstance   = Clones.predictDeterministicAddress(showInstanceImpl, _salt("SHOW", showId));
        bundle.escrow         = Clones.predictDeterministicAddress(eventEscrowImpl, _salt("ESCROW", showId));
        bundle.ticketContract = Clones.predictDeterministicAddress(ticketImpl, _salt("TICKET", showId));
        bundle.entryValidator = Clones.predictDeterministicAddress(validatorImpl, _salt("VALIDATOR", showId));
    }

    /// @notice The show id `creator` would get for this config. It always
    ///         includes the creator, so nobody else can take an id first.
    function deriveShowId(address creator, ShowConfig calldata cfg) external pure returns (bytes32) {
        return _showIdFor(creator, cfg);
    }

    // ─── OWNER ────────────────────────────────────────────────────────────

    /// @notice New implementations apply to shows created afterwards; existing
    ///         shows are untouched.
    function setImplementations(
        address _showInstanceImpl,
        address _eventEscrowImpl,
        address _ticketImpl,
        address _validatorImpl
    ) external onlyOwner {
        _setImplementations(_showInstanceImpl, _eventEscrowImpl, _ticketImpl, _validatorImpl);
    }

    function setGraphRegistry(address _graphRegistry) external onlyOwner {
        if (_graphRegistry == address(0)) revert ZeroAddress();
        graphRegistry = _graphRegistry;
        emit GraphRegistrySet(_graphRegistry);
    }

    function setArbitrationAgent(address _arbitrationAgent) external onlyOwner {
        arbitrationAgent = _arbitrationAgent;
        emit ArbitrationAgentSet(_arbitrationAgent);
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
        emit TreasurySet(_treasury);
    }

    /// @notice Pausing stops new shows only; shows already created keep working.
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    // ─── INTERNAL ─────────────────────────────────────────────────────────

    function _setImplementations(
        address _showInstanceImpl,
        address _eventEscrowImpl,
        address _ticketImpl,
        address _validatorImpl
    ) internal {
        if (
            _showInstanceImpl == address(0) ||
            _eventEscrowImpl == address(0) ||
            _ticketImpl == address(0) ||
            _validatorImpl == address(0)
        ) revert ZeroAddress();

        showInstanceImpl = _showInstanceImpl;
        eventEscrowImpl  = _eventEscrowImpl;
        ticketImpl       = _ticketImpl;
        validatorImpl    = _validatorImpl;
        emit ImplementationsSet(_showInstanceImpl, _eventEscrowImpl, _ticketImpl, _validatorImpl);
    }

    function _showIdFor(address creator, ShowConfig calldata cfg) internal pure returns (bytes32) {
        if (cfg.showId != bytes32(0)) {
            return keccak256(abi.encodePacked(creator, cfg.showId));
        }
        return keccak256(
            abi.encodePacked(
                creator,
                cfg.partyA.wallet,
                cfg.partyB.wallet,
                cfg.dates.doorsOpenTime,
                cfg.dates.showStartTime,
                cfg.dates.showEndTime,
                cfg.anchors.legalTextHash,
                cfg.anchors.termsHash,
                cfg.anchors.showMetaHash
            )
        );
    }

    function _salt(string memory module, bytes32 showId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(module, showId));
    }

    function _registerModule(address showInstance, address module) internal {
        try IGraphRegistry(graphRegistry).registerEdge(
            showInstance,
            module,
            IGraphRegistry.EdgeType.HAS_MODULE,
            bytes32(0),
            ""
        ) {} catch {}
    }
}
