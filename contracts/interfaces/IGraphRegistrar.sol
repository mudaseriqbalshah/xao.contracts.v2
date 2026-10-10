// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Optional. A party-based node that implements this limits who may
///         register or supersede edges on its behalf to one address, instead
///         of any of its parties. Its parties still confirm edges as usual.
interface IGraphRegistrar {
    function graphRegistrar() external view returns (address);
}
