// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./XAOTicket.sol";

/// @title XAOTicketFactory — deploys XAOTicket collections for ShowContracts.
/// @notice Extracted from ShowContract so that ShowContract (and, by extension,
///         ShowContractFactory) do not embed XAOTicket's creation bytecode. That
///         embedding pushed both contracts past the 24,576-byte EIP-170 limit and
///         made them undeployable. XAOTicket's own creation code now lives here,
///         in a standalone contract that is comfortably under the limit.
///
///         XAOTicket's constructor grants DEFAULT_ADMIN_ROLE / ADMIN_ROLE to the
///         `_showContract` argument (NOT to msg.sender), so the deploying
///         ShowContract remains the admin exactly as before — this factory holds
///         no privileged role over the tickets it deploys.
contract XAOTicketFactory {
    event TicketDeployed(address indexed show, address indexed ticket);

    /// @notice Deploy a new XAOTicket owned/administered by `show`.
    /// @param show      the ShowContract that will administer the tickets
    /// @param usdc      USDC token address used for ticket sales
    /// @param treasury  protocol treasury (royalty / fee sink)
    /// @param eventName event name for the ERC-1155 collection
    /// @param capacity  total ticket capacity
    /// @return the deployed XAOTicket address
    function deploy(
        address show,
        address usdc,
        address treasury,
        string calldata eventName,
        uint256 capacity
    ) external returns (address) {
        XAOTicket ticket = new XAOTicket(show, usdc, treasury, eventName, capacity);
        emit TicketDeployed(show, address(ticket));
        return address(ticket);
    }
}
