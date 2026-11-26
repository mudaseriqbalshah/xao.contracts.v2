// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice What an escrow reads from a show's discount coordinator: what each funder owes.
interface IDiscountLedger {
    /// @notice What a funder owes for the discounts it offered.
    function funderDebit(address funder) external view returns (uint256);

    /// @notice What the show's escrow has to collect from `payee`: the debts of every funder
    ///         the show pays through it. For a funder paid directly this is its own debt; for a
    ///         tour band it is collected from the tour's settlement escrow, which is the payee.
    function payeeDebit(address payee) external view returns (uint256);

    /// @notice Called by the show's escrow as it completes: bring in any top-up money that pays
    ///         for discounts beyond what funders signed for.
    function payTopUps() external;
}

/// @dev The escrow's payout rules and sweep, as the coordinator reads them to find who pays a funder.
interface IEscrowRoutes {
    struct PayoutRule { address to; uint8 kind; uint256 value; uint64 notBefore; bool executed; bool isGuarantee; }
    struct SweepRule { address[] recipients; uint16[] bps; uint64 notBefore; }
    function getPayoutRules() external view returns (PayoutRule[] memory);
    function getSweepRule() external view returns (SweepRule memory);
}

/// @notice What the discount coordinator asks an escrow before it accepts a funder: can the
///         escrow collect that funder's debts from what it pays out?
interface IDebtRoute {
    /// @return fixedAmount  what the funder is certain to be paid: its fixed-amount payouts
    /// @return hasSweepShare whether it also has a share of the final sweep
    function debtRoute(address funder) external view returns (uint256 fixedAmount, bool hasSweepShare);
}
