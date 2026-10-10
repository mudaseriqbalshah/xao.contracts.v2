// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IGraphParties.sol";
import "../interfaces/IGraphAuthorizer.sol";
import "../interfaces/IGraphRegistrar.sol";
import "../interfaces/IGraphRegistry.sol";

/// @title GraphRegistry — typed, append-only edges between XAO contract nodes (Phase 2A)
/// @notice Discovery/indexing only: holds no funds, has no admin and no execution
///         authority. Edges are never deleted or mutated; a relationship that
///         changes is superseded, which leaves the old edge Inactive and
///         pointing at its replacement.
contract GraphRegistry is IGraphRegistry {

    error ZeroAddress();
    error SelfEdge();
    error NotAuthorized();
    error EdgeExists();
    error EdgeNotFound();
    error EdgeNotPending();
    error EdgeInactive();
    error NothingToConfirm();
    error NewEdgeNotActive();
    error SameEdge();

    struct Edge {
        address  from;
        address  to;
        EdgeType edgeType;
        bytes32  metaHash;   // optional hash anchor of JSON metadata
        string   metaCID;    // optional IPFS CID
        uint64   createdAt;
    }

    uint8 private constant SIDE_FROM = 1;
    uint8 private constant SIDE_TO   = 2;

    mapping(bytes32 => Edge)       public edges;
    mapping(bytes32 => EdgeStatus) public override edgeStatus;
    mapping(bytes32 => bytes32)    public supersededBy;          // old -> new

    mapping(bytes32 => mapping(address => bool)) public confirmedBy; // edgeId => confirmer => bool
    mapping(bytes32 => uint256)                  public confirmCount;

    /// @notice Set once at deployment; there is no setter.
    mapping(EdgeType => ConfirmPolicy) public confirmPolicy;

    /// @notice Bitmask of the endpoints whose parties must confirm this edge
    ///         (1 = from, 2 = to). Zero for edges that were Active on registration.
    mapping(bytes32 => uint8) public pendingSides;

    // Adjacency lists so a client can traverse the graph without an indexer.
    mapping(address => bytes32[]) private _edgesFrom;
    mapping(address => bytes32[]) private _edgesTo;

    constructor() {
        // HAS_MODULE stays Immediate (the mapping default).
        confirmPolicy[EdgeType.CHILD_OF]      = ConfirmPolicy.Counterparty;
        confirmPolicy[EdgeType.PARENTS]       = ConfirmPolicy.Counterparty;
        confirmPolicy[EdgeType.UNDER_TOUR]    = ConfirmPolicy.Counterparty;
        confirmPolicy[EdgeType.UNDER_STAKING] = ConfirmPolicy.Counterparty;
        confirmPolicy[EdgeType.APPLIES_TO]    = ConfirmPolicy.AllParties;
        confirmPolicy[EdgeType.SPONSORED_BY]  = ConfirmPolicy.AllParties;
        confirmPolicy[EdgeType.REPLACES]      = ConfirmPolicy.AllParties;
        // Role and authority claims name someone else, so the side that did
        // not register the edge has to confirm it.
        confirmPolicy[EdgeType.PARTICIPATES_AS] = ConfirmPolicy.Counterparty;
        confirmPolicy[EdgeType.OWNED_BY]        = ConfirmPolicy.Counterparty;
        confirmPolicy[EdgeType.OPERATED_BY]     = ConfirmPolicy.Counterparty;
    }

    // ─── WRITES ───────────────────────────────────────────────────────────

    /// @notice Register an edge. The caller must be authorized on at least one
    ///         endpoint (see isAuthorizedFor). If the caller is also a required
    ///         confirmer, their confirmation is recorded in the same call.
    function registerEdge(
        address from,
        address to,
        EdgeType edgeType,
        bytes32 metaHash,
        string calldata metaCID
    ) external override returns (bytes32 edgeId) {
        return _registerEdge(from, to, edgeType, metaHash, metaCID);
    }

    /// @notice Register several edges in one transaction, e.g. both directions
    ///         of a parent/child link. Each edge follows the registerEdge rules.
    function registerEdges(EdgeInput[] calldata inputs)
        external
        override
        returns (bytes32[] memory edgeIds)
    {
        edgeIds = new bytes32[](inputs.length);
        for (uint256 i = 0; i < inputs.length; i++) {
            EdgeInput calldata e = inputs[i];
            edgeIds[i] = _registerEdge(e.from, e.to, e.edgeType, e.metaHash, e.metaCID);
        }
    }

    function _registerEdge(
        address from,
        address to,
        EdgeType edgeType,
        bytes32 metaHash,
        string memory metaCID
    ) internal returns (bytes32 edgeId) {
        if (from == address(0) || to == address(0)) revert ZeroAddress();
        if (from == to) revert SelfEdge();

        bool authFrom = isAuthorizedFor(from, msg.sender);
        bool authTo   = isAuthorizedFor(to, msg.sender);
        if (!authFrom && !authTo) revert NotAuthorized();

        edgeId = computeEdgeId(from, to, edgeType, metaHash);
        if (edgeStatus[edgeId] != EdgeStatus.None) revert EdgeExists();

        edges[edgeId] = Edge(from, to, edgeType, metaHash, metaCID, uint64(block.timestamp));
        _edgesFrom[from].push(edgeId);
        _edgesTo[to].push(edgeId);

        ConfirmPolicy policy = confirmPolicy[edgeType];
        uint8 sides;
        if (policy == ConfirmPolicy.AllParties) {
            sides = SIDE_FROM | SIDE_TO;
        } else if (policy == ConfirmPolicy.Counterparty) {
            sides = (authFrom ? 0 : SIDE_FROM) | (authTo ? 0 : SIDE_TO);
        }

        if (sides == 0) {
            edgeStatus[edgeId] = EdgeStatus.Active;
            emit EdgeRegistered(edgeId, from, to, edgeType, EdgeStatus.Active);
            return edgeId;
        }

        pendingSides[edgeId] = sides;
        edgeStatus[edgeId]   = EdgeStatus.Pending;
        emit EdgeRegistered(edgeId, from, to, edgeType, EdgeStatus.Pending);

        _confirmAs(edgeId, msg.sender);
        _activateIfFullyConfirmed(edgeId);
    }

    /// @notice Confirm a Pending edge as one of its required confirmers, or as
    ///         an operator of a required confirmer that is an org wallet.
    function confirmEdge(bytes32 edgeId) external override {
        EdgeStatus st = edgeStatus[edgeId];
        if (st == EdgeStatus.None) revert EdgeNotFound();
        if (st != EdgeStatus.Pending) revert EdgeNotPending();

        if (_confirmAs(edgeId, msg.sender) == 0) revert NothingToConfirm();
        _activateIfFullyConfirmed(edgeId);
    }

    /// @notice Mark `oldEdgeId` Inactive and point it at the Active edge that
    ///         replaces it. Nothing is deleted.
    function supersedeEdge(bytes32 oldEdgeId, bytes32 newEdgeId) external override {
        if (oldEdgeId == newEdgeId) revert SameEdge();

        EdgeStatus oldStatus = edgeStatus[oldEdgeId];
        if (oldStatus == EdgeStatus.None) revert EdgeNotFound();
        if (oldStatus == EdgeStatus.Inactive) revert EdgeInactive();
        if (edgeStatus[newEdgeId] != EdgeStatus.Active) revert NewEdgeNotActive();

        Edge storage e = edges[oldEdgeId];
        if (!isAuthorizedFor(e.from, msg.sender) && !isAuthorizedFor(e.to, msg.sender)) {
            revert NotAuthorized();
        }

        edgeStatus[oldEdgeId]   = EdgeStatus.Inactive;
        supersededBy[oldEdgeId] = newEdgeId;
        emit EdgeDeactivated(oldEdgeId, newEdgeId);
    }

    // ─── VIEWS ────────────────────────────────────────────────────────────

    function computeEdgeId(
        address from,
        address to,
        EdgeType edgeType,
        bytes32 metaHash
    ) public pure override returns (bytes32) {
        return keccak256(abi.encodePacked(from, to, edgeType, metaHash));
    }

    function isEdgeActive(bytes32 edgeId) external view override returns (bool) {
        return edgeStatus[edgeId] == EdgeStatus.Active;
    }

    /// @notice True when `caller` may register or supersede edges touching `node`:
    ///         the node itself, an operator the node names, one of the node's
    ///         parties, or an operator of a party that is an org wallet.
    ///         A node that names a registrar (IGraphRegistrar) narrows the
    ///         party rule to that one address.
    function isAuthorizedFor(address node, address caller) public view returns (bool) {
        if (caller == node) return true;
        if (_isOperator(node, caller)) return true;

        address registrar = _registrar(node);
        if (registrar != address(0)) return _actsAs(registrar, caller);

        (address a, address b, bool isPartyNode) = _parties(node);
        if (!isPartyNode) return false;
        return _actsAs(a, caller) || (b != address(0) && _actsAs(b, caller));
    }

    /// @notice partyA (and partyB if set) for party-based contracts; otherwise
    ///         the node address itself.
    function getRequiredConfirmersForNode(address node) public view returns (address[] memory out) {
        (address a, address b, bool isPartyNode) = _parties(node);
        if (!isPartyNode) {
            out = new address[](1);
            out[0] = node;
        } else if (b == address(0) || b == a) {
            out = new address[](1);
            out[0] = a;
        } else {
            out = new address[](2);
            out[0] = a;
            out[1] = b;
        }
    }

    /// @notice Confirmers still relevant to this edge, duplicates removed.
    ///         Empty for edges that were Active on registration.
    function getRequiredConfirmersForEdge(bytes32 edgeId) public view returns (address[] memory out) {
        uint8 sides = pendingSides[edgeId];
        Edge storage e = edges[edgeId];

        address[] memory fromC = (sides & SIDE_FROM) != 0
            ? getRequiredConfirmersForNode(e.from)
            : new address[](0);
        address[] memory toC = (sides & SIDE_TO) != 0
            ? getRequiredConfirmersForNode(e.to)
            : new address[](0);

        address[] memory tmp = new address[](fromC.length + toC.length);
        uint256 n;
        for (uint256 i = 0; i < fromC.length; i++) {
            tmp[n++] = fromC[i];
        }
        for (uint256 i = 0; i < toC.length; i++) {
            bool dup;
            for (uint256 j = 0; j < fromC.length; j++) {
                if (fromC[j] == toC[i]) { dup = true; break; }
            }
            if (!dup) tmp[n++] = toC[i];
        }

        out = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = tmp[i];
        }
    }

    function isFullyConfirmed(bytes32 edgeId) public view returns (bool) {
        if (edgeStatus[edgeId] == EdgeStatus.None) return false;
        address[] memory req = getRequiredConfirmersForEdge(edgeId);
        for (uint256 i = 0; i < req.length; i++) {
            if (!confirmedBy[edgeId][req[i]]) return false;
        }
        return true;
    }

    /// @notice Matches the spec's boolean view of the policy table.
    function requiresPartyConfirmation(EdgeType edgeType) external view returns (bool) {
        return confirmPolicy[edgeType] == ConfirmPolicy.AllParties;
    }

    function edgesFromCount(address node) external view returns (uint256) {
        return _edgesFrom[node].length;
    }

    function edgesToCount(address node) external view returns (uint256) {
        return _edgesTo[node].length;
    }

    /// @notice Page through the ids of edges whose `from` is `node`.
    function getEdgesFrom(address node, uint256 offset, uint256 limit)
        external view returns (bytes32[] memory)
    {
        return _page(_edgesFrom[node], offset, limit);
    }

    /// @notice Page through the ids of edges whose `to` is `node`.
    function getEdgesTo(address node, uint256 offset, uint256 limit)
        external view returns (bytes32[] memory)
    {
        return _page(_edgesTo[node], offset, limit);
    }

    // ─── INTERNAL ─────────────────────────────────────────────────────────

    /// @dev Records a confirmation for every outstanding confirmer `caller`
    ///      can act as. Returns how many were recorded.
    function _confirmAs(bytes32 edgeId, address caller) internal returns (uint256 recorded) {
        address[] memory req = getRequiredConfirmersForEdge(edgeId);
        for (uint256 i = 0; i < req.length; i++) {
            address c = req[i];
            if (!confirmedBy[edgeId][c] && _actsAs(c, caller)) {
                confirmedBy[edgeId][c] = true;
                confirmCount[edgeId]++;
                recorded++;
                emit EdgeConfirmed(edgeId, c);
            }
        }
    }

    function _activateIfFullyConfirmed(bytes32 edgeId) internal {
        if (isFullyConfirmed(edgeId)) {
            edgeStatus[edgeId] = EdgeStatus.Active;
            emit EdgeActivated(edgeId);
        }
    }

    /// @dev `caller` is the party, or an operator of a party that is an org wallet.
    function _actsAs(address party, address caller) internal view returns (bool) {
        return caller == party || _isOperator(party, caller);
    }

    /// @dev Low-level calls throughout: the target may be an EOA or a contract
    ///      that implements neither interface, and neither case may revert.
    function _isOperator(address node, address operator) internal view returns (bool) {
        if (node.code.length == 0) return false;
        (bool ok, bytes memory data) = node.staticcall(
            abi.encodeCall(IGraphAuthorizer.isGraphOperator, (operator))
        );
        return ok && data.length >= 32 && uint256(bytes32(data)) != 0;
    }

    /// @dev Zero when the node does not name a registrar.
    function _registrar(address node) internal view returns (address) {
        if (node.code.length == 0) return address(0);
        (bool ok, bytes memory data) = node.staticcall(
            abi.encodeCall(IGraphRegistrar.graphRegistrar, ())
        );
        if (!ok || data.length < 32) return address(0);
        return address(uint160(uint256(bytes32(data))));
    }

    function _parties(address node) internal view returns (address a, address b, bool isPartyNode) {
        if (node.code.length == 0) return (address(0), address(0), false);

        (bool okA, bytes memory dataA) = node.staticcall(abi.encodeCall(IGraphParties.partyA, ()));
        if (!okA || dataA.length < 32) return (address(0), address(0), false);
        a = address(uint160(uint256(bytes32(dataA))));
        if (a == address(0)) return (address(0), address(0), false);

        (bool okB, bytes memory dataB) = node.staticcall(abi.encodeCall(IGraphParties.partyB, ()));
        if (okB && dataB.length >= 32) {
            b = address(uint160(uint256(bytes32(dataB))));
        }
        isPartyNode = true;
    }

    function _page(bytes32[] storage list, uint256 offset, uint256 limit)
        internal view returns (bytes32[] memory out)
    {
        uint256 len = list.length;
        if (offset >= len) return new bytes32[](0);
        uint256 end = limit > len - offset ? len : offset + limit;
        out = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            out[i - offset] = list[i];
        }
    }
}
