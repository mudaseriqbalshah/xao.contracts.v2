// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./TourCoverage.sol";

/// @title TourCoverageFactory — creates the coverage ledger of a tour (Phase 2F)
/// @notice One minimal-proxy clone per tour, created by the tour's owner (or an operator of it).
///         It holds no funds and keeps no authority over the ledgers it makes.
contract TourCoverageFactory {

    error ZeroAddress();
    error NotTourSide();
    error AlreadyCreated();

    address public immutable implementation;
    address public immutable showFactory;               // the show factory whose escrows may count
    mapping(address => address) public coverageOf;      // tour shell => its coverage ledger

    event TourCoverageDeployed(address indexed coverage, address indexed tourShell, address indexed token);

    constructor(address _implementation, address _showFactory) {
        if (_implementation == address(0) || _showFactory == address(0)) revert ZeroAddress();
        implementation = _implementation;
        showFactory = _showFactory;
    }

    function createCoverage(address tourShell, address token) external returns (address coverage) {
        if (coverageOf[tourShell] != address(0)) revert AlreadyCreated();
        ITourShellView shell = ITourShellView(tourShell);
        if (msg.sender != shell.owner() && !shell.isOperator(msg.sender)) revert NotTourSide();

        coverage = Clones.clone(implementation);
        TourCoverage(coverage).initialize(tourShell, token, showFactory);
        coverageOf[tourShell] = coverage;
        emit TourCoverageDeployed(coverage, tourShell, token);
    }
}
