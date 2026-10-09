// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IGraphParties.sol";
import "../interfaces/IGraphAuthorizer.sol";

/// @title TourParticipationAgreement (TPA) — one tour ↔ one participant (Phase 2A)
/// @notice A 1–2 party agreement that attaches a band, sponsor or crew
///         coordinator to a tour. Terms are anchored by hash/CID. It holds no
///         funds; money stays in show-level escrow. If a participant drops out,
///         only this contract changes state.
/// @dev Deployed as a minimal-proxy clone by TourShell and set up via initialize().
contract TourParticipationAgreement is IGraphParties, IGraphAuthorizer {

    error AlreadyInitialized();
    error ZeroParty();
    error ZeroTermsHash();
    error InvalidEffectiveWindow();
    error NotAParty();
    error NotDraft();
    error NotActive();
    error NotDraftOrActive();
    error AlreadySigned();
    error AlreadyVoted();
    error ZeroAddress();
    error NewTPADoesNotPointBack();

    enum Status { Draft, Active, Terminated, Superseded }

    address public override partyA;   // tour manager (the shell owner)
    address public override partyB;   // participant
    address public tourShell;
    address public graphRegistry;

    uint64 public effectiveFrom;
    uint64 public effectiveTo;        // 0 = perpetual

    bytes32 public termsHash;
    string  public termsCID;

    bytes32 public metaHash;          // optional structured metadata anchor
    string  public metaCID;           // optional

    Status public status;

    mapping(address => bool) public hasSigned;
    mapping(address => bool) public hasVotedTerminate;
    mapping(address => address) public supersedeVote;   // party => proposed new TPA

    address public supersedes;
    address public supersededBy;

    bool public initialized;

    event TPAInitialized(
        address indexed partyA,
        address indexed partyB,
        address indexed tourShell,
        bytes32 termsHash,
        string termsCID
    );
    event Signed(address indexed by);
    event Activated();
    event TerminationRequested(address indexed by, string reasonCID);
    event Terminated(string reasonCID);
    event SupersedeRequested(address indexed by, address indexed newTPA);
    event Superseded(address indexed newTPA);

    modifier onlyParty() {
        if (msg.sender != partyA && msg.sender != partyB) revert NotAParty();
        _;
    }

    /// @dev Locks the implementation; only clones can be initialized.
    constructor() {
        initialized = true;
    }

    function initialize(
        address _partyA,
        address _partyB,
        address _tourShell,
        address _graphRegistry,
        uint64 _effectiveFrom,
        uint64 _effectiveTo,
        bytes32 _termsHash,
        string calldata _termsCID,
        bytes32 _metaHash,
        string calldata _metaCID,
        address _supersedes
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (_partyA == address(0) || _partyB == address(0)) revert ZeroParty();
        if (_termsHash == bytes32(0)) revert ZeroTermsHash();
        if (_effectiveTo != 0 && _effectiveTo <= _effectiveFrom) revert InvalidEffectiveWindow();

        initialized   = true;
        partyA        = _partyA;
        partyB        = _partyB;
        tourShell     = _tourShell;
        graphRegistry = _graphRegistry;
        effectiveFrom = _effectiveFrom;
        effectiveTo   = _effectiveTo;
        termsHash     = _termsHash;
        termsCID      = _termsCID;
        metaHash      = _metaHash;
        metaCID       = _metaCID;
        supersedes    = _supersedes;
        // status defaults to Draft

        emit TPAInitialized(_partyA, _partyB, _tourShell, _termsHash, _termsCID);
    }

    // ─── SIGNING ──────────────────────────────────────────────────────────

    /// @notice Each party signs once; the agreement becomes Active when both have.
    function sign() external onlyParty {
        if (status != Status.Draft) revert NotDraft();
        if (hasSigned[msg.sender]) revert AlreadySigned();

        hasSigned[msg.sender] = true;
        emit Signed(msg.sender);

        if (hasSigned[partyA] && hasSigned[partyB]) {
            status = Status.Active;
            emit Activated();
        }
    }

    // ─── TERMINATION ──────────────────────────────────────────────────────

    /// @notice Both parties must call this for the agreement to end.
    function terminate(string calldata reasonCID) external onlyParty {
        if (status != Status.Draft && status != Status.Active) revert NotDraftOrActive();
        if (hasVotedTerminate[msg.sender]) revert AlreadyVoted();

        hasVotedTerminate[msg.sender] = true;
        emit TerminationRequested(msg.sender, reasonCID);

        if (hasVotedTerminate[partyA] && hasVotedTerminate[partyB]) {
            status = Status.Terminated;
            emit Terminated(reasonCID);
        }
    }

    // ─── SUPERSEDING (AMENDMENTS) ─────────────────────────────────────────

    /// @notice Both parties must name the same replacement, and the replacement
    ///         must point back here through its `supersedes` field.
    function supersedeWith(address newTPA) external onlyParty {
        if (status != Status.Active) revert NotActive();
        if (newTPA == address(0)) revert ZeroAddress();
        if (TourParticipationAgreement(newTPA).supersedes() != address(this)) {
            revert NewTPADoesNotPointBack();
        }

        supersedeVote[msg.sender] = newTPA;
        emit SupersedeRequested(msg.sender, newTPA);

        if (supersedeVote[partyA] == newTPA && supersedeVote[partyB] == newTPA) {
            supersededBy = newTPA;
            status = Status.Superseded;
            emit Superseded(newTPA);
        }
    }

    // ─── GRAPH ────────────────────────────────────────────────────────────

    /// @notice The tour shell registers this agreement's edges on its behalf.
    function isGraphOperator(address operator) external view override returns (bool) {
        return operator == tourShell;
    }
}
