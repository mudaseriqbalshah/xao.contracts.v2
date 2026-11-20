// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./DiscountCoordinator.sol";

/// @title DiscountCoordinatorFactory — creates the discount coordinator of a show (Phase 2F)
/// @notice One minimal-proxy clone per show, created by one of the show's parties.
///         The show factory will create it with the rest of a show's contracts;
///         this one is for shows set up by hand. It holds no funds and no authority.
contract DiscountCoordinatorFactory {

    error ZeroImplementation();
    error NotAShowParty();
    error AlreadyCreated();

    address public immutable implementation;
    mapping(address => address) public coordinatorOf;       // show => its coordinator

    event DiscountCoordinatorDeployed(address indexed coordinator, address indexed show, address indexed ticketContract);

    constructor(address _implementation) {
        if (_implementation == address(0)) revert ZeroImplementation();
        implementation = _implementation;
    }

    function createCoordinator(address show, address ticketContract) external returns (address coordinator) {
        if (!IShowInstanceLike(show).isParty(msg.sender)) revert NotAShowParty();
        if (coordinatorOf[show] != address(0)) revert AlreadyCreated();

        coordinator = Clones.clone(implementation);
        DiscountCoordinator(coordinator).initialize(show, ticketContract);
        coordinatorOf[show] = coordinator;
        emit DiscountCoordinatorDeployed(coordinator, show, ticketContract);
    }
}
