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

    /// @dev True for the five standard roles.
    function isRole(bytes32 role) internal pure returns (bool) {
        return role == ROLE_MEMBER || role == ROLE_OPERATOR || role == ROLE_TREASURER
            || role == ROLE_ADMIN || role == ROLE_OWNER;
    }

    /// @dev True for the eight standard grant types.
    function isGrantType(bytes32 t) internal pure returns (bool) {
        return t == OWNER_GRANT || t == ADMIN_GRANT || t == TREASURER_GRANT || t == OPERATOR_GRANT
            || t == MEMBER_GRANT || t == TRIAL_GRANT || t == TEMP_GRANT || t == CUSTOM_GRANT;
    }
}
