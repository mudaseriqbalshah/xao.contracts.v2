// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IGraphParties.sol";

/// @title StandingAgreement — one contract for every long-lived agreement (Phase 2A)
/// @notice A relationship between one or two parties that outlasts any single
///         show: band membership, agent representation, employment, a venue and
///         promoter partnership, a sponsor master agreement or a crew deal.
///         Terms are anchored by hash/CID. It applies to shows and tours through
///         APPLIES_TO links in GraphRegistry, so the terms are never copied into
///         each instance, and it can carry a compensation schema that instances
///         may use. Nothing is edited in place: an amendment is a new agreement
///         that supersedes this one.
/// @dev Deployed as a minimal-proxy clone by StandingAgreementFactory and set up
///      via initialize(). It holds no funds.
contract StandingAgreement is IGraphParties {

    error AlreadyInitialized();
    error ZeroPartyA();
    error SamePartyOnBothSides();
    error ZeroTermsHash();
    error InvalidEffectiveWindow();
    error NotAParty();
    error NotDraft();
    error NotActive();
    error NotDraftOrActive();
    error AlreadySigned();
    error AlreadyVoted();
    error ZeroAddress();
    error NewAgreementDoesNotPointBack();
    error TooManySplits();
    error TooManyFlatPayments();
    error TooManyFlags();
    error EmptyStream();
    error DuplicateStream();
    error SplitsMustSumTo10000();
    error ZeroRecipient();
    error ZeroAmount();
    error ZeroFlag();

    enum AgreementKind { Generic, Membership, Representation, Employment, Partnership, Sponsorship, Crew }

    enum Status { Draft, Active, Terminated, Superseded }

    /// @notice The money category a split or flat payment applies to.
    enum Stream { Guarantee, TicketRevenue, MerchRevenue, BarRevenue, SponsorshipRevenue, Other }

    struct Split {
        address recipient;
        uint16  bps;            // sums to 10000 per stream
    }

    struct StreamConfig {
        Stream  stream;
        Split[] splits;
    }

    struct FlatPayment {
        address recipient;
        uint256 amount;         // in the token of the instance that uses it
        Stream  streamTag;
    }

    struct AgreementInit {
        address       partyA;
        address       partyB;   // optional; address(0) for a single-party policy
        AgreementKind kind;
        uint64        effectiveFrom;
        uint64        effectiveTo;   // 0 = perpetual
        bytes32       termsHash;
        string        termsCID;
        address       supersedes;    // prior agreement, if this is an amendment
        StreamConfig[] streams;      // compensation, optional
        FlatPayment[]  flatPayments; // optional
        bytes32[]      flags;        // optional generic toggles
    }

    uint256 public constant MAX_SPLITS_PER_STREAM = 20;
    uint256 public constant MAX_FLAT_PAYMENTS     = 50;
    uint256 public constant MAX_FLAGS             = 50;

    // ─── STATE ────────────────────────────────────────────────────────────
    address public override partyA;
    address public override partyB;

    AgreementKind public kind;
    uint64 public effectiveFrom;
    uint64 public effectiveTo;

    bytes32 public termsHash;
    string  public termsCID;

    Status  public status;
    address public supersedes;
    address public supersededBy;
    address public terminatedBy;

    mapping(address => bool)    public hasSigned;
    mapping(address => address) public supersedeVote;   // party => proposed replacement

    // Compensation schema — set once at initialization, never edited.
    mapping(Stream => Split[]) internal _streamSplits;
    mapping(Stream => bool)    public streamEnabled;
    FlatPayment[]              internal _flatPayments;
    mapping(bytes32 => bool)   public flags;
    bytes32[]                  internal _flagList;

    bool public initialized;

    // ─── EVENTS ───────────────────────────────────────────────────────────
    event AgreementInitialized(
        address indexed partyA,
        address indexed partyB,
        AgreementKind kind,
        bytes32 termsHash,
        string termsCID,
        address supersedes
    );
    event StreamSplitSet(Stream indexed stream, address indexed recipient, uint16 bps);
    event FlatPaymentSet(uint256 indexed index, address indexed recipient, uint256 amount, Stream streamTag);
    event FlagSet(bytes32 indexed flag);
    event Signed(address indexed by);
    event Activated();
    event Terminated(address indexed by, string reasonCID);
    event SupersedeRequested(address indexed by, address indexed newAgreement);
    event Superseded(address indexed newAgreement);

    modifier onlyParty() {
        if (msg.sender != partyA && (partyB == address(0) || msg.sender != partyB)) revert NotAParty();
        _;
    }

    /// @dev Locks the implementation; only clones can be initialized.
    constructor() {
        initialized = true;
    }

    function initialize(AgreementInit calldata init) external {
        if (initialized) revert AlreadyInitialized();
        if (init.partyA == address(0)) revert ZeroPartyA();
        if (init.partyB == init.partyA) revert SamePartyOnBothSides();
        if (init.termsHash == bytes32(0)) revert ZeroTermsHash();
        if (init.effectiveTo != 0 && init.effectiveTo <= init.effectiveFrom) revert InvalidEffectiveWindow();

        initialized   = true;
        partyA        = init.partyA;
        partyB        = init.partyB;
        kind          = init.kind;
        effectiveFrom = init.effectiveFrom;
        effectiveTo   = init.effectiveTo;
        termsHash     = init.termsHash;
        termsCID      = init.termsCID;
        supersedes    = init.supersedes;
        // status defaults to Draft

        _setCompensation(init.streams, init.flatPayments, init.flags);

        emit AgreementInitialized(
            init.partyA, init.partyB, init.kind, init.termsHash, init.termsCID, init.supersedes
        );
    }

    // ─── SIGNING & ACTIVATION ─────────────────────────────────────────────

    /// @notice Each party signs once. A single-party agreement is Active after
    ///         one signature; otherwise after both.
    function sign() external onlyParty {
        if (status != Status.Draft) revert NotDraft();
        if (hasSigned[msg.sender]) revert AlreadySigned();

        hasSigned[msg.sender] = true;
        emit Signed(msg.sender);

        if (hasSigned[partyA] && (partyB == address(0) || hasSigned[partyB])) {
            status = Status.Active;
            emit Activated();
        }
    }

    // ─── TERMINATION ──────────────────────────────────────────────────────

    /// @notice Either party can end the agreement on its own. Instances it
    ///         already applied to are unaffected; their own terms still stand.
    function terminate(string calldata reasonCID) external onlyParty {
        if (status != Status.Draft && status != Status.Active) revert NotDraftOrActive();

        status = Status.Terminated;
        terminatedBy = msg.sender;
        emit Terminated(msg.sender, reasonCID);
    }

    // ─── SUPERSEDING (AMENDMENTS) ─────────────────────────────────────────

    /// @notice Every party names the same replacement, which must point back
    ///         here through its `supersedes` field. Nothing is edited in place.
    function supersedeWith(address newAgreement) external onlyParty {
        if (status != Status.Active) revert NotActive();
        if (newAgreement == address(0)) revert ZeroAddress();
        if (StandingAgreement(newAgreement).supersedes() != address(this)) {
            revert NewAgreementDoesNotPointBack();
        }

        supersedeVote[msg.sender] = newAgreement;
        emit SupersedeRequested(msg.sender, newAgreement);

        bool aAgrees = supersedeVote[partyA] == newAgreement;
        bool bAgrees = partyB == address(0) || supersedeVote[partyB] == newAgreement;
        if (aAgrees && bAgrees) {
            supersededBy = newAgreement;
            status = Status.Superseded;
            emit Superseded(newAgreement);
        }
    }

    // ─── VIEWS ────────────────────────────────────────────────────────────

    /// @notice True while the agreement is Active and inside its effective window.
    function isInEffect() external view returns (bool) {
        return status == Status.Active
            && block.timestamp >= effectiveFrom
            && (effectiveTo == 0 || block.timestamp <= effectiveTo);
    }

    function getStreamSplits(Stream stream) external view returns (Split[] memory) {
        return _streamSplits[stream];
    }

    function getFlatPayments() external view returns (FlatPayment[] memory) {
        return _flatPayments;
    }

    function getFlags() external view returns (bytes32[] memory) {
        return _flagList;
    }

    // ─── INTERNAL ─────────────────────────────────────────────────────────

    function _setCompensation(
        StreamConfig[] calldata streams,
        FlatPayment[] calldata flatPayments,
        bytes32[] calldata flagIds
    ) internal {
        for (uint256 i = 0; i < streams.length; i++) {
            Stream stream = streams[i].stream;
            Split[] calldata splits = streams[i].splits;

            if (streamEnabled[stream]) revert DuplicateStream();
            if (splits.length == 0) revert EmptyStream();
            if (splits.length > MAX_SPLITS_PER_STREAM) revert TooManySplits();

            uint256 sum;
            for (uint256 j = 0; j < splits.length; j++) {
                if (splits[j].recipient == address(0)) revert ZeroRecipient();
                sum += splits[j].bps;
                _streamSplits[stream].push(splits[j]);
                emit StreamSplitSet(stream, splits[j].recipient, splits[j].bps);
            }
            if (sum != 10_000) revert SplitsMustSumTo10000();
            streamEnabled[stream] = true;
        }

        if (flatPayments.length > MAX_FLAT_PAYMENTS) revert TooManyFlatPayments();
        for (uint256 i = 0; i < flatPayments.length; i++) {
            if (flatPayments[i].recipient == address(0)) revert ZeroRecipient();
            if (flatPayments[i].amount == 0) revert ZeroAmount();
            _flatPayments.push(flatPayments[i]);
            emit FlatPaymentSet(i, flatPayments[i].recipient, flatPayments[i].amount, flatPayments[i].streamTag);
        }

        if (flagIds.length > MAX_FLAGS) revert TooManyFlags();
        for (uint256 i = 0; i < flagIds.length; i++) {
            if (flagIds[i] == bytes32(0)) revert ZeroFlag();
            if (flags[flagIds[i]]) continue;
            flags[flagIds[i]] = true;
            _flagList.push(flagIds[i]);
            emit FlagSet(flagIds[i]);
        }
    }
}
