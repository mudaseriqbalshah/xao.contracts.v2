// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../libraries/DiscountMath.sol";

/// @dev Test helper that exposes the discount maths.
contract MockDiscountMath {
    function compute(
        uint256 listPrice,
        DiscountMath.DataProgram memory data,
        DiscountMath.MemberProgram[] memory members
    ) external pure returns (DiscountMath.Result memory) {
        return DiscountMath.compute(listPrice, data, members);
    }

    function selectTicket(uint256[] memory prices) external pure returns (uint256) {
        return DiscountMath.selectTicket(prices);
    }

    function feeOnNet(uint256 netPrice, uint256 feeBps) external pure returns (uint256) {
        return DiscountMath.feeOnNet(netPrice, feeBps);
    }
}
