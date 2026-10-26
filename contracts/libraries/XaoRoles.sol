// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title XaoRoles — role and grant-type ids shared across XAO contracts
/// @notice Every contract that checks or grants a role (the Mini-Org wallet,
///         its membership grants, and anything that asks them) must use these
///         exact ids so they interoperate. The ids are keccak256 of the names.
library XaoRoles {
    // ─── ROLE IDS ─────────────────────────────────────────────────────────
    bytes32 internal constant ROLE_MEMBER    = keccak256("ROLE_MEMBER");
    bytes32 internal constant ROLE_OPERATOR  = keccak256("ROLE_OPERATOR");
    bytes32 internal constant ROLE_TREASURER = keccak256("ROLE_TREASURER");
    bytes32 internal constant ROLE_ADMIN     = keccak256("ROLE_ADMIN");
    bytes32 internal constant ROLE_OWNER     = keccak256("ROLE_OWNER");

    // ─── GRANT TYPES ──────────────────────────────────────────────────────
    // Any grant that confers ROLE_OWNER must report OWNER_GRANT, so a wallet
    // can enforce that only owners manage owner grants.
    bytes32 internal constant OWNER_GRANT     = keccak256("OWNER_GRANT");
    bytes32 internal constant ADMIN_GRANT     = keccak256("ADMIN_GRANT");
    bytes32 internal constant TREASURER_GRANT = keccak256("TREASURER_GRANT");
    bytes32 internal constant OPERATOR_GRANT  = keccak256("OPERATOR_GRANT");
    bytes32 internal constant MEMBER_GRANT    = keccak256("MEMBER_GRANT");
    bytes32 internal constant TRIAL_GRANT     = keccak256("TRIAL_GRANT");
    bytes32 internal constant TEMP_GRANT      = keccak256("TEMP_GRANT");
    bytes32 internal constant CUSTOM_GRANT    = keccak256("CUSTOM_GRANT");
}
