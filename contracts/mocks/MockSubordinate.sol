// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IShowBundle.sol";

/// @dev Test stand-in for a subordinate agreement that is not a real support
///      slot. It claims to belong to a show and tries to pull earmarked money.
contract MockSubordinate is ISubordinateLike {
    address public override parentShow;
    address public override parentEscrow;

    constructor(address _parentShow, address _parentEscrow) {
        parentShow = _parentShow;
        parentEscrow = _parentEscrow;
    }

    function onReserved(uint256) external override {}

    function drain(address recipient, uint256 amount) external {
        IEventEscrowLike(parentEscrow).settleSubordinate(recipient, amount);
    }
}
