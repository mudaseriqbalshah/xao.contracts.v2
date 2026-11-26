// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "../interfaces/IGraphParties.sol";
import "../interfaces/IGraphAuthorizer.sol";
import "../interfaces/IGraphRegistry.sol";
import "./TourParticipationAgreement.sol";

/// @dev What the shell asks a settlement escrow before it points to it.
interface ISettlementModuleShell {
    function tourShell() external view returns (address);
    /// @notice True when every show of the tour is settled and everyone has been paid.
    function canClose() external view returns (bool);
    /// @notice True when every show of the tour is settled, or was cancelled or expired.
    function allShowsDone() external view returns (bool);
}

/// @dev What the shell asks the tour coverage ledger.
interface ICoverageModuleShell {
    function tourShell() external view returns (address);
    function reconcileCoverage() external returns (bool cleared);
    function launchReady() external view returns (bool);
    function coverageGap() external view returns (uint256);
    function seal() external;
}

/// @title TourShell — single-party root container for a tour (Phase 2A)
/// @notice Anchors tour identity and metadata, manages operators, creates
///         Tour Participation Agreements and starts the linking of shows under
///         them. It holds no funds and is not arbitrable.
/// @dev Deployed as a minimal-proxy clone by TourFactory and set up via initialize().
contract TourShell is IGraphParties, IGraphAuthorizer {

    error AlreadyInitialized();
    error ZeroAddress();
    error NotOwner();
    error NotOwnerOrOperator();
    error UnknownTPA();
    error TPAAlreadyRegistered();
    error TPANotForThisShell();
    error SettlementModuleAlreadySet();
    error SettlementModuleNotForThisShell();
    error CoverageModuleAlreadySet();
    error CoverageModuleNotForThisShell();
    error WrongState();
    error NoSettlementModule();
    error CoverageNotReady();
    error CannotClose();
    error TourWindingDown();
    error ShowsNotSettled();
    error AlreadyMarked();

    struct TPAConfig {
        address partyB;          // participant
        bytes32 termsHash;
        string  termsCID;
        uint64  effectiveFrom;
        uint64  effectiveTo;     // 0 = perpetual
        bytes32 metaHash;        // optional
        string  metaCID;         // optional
        address supersedes;      // optional
    }

    address public owner;              // EOA or mini-org address
    address public graphRegistry;
    address public tpaImplementation;

    bytes32 public tourId;
    string  public tourMetaCID;        // IPFS: name/artwork/route notes/etc.
    bytes32 public tourMetaHash;

    mapping(address => bool) public isOperator;
    mapping(address => bool) public isTPA;
    address[] private _tpas;

    /// @notice The tour's settlement escrow, where band pay is worked out and paid. The shell
    ///         only points to it: it still never holds or distributes money.
    address public tourSettlementEscrow;

    /// @notice The tour coverage ledger: whether its tour-wide guarantees are really covered.
    address public tourCoverage;

    /// @notice Where the tour is. Booking: shows and agreements are being set up. Touring: it has
    ///         started (every tour-wide guarantee was covered). Settling: no new commitments, money
    ///         is being shared out. Closed: everything is settled and paid. "Ready" is not a state:
    ///         it is `launchReady()`, whether the coverage is in place.
    enum TourState { Booking, Touring, Settling, Closed }
    TourState public state;

    /// @notice How long a tour with something still unpaid stays open after its last show is settled.
    uint256 public constant CLOSE_GRACE = 30 days;
    /// @notice When the last show was settled (as marked while Settling); 0 until then.
    uint64 public finalSettledAt;
    /// @notice Set when the tour was closed with something still unpaid: the parties settle it outside.
    bool public closedUnpaid;

    bool public initialized;

    event TourShellInitialized(address indexed owner, bytes32 indexed tourId, string tourMetaCID, bytes32 tourMetaHash);
    event OperatorSet(address indexed op, bool allowed);
    event TPACreated(address indexed tpa, address indexed partyB, bytes32 termsHash, string termsCID);
    event TPARegistered(address indexed tpa);
    event SettlementModuleRegistered(address indexed module);
    event CoverageModuleRegistered(address indexed module);
    event TourStarted(address indexed by);
    event SettlementBegun(address indexed by);
    event TourClosed(address indexed by);
    event FinalSettlement(uint64 at);
    event TourClosedUnpaid();
    event ShowLinkedPending(address indexed tpa, address indexed eventRoot, bytes32 edgeIdParents, bytes32 edgeIdChildOf);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOwnerOrOperator() {
        if (msg.sender != owner && !isOperator[msg.sender]) revert NotOwnerOrOperator();
        _;
    }

    /// @dev Locks the implementation; only clones can be initialized.
    constructor() {
        initialized = true;
    }

    function initialize(
        address _owner,
        address _graphRegistry,
        address _tpaImplementation,
        bytes32 _tourId,
        string calldata _tourMetaCID,
        bytes32 _tourMetaHash
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (_owner == address(0) || _graphRegistry == address(0) || _tpaImplementation == address(0)) {
            revert ZeroAddress();
        }

        initialized       = true;
        owner             = _owner;
        graphRegistry     = _graphRegistry;
        tpaImplementation = _tpaImplementation;
        tourMetaCID       = _tourMetaCID;
        tourMetaHash      = _tourMetaHash;
        tourId = _tourId != bytes32(0)
            ? _tourId
            : keccak256(abi.encodePacked(_owner, _tourMetaHash, _tourMetaCID));

        emit TourShellInitialized(_owner, tourId, _tourMetaCID, _tourMetaHash);
    }

    // ─── OPERATORS ────────────────────────────────────────────────────────

    function setOperator(address op, bool allowed) external onlyOwner {
        isOperator[op] = allowed;
        emit OperatorSet(op, allowed);
    }

    // ─── TOUR PARTICIPATION AGREEMENTS ────────────────────────────────────

    /// @notice Deploy a TPA between the tour owner and `cfg.partyB`, and
    ///         register the shell ↔ TPA edges (Active immediately).
    function createTourParticipationAgreement(TPAConfig calldata cfg)
        external
        onlyOwnerOrOperator
        returns (address tpa)
    {
        _requireNotWindingDown();
        tpa = Clones.clone(tpaImplementation);
        TourParticipationAgreement(tpa).initialize(
            owner,
            cfg.partyB,
            address(this),
            graphRegistry,
            cfg.effectiveFrom,
            cfg.effectiveTo,
            cfg.termsHash,
            cfg.termsCID,
            cfg.metaHash,
            cfg.metaCID,
            cfg.supersedes
        );

        _addTPA(tpa, bytes32(0), "");
        emit TPACreated(tpa, cfg.partyB, cfg.termsHash, cfg.termsCID);
    }

    /// @notice Register a TPA that already exists and names this shell.
    function registerTourParticipationAgreement(address tpa, bytes32 metaHash, string calldata metaCID)
        external
        onlyOwnerOrOperator
    {
        _requireNotWindingDown();
        if (TourParticipationAgreement(tpa).tourShell() != address(this)) revert TPANotForThisShell();
        _addTPA(tpa, metaHash, metaCID);
        emit TPARegistered(tpa);
    }

    // ─── LINKING SHOWS (SHELL-DOWN ONLY) ──────────────────────────────────

    /// @notice Start linking a show under one of this tour's TPAs. Both edges
    ///         stay Pending in GraphRegistry until the show's parties confirm.
    /// @dev A tour owner who is also a party on the show does not need this:
    ///      registering the same two edges directly in GraphRegistry makes them
    ///      Active at once, because the owner is authorized on both endpoints.
    ///      The participant cannot do the same; each TPA names the tour owner
    ///      as its only registrar.
    function linkShowToTPA(
        address tpa,
        address eventRoot,
        bytes32 metaHash,
        string calldata metaCID
    )
        external
        onlyOwnerOrOperator
        returns (bytes32 edgeIdParents, bytes32 edgeIdChildOf)
    {
        _requireNotWindingDown();
        if (!isTPA[tpa]) revert UnknownTPA();
        if (eventRoot == address(0)) revert ZeroAddress();

        IGraphRegistry registry = IGraphRegistry(graphRegistry);
        edgeIdParents = registry.registerEdge(tpa, eventRoot, IGraphRegistry.EdgeType.PARENTS, metaHash, metaCID);
        edgeIdChildOf = registry.registerEdge(eventRoot, tpa, IGraphRegistry.EdgeType.CHILD_OF, metaHash, metaCID);

        emit ShowLinkedPending(tpa, eventRoot, edgeIdParents, edgeIdChildOf);
    }

    /// @notice Point the tour at its settlement escrow. Once, by the owner; the escrow has to name this shell.
    function registerSettlementModule(address module) external onlyOwner {
        if (tourSettlementEscrow != address(0)) revert SettlementModuleAlreadySet();
        if (module == address(0)) revert ZeroAddress();
        if (ISettlementModuleShell(module).tourShell() != address(this)) revert SettlementModuleNotForThisShell();
        tourSettlementEscrow = module;
        emit SettlementModuleRegistered(module);
    }

    /// @notice Point the tour at its coverage ledger. Once, by the owner; the ledger has to name this shell.
    function registerCoverageModule(address module) external onlyOwner {
        if (tourCoverage != address(0)) revert CoverageModuleAlreadySet();
        if (module == address(0)) revert ZeroAddress();
        if (ICoverageModuleShell(module).tourShell() != address(this)) revert CoverageModuleNotForThisShell();
        tourCoverage = module;
        emit CoverageModuleRegistered(module);
    }

    // ─── LIFECYCLE ────────────────────────────────────────────────────────

    /// @notice Whether the tour-wide guarantees are covered (as of the last reconcile).
    ///         A tour with no coverage ledger has no tour-wide guarantee to cover.
    function launchReady() public view returns (bool) {
        address c = tourCoverage;
        return c == address(0) || (ICoverageModuleShell(c).launchReady() && ICoverageModuleShell(c).coverageGap() == 0);
    }

    /// @notice Start the tour. The coverage is worked out again first, and the tour starts only if
    ///         every tour-wide guarantee is fully covered right now. Starting closes the coverage
    ///         ledger to new guarantees, so none can be added after the tour has begun.
    function requestTourStart() external onlyOwnerOrOperator {
        if (state != TourState.Booking) revert WrongState();
        if (tourSettlementEscrow == address(0)) revert NoSettlementModule();
        address c = tourCoverage;
        if (c != address(0)) {
            ICoverageModuleShell(c).reconcileCoverage();
            if (!launchReady()) revert CoverageNotReady();
            ICoverageModuleShell(c).seal();
        }
        state = TourState.Touring;
        emit TourStarted(msg.sender);
    }

    /// @notice No more new commitments: the tour is being settled.
    function beginSettlement() external onlyOwnerOrOperator {
        if (state != TourState.Touring) revert WrongState();
        state = TourState.Settling;
        emit SettlementBegun(msg.sender);
        if (ISettlementModuleShell(tourSettlementEscrow).allShowsDone()) _markFinalSettlement();
    }

    /// @notice Note that the last show has now been settled, which starts the 30 days. Anyone may.
    function markFinalSettlement() external {
        if (state != TourState.Settling) revert WrongState();
        if (finalSettledAt != 0) revert AlreadyMarked();
        if (!ISettlementModuleShell(tourSettlementEscrow).allShowsDone()) revert ShowsNotSettled();
        _markFinalSettlement();
    }

    /// @notice Close the tour. Once it is Settling anyone may: as soon as everything is settled
    ///         and paid, or 30 days after the last show was settled whatever is still unpaid.
    ///         The owner may also abandon a tour that never started and owes nothing.
    ///         Closing lets people who put cover into the coverage ledger take back what is left,
    ///         and stops the settlement escrow taking anything more from the tour obligor.
    function closeTour() external {
        address m = tourSettlementEscrow;
        if (state == TourState.Booking) {
            if (msg.sender != owner) revert NotOwner();
            if (m != address(0) && !ISettlementModuleShell(m).canClose()) revert CannotClose();
        } else if (state == TourState.Settling) {
            if (!ISettlementModuleShell(m).canClose()) {
                if (finalSettledAt == 0 || block.timestamp < finalSettledAt + CLOSE_GRACE) revert CannotClose();
                closedUnpaid = true;
                emit TourClosedUnpaid();
            }
        } else {
            revert WrongState();
        }
        state = TourState.Closed;
        emit TourClosed(msg.sender);
    }

    // ─── VIEWS ────────────────────────────────────────────────────────────

    function tpaCount() external view returns (uint256) {
        return _tpas.length;
    }

    function getTPAs() external view returns (address[] memory) {
        return _tpas;
    }

    // ─── GRAPH ────────────────────────────────────────────────────────────

    /// @notice Single-party node: the owner is partyA and there is no partyB.
    function partyA() external view override returns (address) {
        return owner;
    }

    function partyB() external pure override returns (address) {
        return address(0);
    }

    function isGraphOperator(address op) external view override returns (bool) {
        return isOperator[op];
    }

    // ─── INTERNAL ─────────────────────────────────────────────────────────

    function _markFinalSettlement() internal {
        finalSettledAt = uint64(block.timestamp);
        emit FinalSettlement(finalSettledAt);
    }

    function _requireNotWindingDown() internal view {
        if (state == TourState.Settling || state == TourState.Closed) revert TourWindingDown();
    }

    function _addTPA(address tpa, bytes32 metaHash, string memory metaCID) internal {
        if (isTPA[tpa]) revert TPAAlreadyRegistered();
        isTPA[tpa] = true;
        _tpas.push(tpa);

        IGraphRegistry registry = IGraphRegistry(graphRegistry);
        registry.registerEdge(address(this), tpa, IGraphRegistry.EdgeType.PARENTS, metaHash, metaCID);
        registry.registerEdge(tpa, address(this), IGraphRegistry.EdgeType.CHILD_OF, metaHash, metaCID);
    }
}
