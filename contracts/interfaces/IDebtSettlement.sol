// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice What an escrow reads from a show's discount coordinator: what each funder owes.
interface IDiscountLedger {
    function funderDebit(address funder) external view returns (uint256);
}

/// @notice What the discount coordinator asks an escrow before it accepts a funder: can the
///         escrow collect that funder's debts from what it pays out?
interface IDebtRoute {
    /// @return fixedAmount  what the funder is certain to be paid: its fixed-amount payouts
    /// @return hasSweepShare whether it also has a share of the final sweep
    function debtRoute(address funder) external view returns (uint256 fixedAmount, bool hasSweepShare);
}
