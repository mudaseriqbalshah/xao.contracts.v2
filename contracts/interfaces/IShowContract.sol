// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal interface used by XAOTicket to query ShowContract state.
interface IShowContract {
    function endTime()       external view returns (uint256);
    function doorsTime()     external view returns (uint256);
    function salesTaxBPS()   external view returns (uint256);
    function totalCapacity() external view returns (uint256);
    function creditRevenue(uint256 amount) external;
}
