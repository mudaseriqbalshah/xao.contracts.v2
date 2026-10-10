// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice The slices of each show-bundle contract that its sibling modules call.

interface IShowInstanceLike {
    function partyA() external view returns (address);
    function partyB() external view returns (address);
    function isParty(address account) external view returns (bool);
    function isFinalized() external view returns (bool);
    function anySigned() external view returns (bool);
    function isFrozen() external view returns (bool);
    function doorsOpenTime() external view returns (uint64);
    function showStartTime() external view returns (uint64);
    function showEndTime() external view returns (uint64);

    function onDisputeOpened(bytes32 caseId) external;
    function onDisputeResolved(bytes32 caseId) external;
    function onCompleted() external;
    function onCancelled() external;
}

interface IEventEscrowLike {
    /// @notice Called by the ticket contract after it has transferred
    ///         `escrowed` to the escrow; `protocolFee` of that is held for XAO.
    function creditTicketSale(uint256 escrowed, uint256 protocolFee) external;
}

interface IShowTicketLike {
    function exists(uint256 tokenId) external view returns (bool);
    function ownerOf(uint256 tokenId) external view returns (address);
    function lastMintedId() external view returns (uint256);
    /// @return escrowed    what reached the escrow for this ticket
    /// @return protocolFee the part of `escrowed` held for XAO
    function getRefundBasis(uint256 tokenId) external view returns (uint256 escrowed, uint256 protocolFee);
    function burnRefunded(uint256 tokenId) external;
    function scan(uint256 tokenId, bytes32 gateId) external returns (bool accepted);
}

interface IEntryValidatorLike {
    function addScanner(address scanner) external;
    function removeScanner(address scanner) external;
    function setPaused(bool paused) external;
}
