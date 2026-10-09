// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Optional. Lets a node (or an org wallet acting as a party) name
///         operators that may act on its behalf in GraphRegistry.
interface IGraphAuthorizer {
    function isGraphOperator(address operator) external view returns (bool);
}
