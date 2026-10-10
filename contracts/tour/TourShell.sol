// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "../interfaces/IGraphParties.sol";
import "../interfaces/IGraphAuthorizer.sol";
import "../interfaces/IGraphRegistry.sol";
import "./TourParticipationAgreement.sol";

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

    bool public initialized;

    event TourShellInitialized(address indexed owner, bytes32 indexed tourId, string tourMetaCID, bytes32 tourMetaHash);
    event OperatorSet(address indexed op, bool allowed);
    event TPACreated(address indexed tpa, address indexed partyB, bytes32 termsHash, string termsCID);
    event TPARegistered(address indexed tpa);
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
        if (!isTPA[tpa]) revert UnknownTPA();
        if (eventRoot == address(0)) revert ZeroAddress();

        IGraphRegistry registry = IGraphRegistry(graphRegistry);
        edgeIdParents = registry.registerEdge(tpa, eventRoot, IGraphRegistry.EdgeType.PARENTS, metaHash, metaCID);
        edgeIdChildOf = registry.registerEdge(eventRoot, tpa, IGraphRegistry.EdgeType.CHILD_OF, metaHash, metaCID);

        emit ShowLinkedPending(tpa, eventRoot, edgeIdParents, edgeIdChildOf);
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

    function _addTPA(address tpa, bytes32 metaHash, string memory metaCID) internal {
        if (isTPA[tpa]) revert TPAAlreadyRegistered();
        isTPA[tpa] = true;
        _tpas.push(tpa);

        IGraphRegistry registry = IGraphRegistry(graphRegistry);
        registry.registerEdge(address(this), tpa, IGraphRegistry.EdgeType.PARENTS, metaHash, metaCID);
        registry.registerEdge(tpa, address(this), IGraphRegistry.EdgeType.CHILD_OF, metaHash, metaCID);
    }
}
