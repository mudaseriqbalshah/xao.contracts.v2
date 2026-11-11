// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice A membership / role grant attached to a Mini-Org wallet. Immutable
///         role assignments; authority ends only by ending the grant.
interface IMiniOrgGrant {
    function org() external view returns (address);
    function isActive() external view returns (bool);
    function hasRole(address user, bytes32 role) external view returns (bool);
    function grantType() external view returns (bytes32);
}

/// @notice What a grant and the factory need to ask the org wallet.
interface IMiniOrgWallet {
    function hasRole(address user, bytes32 role) external view returns (bool);
    function canManageNonOwnerGrants(address caller) external view returns (bool);
    function canManageOwnerGrants(address caller) external view returns (bool);
    function isGraphOperator(address operator) external view returns (bool);
}

/// @notice What the org wallet asks the factory that makes its grants.
interface IMiniOrgGrantRegistry {
    function isOfficialGrant(address grant) external view returns (bool);
}
