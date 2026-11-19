// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../libraries/DiscountMath.sol";

/// @dev Test helper that exposes the ticket price and discount maths.
contract MockDiscountMath {
    function compute(
        uint256 listPrice,
        uint256 net,
        DiscountMath.DataProgram memory data,
        DiscountMath.MemberProgram[] memory members
    ) external pure returns (DiscountMath.Result memory) {
        return DiscountMath.compute(listPrice, net, data, members);
    }

    function breakdown(uint256 listPrice, uint256 taxBps, uint256 feeBps, uint256 gasAllotment)
        external pure returns (DiscountMath.Breakdown memory)
    {
        return DiscountMath.breakdown(listPrice, taxBps, feeBps, gasAllotment);
    }

    function quote(
        uint256 listPrice,
        uint256 taxBps,
        uint256 feeBps,
        uint256 gasAllotment,
        DiscountMath.DataProgram memory data,
        DiscountMath.MemberProgram[] memory members
    ) external pure returns (DiscountMath.Quote memory) {
        return DiscountMath.quote(listPrice, taxBps, feeBps, gasAllotment, data, members);
    }

    function selectTicket(uint256[] memory prices) external pure returns (uint256) {
        return DiscountMath.selectTicket(prices);
    }
}
