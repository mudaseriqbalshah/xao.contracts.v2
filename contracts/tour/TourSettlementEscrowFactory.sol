// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./TourSettlementEscrow.sol";

/// @title TourSettlementEscrowFactory — creates the settlement escrow of a tour (Phase 2F)
/// @notice One minimal-proxy clone per tour, created by the tour's owner (or an operator of it).
///         It holds no funds and keeps no authority over the modules it makes.
contract TourSettlementEscrowFactory {

    error ZeroAddress();
    error NotTourSide();
    error AlreadyCreated();

    address public immutable implementation;
    address public immutable showFactory;               // the show factory whose escrows may pay in
    mapping(address => address) public moduleOf;        // tour shell => its settlement escrow

    event TourSettlementEscrowDeployed(address indexed module, address indexed tourShell, address indexed token);

    constructor(address _implementation, address _showFactory) {
        if (_implementation == address(0) || _showFactory == address(0)) revert ZeroAddress();
        implementation = _implementation;
        showFactory = _showFactory;
    }

    function createModule(address tourShell, address token, address remainderReceiver) external returns (address module) {
        if (moduleOf[tourShell] != address(0)) revert AlreadyCreated();
        ITourShellView shell = ITourShellView(tourShell);
        if (msg.sender != shell.owner() && !shell.isOperator(msg.sender)) revert NotTourSide();

        module = Clones.clone(implementation);
        TourSettlementEscrow(module).initialize(tourShell, token, showFactory, remainderReceiver);
        moduleOf[tourShell] = module;
        emit TourSettlementEscrowDeployed(module, tourShell, token);
    }
}
