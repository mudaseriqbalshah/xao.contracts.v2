// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice What ticketing, point of sale and apps ask a perk module. The module
///         decides who qualifies for a benefit and what it is worth; the caller
///         applies it.
interface IPerkModule {
    /// @dev Proof a perk may need that the wallet is entitled in this particular case.
    struct PerkContext {
        uint256 ticketTokenId;      // a ticket the wallet holds, for perks that depend on a ticket purchase
        bytes32 eventRef;           // which event the use belongs to, for perks limited per event
    }

    function issuer() external view returns (address);

    /// @notice True if the wallet qualifies for the perk right now.
    function isEligible(address wallet, uint256 perkId, PerkContext calldata ctx) external view returns (bool);

    function hasPresaleAccess(address wallet, uint256 perkId, PerkContext calldata ctx) external view returns (bool);
    function hasAccess(address wallet, uint256 perkId, PerkContext calldata ctx) external view returns (bool);
    function hasStatus(address wallet, uint256 perkId, PerkContext calldata ctx) external view returns (bool);
    function canClaim(address wallet, uint256 perkId, PerkContext calldata ctx) external view returns (bool);

    /// @notice The discount this perk gives on an item that costs `price`; zero if none applies.
    function getPOSDiscount(address wallet, uint256 perkId, uint256 price, PerkContext calldata ctx) external view returns (uint256);
}
