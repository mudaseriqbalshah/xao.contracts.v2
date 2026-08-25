// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal interface used by XAOTicket to query ShowContract state.
interface IShowContract {
    function endTime()       external view returns (uint256);
    function doorsTime()     external view returns (uint256);
    function salesTaxBPS()   external view returns (uint256);
    function totalCapacity() external view returns (uint256);
    function creditRevenue(uint256 amount) external;
    // Used by XAOTicket to freeze tiers once both parties have signed, and to
    // let party2 edit tiers during negotiation (before finalization).
    function isFinalized()   external view returns (bool);
    function status()        external view returns (uint8);
    function party2()        external view returns (address wallet, uint8 role, string memory xaoUsername);
    // Called by XAOTicket when a tier is added during negotiation, so a tier
    // change invalidates a prior signature (the signer must re-approve).
    function onTierChanged(address editor) external;
}
