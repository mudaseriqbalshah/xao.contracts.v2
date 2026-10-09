// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Exposed by party-based contracts (1–2 parties) so GraphRegistry can
///         derive who must confirm an edge touching this node.
interface IGraphParties {
    function partyA() external view returns (address);
    function partyB() external view returns (address); // may be address(0)
}
