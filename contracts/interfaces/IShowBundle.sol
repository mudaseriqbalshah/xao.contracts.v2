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
    /// @dev ShowInstance.ShowStatus as a number: 0 Offer, 1 Signed, 2 Active,
    ///      3 InDispute, 4 Completed, 5 Cancelled, 6 Expired.
    function status() external view returns (uint8);
    function escrow() external view returns (address);

    function onDisputeOpened(bytes32 caseId) external;
    function onDisputeResolved(bytes32 caseId) external;
    function onCompleted() external;
    function onCancelled() external;
}

interface IEventEscrowLike {
    /// @notice Called by the ticket contract after it has transferred
    ///         `escrowed` to the escrow; `protocolFee` of that is held for XAO.
    function creditTicketSale(uint256 escrowed, uint256 protocolFee) external;

    function payoutToken() external view returns (address);

    /// @notice A subordinate agreement collects money earmarked for it.
    function settleSubordinate(address recipient, uint256 amount) external;

    /// @notice A subordinate agreement gives back money earmarked for it.
    function releaseReservation(uint256 amount) external;
}

/// @notice What the escrow needs from a subordinate agreement, such as a support slot.
interface ISubordinateLike {
    function parentShow() external view returns (address);
    function parentEscrow() external view returns (address);
    function onReserved(uint256 amount) external;
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
