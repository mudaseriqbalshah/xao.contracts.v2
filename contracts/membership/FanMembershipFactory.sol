// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "../interfaces/IMiniOrg.sol";
import "../libraries/XaoRoles.sol";
import "./FanMembership.sol";

/// @title FanMembershipFactory — creates fan membership programs (Phase 2F)
/// @notice Each program is a minimal-proxy clone bound to one issuer and one
///         scope. A program for a plain address is created by that address; a
///         program for an org wallet by one of the org's owners, admins or
///         operators. The factory holds no funds and no authority over programs.
contract FanMembershipFactory {

    error ZeroImplementation();
    error NotAuthorized();

    address public immutable implementation;

    address[] public allPrograms;
    mapping(address => address[]) internal _issuerPrograms;

    event FanMembershipProgramDeployed(address indexed program, address indexed issuer, address indexed creator);

    constructor(address _implementation) {
        if (_implementation == address(0)) revert ZeroImplementation();
        implementation = _implementation;
    }

    function createProgram(FanMembership.ProgramInit calldata init) external returns (address program) {
        if (!_mayCreateFor(init.issuer, msg.sender)) revert NotAuthorized();

        program = Clones.clone(implementation);
        FanMembership(program).initialize(init);

        allPrograms.push(program);
        _issuerPrograms[init.issuer].push(program);
        emit FanMembershipProgramDeployed(program, init.issuer, msg.sender);
    }

    function getProgramCount() external view returns (uint256) {
        return allPrograms.length;
    }

    function getIssuerPrograms(address issuer) external view returns (address[] memory) {
        return _issuerPrograms[issuer];
    }

    function _mayCreateFor(address issuer, address caller) internal view returns (bool) {
        if (caller == issuer) return true;
        if (issuer.code.length == 0) return false;
        return _hasRole(issuer, caller, XaoRoles.ROLE_OWNER)
            || _hasRole(issuer, caller, XaoRoles.ROLE_ADMIN)
            || _hasRole(issuer, caller, XaoRoles.ROLE_OPERATOR);
    }

    function _hasRole(address org, address who, bytes32 role) internal view returns (bool) {
        (bool ok, bytes memory data) = org.staticcall(abi.encodeCall(IMiniOrgWallet.hasRole, (who, role)));
        return ok && data.length >= 32 && uint256(bytes32(data)) != 0;
    }
}
