// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "../interfaces/IShowBundle.sol";
import "../interfaces/IDiscountCoordinator.sol";
import "./DataModule.sol";

/// @title DataModuleFactory — creates the data module of a show (Phase 2F)
/// @notice One minimal-proxy clone per show, made by one of the show's parties. It holds
///         no funds and no authority. After it is made, the show side still has to name
///         it on the discount coordinator (setDataGuard) before the show is signed.
contract DataModuleFactory {

    error ZeroImplementation();
    error NotAShowParty();
    error WrongCoordinator();
    error AlreadyCreated();

    address public immutable implementation;
    mapping(address => address) public moduleOf;            // show => its data module

    event DataModuleDeployed(address indexed module, address indexed show, address indexed coordinator);

    constructor(address _implementation) {
        if (_implementation == address(0)) revert ZeroImplementation();
        implementation = _implementation;
    }

    function createModule(address show, address coordinator, address[3] calldata nodes, uint64 reserveDeadline) external returns (address module) {
        if (!IShowInstanceLike(show).isParty(msg.sender)) revert NotAShowParty();
        if (IDataSource(coordinator).show() != show) revert WrongCoordinator();
        if (moduleOf[show] != address(0)) revert AlreadyCreated();

        module = Clones.clone(implementation);
        DataModule(module).initialize(show, coordinator, nodes, reserveDeadline);
        moduleOf[show] = module;
        emit DataModuleDeployed(module, show, coordinator);
    }
}
