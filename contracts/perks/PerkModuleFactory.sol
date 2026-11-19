// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "../interfaces/IMiniOrg.sol";
import "../libraries/XaoRoles.sol";
import "./PerkModule.sol";

/// @title PerkModuleFactory — creates perk modules (Phase 2F)
/// @notice Each module is a minimal-proxy clone bound to one issuer and one scope.
///         A module for a plain address is created by that address; a module for
///         an org wallet by one of the org's owners, admins or operators. The
///         factory holds no funds and no authority over modules.
contract PerkModuleFactory {

    error ZeroImplementation();
    error NotAuthorized();

    address public immutable implementation;

    address[] public allModules;
    mapping(address => address[]) internal _issuerModules;

    event PerkModuleDeployed(address indexed module, address indexed issuer, address indexed creator);

    constructor(address _implementation) {
        if (_implementation == address(0)) revert ZeroImplementation();
        implementation = _implementation;
    }

    function createModule(PerkModule.ModuleInit calldata init) external returns (address module) {
        if (!_mayCreateFor(init.issuer, msg.sender)) revert NotAuthorized();

        module = Clones.clone(implementation);
        PerkModule(module).initialize(init);

        allModules.push(module);
        _issuerModules[init.issuer].push(module);
        emit PerkModuleDeployed(module, init.issuer, msg.sender);
    }

    function getModuleCount() external view returns (uint256) {
        return allModules.length;
    }

    function getIssuerModules(address issuer) external view returns (address[] memory) {
        return _issuerModules[issuer];
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
