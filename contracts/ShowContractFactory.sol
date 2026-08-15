// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ShowContract.sol";

/// @title ShowContractFactory — deploy one ShowContract per show (Phase 1 MVP)
/// @notice Phase 2 upgrade path: beacon proxy pattern (contracts-upgradeable v5).
contract ShowContractFactory {

    address[] public allContracts;
    mapping(address => address[]) public userContracts;

    /// @notice XAOTicketFactory injected into every ShowContract this factory
    ///         deploys. Set once at construction; ShowContract uses it to deploy
    ///         its XAOTicket collection without embedding that bytecode itself.
    address public immutable ticketFactory;

    event ShowContractCreated(
        address indexed contractAddr,
        address indexed party1Wallet,
        address indexed party2Wallet
    );

    constructor(address _ticketFactory) {
        require(_ticketFactory != address(0), "Zero ticket factory");
        ticketFactory = _ticketFactory;
    }

    /// @notice Deploy a new ShowContract and register it in both parties' lists.
    ///         The `create` signature is unchanged for callers — the ticket
    ///         factory is injected from storage, not passed in.
    function create(
        ShowContract.PartyConfig    memory _p1,
        address                           _p2Wallet,
        ShowContract.PartyRole            _p2Role,
        ShowContract.DatesConfig    memory _dates,
        ShowContract.LocationConfig memory _loc,
        ShowContract.TicketConfig   memory _tickets,
        ShowContract.FinancialConfig memory _fin,
        ShowContract.PromoConfig    memory _promo,
        address                           _usdc,
        address                           _treasury
    ) external returns (address) {
        ShowContract show = new ShowContract(
            _p1,
            _p2Wallet,
            _p2Role,
            _dates,
            _loc,
            _tickets,
            _fin,
            _promo,
            _usdc,
            _treasury,
            ticketFactory
        );

        address showAddr = address(show);
        allContracts.push(showAddr);
        userContracts[_p1.wallet].push(showAddr);
        if (_p2Wallet != _p1.wallet) {
            userContracts[_p2Wallet].push(showAddr);
        }

        emit ShowContractCreated(showAddr, _p1.wallet, _p2Wallet);
        return showAddr;
    }

    function getContractCount() external view returns (uint256) {
        return allContracts.length;
    }

    function getUserContracts(address user) external view returns (address[] memory) {
        return userContracts[user];
    }
}
