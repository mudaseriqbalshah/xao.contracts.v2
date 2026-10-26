// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./SupportSlotAgreement.sol";

/// @title SupportSlotFactory — deploy one SupportSlotAgreement per opener (Phase 2A)
/// @notice Each slot is a minimal-proxy clone. Only the organizer (partyA) can
///         create it. The factory holds no funds and keeps no authority over
///         the slots it creates. Linking a slot under its show in the graph is a
///         separate step: the organizer registers the PARENTS / CHILD_OF links
///         and the show's parties confirm them.
contract SupportSlotFactory {

    error ZeroAddress();
    error NotOrganizer();

    address public immutable implementation;

    address[] public allSlots;
    mapping(address => address[]) public slotsOfShow;
    mapping(address => address[]) public userSlots;

    event SupportSlotCreated(
        address indexed slot,
        address indexed parentShow,
        address indexed partyA,
        address partyB,
        uint256 guaranteeAmount
    );

    constructor(address _implementation) {
        if (_implementation == address(0)) revert ZeroAddress();
        implementation = _implementation;
    }

    /// @notice Create a support slot under `init.parentShow`. The caller must
    ///         be the organizer, `init.partyA`.
    function createSupportSlot(SupportSlotAgreement.SlotInit calldata init)
        external
        returns (address slot)
    {
        if (msg.sender != init.partyA) revert NotOrganizer();

        slot = Clones.clone(implementation);
        SupportSlotAgreement(slot).initialize(init);

        allSlots.push(slot);
        slotsOfShow[init.parentShow].push(slot);
        userSlots[init.partyA].push(slot);
        userSlots[init.partyB].push(slot);

        emit SupportSlotCreated(slot, init.parentShow, init.partyA, init.partyB, init.guaranteeAmount);
    }

    function getSlotCount() external view returns (uint256) {
        return allSlots.length;
    }

    function getSlotsOfShow(address show) external view returns (address[] memory) {
        return slotsOfShow[show];
    }

    function getUserSlots(address user) external view returns (address[] memory) {
        return userSlots[user];
    }
}
