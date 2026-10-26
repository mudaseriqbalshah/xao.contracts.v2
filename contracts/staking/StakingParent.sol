// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IGraphParties.sol";
import "../interfaces/IGraphAuthorizer.sol";
import "../interfaces/IGraphRegistry.sol";

/// @title StakingParent — container node for staking-backed tours and shows (Phase 2A foundation)
/// @notice A project-level root, owned by a person or by an org, that tours and
///         shows can hang under. This is the foundation only: it holds no
///         tokens and takes no stakes. What it provides now is the owned
///         container, its operators and the graph-checked link to each child,
///         so that when staking is built (Phase 3) stake can be allocated only
///         to a child that is actually linked here, and existing tours and
///         shows can be attached without changing or redeploying them.
/// @dev Deployed as a minimal-proxy clone by StakingParentFactory and set up via
///      initialize().
contract StakingParent is IGraphParties, IGraphAuthorizer {

    error AlreadyInitialized();
    error ZeroAddress();
    error NotOwner();
    error NotManager();

    enum OwnerMode { Personal, Org }

    uint256 private constant MAX_SUPERSEDE_HOPS = 8;

    OwnerMode public ownerMode;
    address public owner;            // a person, or an org wallet in Org mode
    address public graphRegistry;

    bytes32 public metaHash;
    string  public metaCID;

    mapping(address => bool) public isOperator;
    /// @notice The edge registered for a child through this contract.
    mapping(address => bytes32) public childEdge;

    bool public initialized;

    event StakingParentInitialized(address indexed owner, OwnerMode ownerMode, address indexed graphRegistry);
    event OperatorSet(address indexed op, bool allowed);
    event ChildRegistered(address indexed child, IGraphRegistry.EdgeType edgeType, bytes32 edgeId);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Locks the implementation; only clones can be initialized.
    constructor() {
        initialized = true;
    }

    function initialize(
        address _owner,
        OwnerMode _ownerMode,
        address _graphRegistry,
        bytes32 _metaHash,
        string calldata _metaCID
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (_owner == address(0) || _graphRegistry == address(0)) revert ZeroAddress();

        initialized   = true;
        owner         = _owner;
        ownerMode     = _ownerMode;
        graphRegistry = _graphRegistry;
        metaHash      = _metaHash;
        metaCID       = _metaCID;

        emit StakingParentInitialized(_owner, _ownerMode, _graphRegistry);
    }

    // ─── OPERATORS ────────────────────────────────────────────────────────

    function setOperator(address op, bool allowed) external onlyOwner {
        isOperator[op] = allowed;
        emit OperatorSet(op, allowed);
    }

    // ─── CHILDREN ─────────────────────────────────────────────────────────

    /// @notice Link a tour or show under this container. The edge is Pending
    ///         until the child's parties confirm it, so nobody can attach a
    ///         contract to a staking project without its parties agreeing.
    /// @param asParentEdge true registers PARENTS (this → child); false registers
    ///        CHILD_OF (child → this). Either is accepted as a link.
    function registerChild(
        address child,
        bool asParentEdge,
        bytes32 edgeMetaHash,
        string calldata edgeMetaCID
    ) external returns (bytes32 edgeId) {
        if (!_canManage(msg.sender)) revert NotManager();
        if (child == address(0)) revert ZeroAddress();

        IGraphRegistry registry = IGraphRegistry(graphRegistry);
        IGraphRegistry.EdgeType edgeType = asParentEdge
            ? IGraphRegistry.EdgeType.PARENTS
            : IGraphRegistry.EdgeType.CHILD_OF;

        edgeId = asParentEdge
            ? registry.registerEdge(address(this), child, edgeType, edgeMetaHash, edgeMetaCID)
            : registry.registerEdge(child, address(this), edgeType, edgeMetaHash, edgeMetaCID);

        childEdge[child] = edgeId;
        emit ChildRegistered(child, edgeType, edgeId);
    }

    /// @notice True when `child` is linked under this container with an Active
    ///         edge: the one registered here, or a PARENTS (this → child) or
    ///         CHILD_OF (child → this) edge with empty metadata registered
    ///         directly in the registry. An edge that was superseded still
    ///         counts if the edge that replaced it connects the same two nodes
    ///         with the same type. This is the check that stake allocation will
    ///         rely on.
    function isChildLinked(address child) external view returns (bool) {
        IGraphRegistry registry = IGraphRegistry(graphRegistry);

        bytes32 recorded = childEdge[child];
        if (recorded != bytes32(0) && _isLinkActive(recorded)) return true;

        bytes32 parentsId = registry.computeEdgeId(address(this), child, IGraphRegistry.EdgeType.PARENTS, bytes32(0));
        if (_isLinkActive(parentsId)) return true;

        bytes32 childOfId = registry.computeEdgeId(child, address(this), IGraphRegistry.EdgeType.CHILD_OF, bytes32(0));
        return _isLinkActive(childOfId);
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

    /// @dev Active, or superseded by an edge between the same nodes of the same
    ///      type. Anyone authorized on an edge can supersede it with any Active
    ///      edge, so a replacement pointing elsewhere is not followed.
    function _isLinkActive(bytes32 edgeId) internal view returns (bool) {
        IGraphRegistry registry = IGraphRegistry(graphRegistry);
        (address from, address to, IGraphRegistry.EdgeType edgeType,,,) = registry.edges(edgeId);

        for (uint256 i = 0; i < MAX_SUPERSEDE_HOPS; i++) {
            if (registry.isEdgeActive(edgeId)) return true;

            bytes32 next = registry.supersededBy(edgeId);
            if (next == bytes32(0)) return false;

            (address nextFrom, address nextTo, IGraphRegistry.EdgeType nextType,,,) = registry.edges(next);
            if (nextFrom != from || nextTo != to || nextType != edgeType) return false;
            edgeId = next;
        }
        return false;
    }

    /// @dev The owner, a named operator or, in Org mode, an operator of the org wallet.
    function _canManage(address caller) internal view returns (bool) {
        if (caller == owner || isOperator[caller]) return true;
        if (ownerMode != OwnerMode.Org || owner.code.length == 0) return false;

        (bool ok, bytes memory data) = owner.staticcall(
            abi.encodeCall(IGraphAuthorizer.isGraphOperator, (caller))
        );
        return ok && data.length >= 32 && uint256(bytes32(data)) != 0;
    }
}
