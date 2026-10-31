// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IGraphParties.sol";
import "../interfaces/IGraphAuthorizer.sol";
import "../interfaces/IShowBundle.sol";

/// @title ShowInstance — the canonical show node (Phase 2A)
/// @notice Holds a show's parties, terms and lifecycle, and points at its
///         modules (escrow, tickets, entry validator). It never holds funds
///         (EventEscrow does) and never mints tickets (the ticket module does).
///         Terms are fixed when the offer is created; a change of terms is a
///         new offer.
/// @dev Deployed as a minimal-proxy clone by ShowFactory and set up via
///      initializeOffer().
contract ShowInstance is IGraphParties, IGraphAuthorizer {

    error AlreadyInitialized();
    error NotFactory();
    error NotEscrow();
    error NotAParty();
    error ZeroPartyAddress();
    error ZeroAddress();
    error InvalidTimes();
    error ZeroLegalTextHash();
    error ZeroTermsHash();
    error GuaranteeUseFlatOrPctNotBoth();
    error ResaleSplitsMustSumTo10000();
    error ReputationAmountZero();
    error ArbitrationAgentMissing();
    error ModuleAlreadySet();
    error TicketModulesMustBeSetTogether();
    error NotOffer();
    error AlreadySigned();
    error NoEntryValidator();
    error MetaLocked();
    error NotExpirable();

    // ─── ENUMS ────────────────────────────────────────────────────────────
    enum PartyRole { PROMOTER, ARTIST, VENUE, BOOKING_AGENT, PRODUCTION, OTHER }

    enum ShowStatus { Offer, Signed, Active, InDispute, Completed, Cancelled, Expired }

    // ─── CONFIG STRUCTS ───────────────────────────────────────────────────
    struct PartyConfig {
        address   wallet;
        PartyRole role;
        string    xaoUsername;
    }

    struct DatesConfig {
        uint64 announcementDate;
        uint64 eventStartDate;
        uint64 eventEndDate;      // defaults to eventStartDate if 0
        uint64 loadInTime;
        uint64 doorsOpenTime;
        uint64 showStartTime;
        uint64 showEndTime;
        uint64 setTime;
        uint64 setLengthMinutes;
        uint64 ticketsSaleDate;
    }

    struct LocationConfig {
        string  venueName;
        string  venueAddress;
        uint256 radiusMiles;
        uint256 radiusDays;
    }

    struct TicketTerms {
        bool    ticketsEnabled;
        uint256 totalCapacity;
        uint256 salesTaxBPS;
        uint256 compTickets;
        // Default resale royalty split (BPS). All zero, or summing to 10000.
        uint256 resalePartyABPS;
        uint256 resalePartyBBPS;
        uint256 resaleResellerBPS;
    }

    struct FinancialConfig {
        uint256 guaranteeUSDC;    // flat guarantee (mutually exclusive with pct)
        uint256 guaranteePctBPS;  // % of ticket sales as guarantee
        uint256 backendBPS;       // partyB's % of what is left after the guarantees; must match its share of the escrow's sweep
        uint256 barSplitBPS;
        uint256 merchSplitBPS;
    }

    struct PromoConfig {
        string   eventName;
        string   flyerDNSLink;      // mutable IPNS/DNSLink reference
        bytes32  flyerCIDHash;      // immutable first-pin hash
        string   riderIPFSCID;
        string   ticketLegal;
        string[] genres;
    }

    struct AnchorConfig {
        bytes32 legalTextHash;
        string  legalTextCID;
        bytes32 termsHash;
        string  termsCID;
        bytes32 showMetaHash;
        string  showMetaCID;
    }

    struct ReputationPolicy {
        bool    ticketPurchaseRepEnabled;
        bool    attendanceRepEnabled;
        uint32  ticketPurchaseDomainId;
        uint32  attendanceDomainId;
        uint256 ticketPurchaseRepAmount;
        uint256 attendanceRepAmount;
    }

    struct ShowInit {
        bytes32          showId;
        address          creator;
        PartyConfig      partyA;
        PartyConfig      partyB;      // wallet may be address(0) for a single-party show
        DatesConfig      dates;
        LocationConfig   location;
        TicketTerms      tickets;
        FinancialConfig  financials;
        PromoConfig      promo;
        AnchorConfig     anchors;
        ReputationPolicy reputation;
        bool             arbitrationEnabled;
        address          arbitrationAgent;
    }

    // ─── IDENTITY ─────────────────────────────────────────────────────────
    bytes32 public showId;
    address public creator;
    address public factory;

    PartyConfig internal _partyA;
    PartyConfig internal _partyB;

    // ─── TERMS ────────────────────────────────────────────────────────────
    DatesConfig     public dates;
    LocationConfig  public location;
    TicketTerms     public ticketTerms;
    FinancialConfig public financials;

    string  public eventName;
    string  public flyerDNSLink;
    bytes32 public originalFlyerCIDHash;
    string  public riderIPFSCID;
    string  public ticketLegalLanguage;
    string[] internal genres;

    // Legal / terms anchors — immutable after creation
    bytes32 public legalTextHash;
    string  public legalTextCID;
    bytes32 public termsHash;
    string  public termsCID;

    // Promo metadata — editable by the parties until doors open
    bytes32 public showMetaHash;
    string  public showMetaCID;

    // ─── MODULES ──────────────────────────────────────────────────────────
    address public escrow;
    address public ticketContract;     // 0 if tickets are disabled
    address public entryValidator;     // 0 if tickets are disabled

    // ─── ARBITRATION ──────────────────────────────────────────────────────
    bool    public arbitrationEnabled;
    address public arbitrationAgent;
    bytes32 public activeCaseId;       // 0 when there is no open dispute

    // ─── REPUTATION POLICY (declared here, enforced by a router later) ────
    ReputationPolicy public reputationPolicy;

    // ─── SIGNING & STATUS ─────────────────────────────────────────────────
    mapping(address => bool) public hasSigned;
    bool       public anySigned;
    bool       public isFinalized;     // latched once every party has signed
    ShowStatus public status;
    ShowStatus internal _statusBeforeDispute;

    bool public initialized;

    // ─── EVENTS ───────────────────────────────────────────────────────────
    event ShowInitialized(bytes32 indexed showId, address indexed partyA, address indexed partyB);
    event ShowMetaUpdated(bytes32 metaHash, string metaCID);
    event FlyerDNSLinkUpdated(string link);
    event UsernameSet(address indexed party, string xaoUsername);

    event EscrowLinked(address escrow);
    event TicketingLinked(address ticketContract, address entryValidator);

    event TermsSigned(address indexed by);
    event ShowSigned(bytes32 termsHash);

    event DisputeOpened(bytes32 indexed caseId);
    event DisputeResolved(bytes32 indexed caseId);

    event ShowCompleted();
    event ShowCancelled();
    event ShowExpired();

    // ─── MODIFIERS ────────────────────────────────────────────────────────
    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert NotEscrow();
        _;
    }

    modifier onlyParty() {
        if (!isParty(msg.sender)) revert NotAParty();
        _;
    }

    /// @dev Locks the implementation; only clones can be initialized.
    constructor() {
        initialized = true;
    }

    // ─── INITIALIZATION ───────────────────────────────────────────────────

    /// @notice One-time setup by the factory. The show starts as an Offer.
    function initializeOffer(ShowInit calldata init) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        factory = msg.sender;

        if (init.partyA.wallet == address(0)) revert ZeroPartyAddress();
        if (init.anchors.legalTextHash == bytes32(0)) revert ZeroLegalTextHash();
        if (init.anchors.termsHash == bytes32(0)) revert ZeroTermsHash();
        if (
            init.dates.doorsOpenTime > init.dates.showStartTime ||
            init.dates.showStartTime >= init.dates.showEndTime
        ) revert InvalidTimes();
        if (init.financials.guaranteeUSDC > 0 && init.financials.guaranteePctBPS > 0) {
            revert GuaranteeUseFlatOrPctNotBoth();
        }
        uint256 resaleSum =
            init.tickets.resalePartyABPS + init.tickets.resalePartyBBPS + init.tickets.resaleResellerBPS;
        if (resaleSum != 0 && resaleSum != 10_000) revert ResaleSplitsMustSumTo10000();
        if (
            (init.reputation.ticketPurchaseRepEnabled && init.reputation.ticketPurchaseRepAmount == 0) ||
            (init.reputation.attendanceRepEnabled && init.reputation.attendanceRepAmount == 0)
        ) revert ReputationAmountZero();
        if (init.arbitrationEnabled && init.arbitrationAgent == address(0)) revert ArbitrationAgentMissing();

        showId  = init.showId;
        creator = init.creator;

        // A party's username is only taken from the config when that party is
        // the one creating the show; everyone else sets their own later.
        _partyA.wallet = init.partyA.wallet;
        _partyA.role   = init.partyA.role;
        if (init.creator == init.partyA.wallet) _partyA.xaoUsername = init.partyA.xaoUsername;
        _partyB.wallet = init.partyB.wallet;
        _partyB.role   = init.partyB.role;
        if (init.partyB.wallet != address(0) && init.creator == init.partyB.wallet) {
            _partyB.xaoUsername = init.partyB.xaoUsername;
        }

        dates = init.dates;
        if (dates.eventEndDate == 0) dates.eventEndDate = dates.eventStartDate;

        location.venueName    = init.location.venueName;
        location.venueAddress = init.location.venueAddress;
        location.radiusMiles  = init.location.radiusMiles;
        location.radiusDays   = init.location.radiusDays;

        ticketTerms = init.tickets;
        financials  = init.financials;

        eventName            = init.promo.eventName;
        flyerDNSLink         = init.promo.flyerDNSLink;
        originalFlyerCIDHash = init.promo.flyerCIDHash;
        riderIPFSCID         = init.promo.riderIPFSCID;
        ticketLegalLanguage  = init.promo.ticketLegal;
        for (uint256 i = 0; i < init.promo.genres.length; i++) {
            genres.push(init.promo.genres[i]);
        }

        legalTextHash = init.anchors.legalTextHash;
        legalTextCID  = init.anchors.legalTextCID;
        termsHash     = init.anchors.termsHash;
        termsCID      = init.anchors.termsCID;
        showMetaHash  = init.anchors.showMetaHash;
        showMetaCID   = init.anchors.showMetaCID;

        arbitrationEnabled = init.arbitrationEnabled;
        arbitrationAgent   = init.arbitrationAgent;
        reputationPolicy   = init.reputation;
        // status defaults to Offer

        emit ShowInitialized(init.showId, init.partyA.wallet, init.partyB.wallet);
    }

    // ─── MODULE WIRING (factory-only, once) ───────────────────────────────

    function setEscrowModule(address _escrow) external onlyFactory {
        if (escrow != address(0)) revert ModuleAlreadySet();
        if (_escrow == address(0)) revert ZeroAddress();
        escrow = _escrow;
        emit EscrowLinked(_escrow);
    }

    function setTicketingModule(address _ticketContract, address _entryValidator) external onlyFactory {
        if (ticketContract != address(0) || entryValidator != address(0)) revert ModuleAlreadySet();
        if (_ticketContract == address(0) || _entryValidator == address(0)) {
            revert TicketModulesMustBeSetTogether();
        }
        ticketContract = _ticketContract;
        entryValidator = _entryValidator;
        emit TicketingLinked(_ticketContract, _entryValidator);
    }

    // ─── SIGNING (Offer → Signed) ─────────────────────────────────────────

    /// @notice Sign the stored terms and legal text. The show is Signed once
    ///         every party has signed.
    function signTerms() external onlyParty {
        if (status != ShowStatus.Offer) revert NotOffer();
        if (hasSigned[msg.sender]) revert AlreadySigned();

        hasSigned[msg.sender] = true;
        anySigned = true;
        emit TermsSigned(msg.sender);

        address b = _partyB.wallet;
        if (hasSigned[_partyA.wallet] && (b == address(0) || hasSigned[b])) {
            isFinalized = true;
            status = ShowStatus.Signed;
            emit ShowSigned(termsHash);
        }
    }

    // ─── PARTY ACTIONS ────────────────────────────────────────────────────

    /// @notice Each party sets its own XAO username.
    function setUsername(string calldata xaoUsername) external onlyParty {
        if (msg.sender == _partyA.wallet) {
            _partyA.xaoUsername = xaoUsername;
        } else {
            _partyB.xaoUsername = xaoUsername;
        }
        emit UsernameSet(msg.sender, xaoUsername);
    }

    function setFlyerDNSLink(string calldata link) external onlyParty {
        flyerDNSLink = link;
        emit FlyerDNSLinkUpdated(link);
    }

    /// @notice Update promo metadata. Allowed until doors open; legal text and
    ///         terms can never change.
    function updateShowMeta(string calldata newMetaCID, bytes32 newMetaHash) external onlyParty {
        if (block.timestamp >= dates.doorsOpenTime) revert MetaLocked();
        showMetaCID  = newMetaCID;
        showMetaHash = newMetaHash;
        emit ShowMetaUpdated(newMetaHash, newMetaCID);
    }

    // ─── SCANNER MANAGEMENT (through the entry validator) ─────────────────

    function addScanner(address scanner) external onlyParty {
        if (entryValidator == address(0)) revert NoEntryValidator();
        IEntryValidatorLike(entryValidator).addScanner(scanner);
    }

    function removeScanner(address scanner) external onlyParty {
        if (entryValidator == address(0)) revert NoEntryValidator();
        IEntryValidatorLike(entryValidator).removeScanner(scanner);
    }

    function pauseScanning(bool paused) external onlyParty {
        if (entryValidator == address(0)) revert NoEntryValidator();
        IEntryValidatorLike(entryValidator).setPaused(paused);
    }

    // ─── ESCROW HOOKS ─────────────────────────────────────────────────────

    function onDisputeOpened(bytes32 caseId) external onlyEscrow {
        activeCaseId = caseId;
        _statusBeforeDispute = status;
        status = ShowStatus.InDispute;
        emit DisputeOpened(caseId);
    }

    function onDisputeResolved(bytes32 caseId) external onlyEscrow {
        activeCaseId = bytes32(0);
        status = _statusBeforeDispute;
        emit DisputeResolved(caseId);
    }

    function onCompleted() external onlyEscrow {
        status = ShowStatus.Completed;
        emit ShowCompleted();
    }

    function onCancelled() external onlyEscrow {
        status = ShowStatus.Cancelled;
        emit ShowCancelled();
    }

    /// @notice Anyone can mark a show Expired once its end time has passed and
    ///         it was never completed, cancelled or disputed.
    function markExpired() external {
        if (block.timestamp <= dates.showEndTime) revert NotExpirable();
        if (status != ShowStatus.Offer && status != ShowStatus.Signed && status != ShowStatus.Active) {
            revert NotExpirable();
        }
        status = ShowStatus.Expired;
        emit ShowExpired();
    }

    // ─── VIEWS ────────────────────────────────────────────────────────────

    function isParty(address account) public view returns (bool) {
        return account == _partyA.wallet || (_partyB.wallet != address(0) && account == _partyB.wallet);
    }

    function isFrozen() external view returns (bool) {
        return activeCaseId != bytes32(0);
    }

    function isExpired() external view returns (bool) {
        return block.timestamp > dates.showEndTime;
    }

    function partyAInfo() external view returns (PartyConfig memory) {
        return _partyA;
    }

    function partyBInfo() external view returns (PartyConfig memory) {
        return _partyB;
    }

    function getGenres() external view returns (string[] memory) {
        return genres;
    }

    function doorsOpenTime() external view returns (uint64) {
        return dates.doorsOpenTime;
    }

    function showStartTime() external view returns (uint64) {
        return dates.showStartTime;
    }

    function showEndTime() external view returns (uint64) {
        return dates.showEndTime;
    }

    function getReputationPolicy()
        external
        view
        returns (
            bool ticketPurchaseEnabled,
            uint32 ticketPurchaseDomain,
            uint256 ticketPurchaseAmount,
            bool attendanceEnabled,
            uint32 attendanceDomain,
            uint256 attendanceAmount
        )
    {
        ReputationPolicy storage p = reputationPolicy;
        return (
            p.ticketPurchaseRepEnabled,
            p.ticketPurchaseDomainId,
            p.ticketPurchaseRepAmount,
            p.attendanceRepEnabled,
            p.attendanceDomainId,
            p.attendanceRepAmount
        );
    }

    // ─── GRAPH ────────────────────────────────────────────────────────────

    function partyA() external view override returns (address) {
        return _partyA.wallet;
    }

    function partyB() external view override returns (address) {
        return _partyB.wallet;
    }

    /// @notice The factory registers this show's module edges on its behalf.
    function isGraphOperator(address operator) external view override returns (bool) {
        return operator == factory;
    }
}
