// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../libraries/DiscountMath.sol";

/// @dev Test helper that exposes the order-level discount maths.
contract MockDiscountMathOrder {
    function allocate(
        DiscountMath.OrderItem[] memory items,
        DiscountMath.DataOffer memory data,
        DiscountMath.MemberOffer[] memory members
    ) external pure returns (DiscountMath.OrderResult memory) {
        return DiscountMath.allocate(items, data, members);
    }

    function quoteOrder(
        uint256[] memory typeIds,
        uint256[] memory listPrices,
        uint256 taxBps,
        uint256 feeBps,
        uint256 gasAllotment,
        DiscountMath.DataOffer memory data,
        DiscountMath.MemberOffer[] memory members
    ) external pure returns (DiscountMath.OrderQuote memory) {
        return DiscountMath.quoteOrder(typeIds, listPrices, taxBps, feeBps, gasAllotment, data, members);
    }
}
