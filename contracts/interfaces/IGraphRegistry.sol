// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Types, events and the write/read surface other contracts use to
///         talk to GraphRegistry.
interface IGraphRegistry {
    enum EdgeType {
        HAS_MODULE,     // Show -> Escrow/Ticket/Validator/etc.
        CHILD_OF,       // Child -> Parent
        PARENTS,        // Parent -> Child (explicit inverse)
        APPLIES_TO,     // Standing -> Instance
        SPONSORED_BY,   // Instance -> SponsorContract
        UNDER_TOUR,     // optional alias of CHILD_OF
        UNDER_STAKING,  // reserved for Phase 3 staking parents
        REPLACES,       // reserved for replacement relationships
        PARTICIPATES_AS, // Org/User -> Instance; the role goes in the edge metadata
        OWNED_BY,       // Contract -> Org/Wallet that owns it
        OPERATED_BY,    // Contract -> User with operational authority
        DERIVES_FROM,   // Instance -> the standing agreement or template it was generated from
        REFERENCES,     // Shortcut so a node can appear in another view without a second home
        PAYOUT_ROUTED_TO, // Instance -> Org/Wallet that funds are routed to
        FUNDS_HELD_BY,  // Instance -> the escrow that holds its funds
        DELEGATED_TO    // Delegation or handoff of authority
    }

    enum EdgeStatus { None, Pending, Active, Inactive }

    /// @dev How an edge type reaches Active.
    ///      Immediate    — Active on registration. Only `from`, the node making
    ///                     the claim, its parties or its operator can register it;
    ///                     anyone else is rejected.
    ///      Counterparty — Active on registration only if the registrar is
    ///                     authorized on both endpoints; otherwise Pending until
    ///                     the parties of the other endpoint confirm.
    ///      AllParties   — Pending until all parties of both endpoints confirm.
    enum ConfirmPolicy { Immediate, Counterparty, AllParties }

    struct EdgeInput {
        address  from;
        address  to;
        EdgeType edgeType;
        bytes32  metaHash;
        string   metaCID;
    }

    event EdgeRegistered(
        bytes32 indexed edgeId,
        address indexed from,
        address indexed to,
        EdgeType edgeType,
        EdgeStatus status
    );
    event EdgeConfirmed(bytes32 indexed edgeId, address indexed by);
    event EdgeActivated(bytes32 indexed edgeId);
    event EdgeDeactivated(bytes32 indexed oldEdgeId, bytes32 indexed supersededByEdgeId);

    function registerEdge(
        address from,
        address to,
        EdgeType edgeType,
        bytes32 metaHash,
        string calldata metaCID
    ) external returns (bytes32 edgeId);

    function registerEdges(EdgeInput[] calldata inputs) external returns (bytes32[] memory edgeIds);

    function confirmEdge(bytes32 edgeId) external;

    function supersedeEdge(bytes32 oldEdgeId, bytes32 newEdgeId) external;

    function edgeStatus(bytes32 edgeId) external view returns (EdgeStatus);

    function isEdgeActive(bytes32 edgeId) external view returns (bool);

    /// @notice The edge that replaced `edgeId`, or zero if it was not superseded.
    function supersededBy(bytes32 edgeId) external view returns (bytes32);

    function edges(bytes32 edgeId)
        external
        view
        returns (
            address from,
            address to,
            EdgeType edgeType,
            bytes32 metaHash,
            string memory metaCID,
            uint64 createdAt
        );

    function computeEdgeId(
        address from,
        address to,
        EdgeType edgeType,
        bytes32 metaHash
    ) external pure returns (bytes32);
}
