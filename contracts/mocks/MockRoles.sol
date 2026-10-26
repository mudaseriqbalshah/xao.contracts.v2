// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../libraries/XaoRoles.sol";

/// @dev Test helper that exposes the shared role and grant-type ids.
contract MockRoles {
    function roleMember()    external pure returns (bytes32) { return XaoRoles.ROLE_MEMBER; }
    function roleOperator()  external pure returns (bytes32) { return XaoRoles.ROLE_OPERATOR; }
    function roleTreasurer() external pure returns (bytes32) { return XaoRoles.ROLE_TREASURER; }
    function roleAdmin()     external pure returns (bytes32) { return XaoRoles.ROLE_ADMIN; }
    function roleOwner()     external pure returns (bytes32) { return XaoRoles.ROLE_OWNER; }

    function ownerGrant()     external pure returns (bytes32) { return XaoRoles.OWNER_GRANT; }
    function adminGrant()     external pure returns (bytes32) { return XaoRoles.ADMIN_GRANT; }
    function treasurerGrant() external pure returns (bytes32) { return XaoRoles.TREASURER_GRANT; }
    function operatorGrant()  external pure returns (bytes32) { return XaoRoles.OPERATOR_GRANT; }
    function memberGrant()    external pure returns (bytes32) { return XaoRoles.MEMBER_GRANT; }
    function trialGrant()     external pure returns (bytes32) { return XaoRoles.TRIAL_GRANT; }
    function tempGrant()      external pure returns (bytes32) { return XaoRoles.TEMP_GRANT; }
    function customGrant()    external pure returns (bytes32) { return XaoRoles.CUSTOM_GRANT; }
}
