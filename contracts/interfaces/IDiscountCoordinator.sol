// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../libraries/DiscountMath.sol";

/// @notice What the discount coordinator asks a show's data module: is this data funder
///         able to stand behind the data it is promised (early-access reserve in place)?
interface IDataGuard {
    function funderBacked(address funder) external view returns (bool);
    /// @notice Send the show's escrow what funders' top-up money has to pay. Coordinator only.
    function payTopUps(address escrow) external;
}

/// @notice The official factory of data modules.
interface IDataModuleFactory {
    function moduleOf(address show) external view returns (address);
}

/// @notice What the data module reads from a show's discount coordinator.
interface IDataSource {
    struct FunderAuthView {
        bool    proposed;
        bool    authorized;
        bool    withdrawn;
        uint32  categoryMask;
        uint256 maxDebit;
        uint256 debited;
    }
    function show() external view returns (address);
    function dataProgramId() external view returns (uint256);
    function getFunders(uint256 programId) external view returns (address[] memory);
    function getFunderAuth(uint256 programId, address funder) external view returns (FunderAuthView memory);
    /// @notice What `funder` was charged for the data `wallet` shared in its order.
    function dataShare(address wallet, address funder) external view returns (uint256);
    /// @notice Raise a data funder's cap by money it has just put into the data module. Module only.
    function raiseDataCap(address funder, uint256 amount) external;
    /// @notice Data discounts beyond the cap a funder signed: to be paid from its top-up money.
    function topUpDebt(address funder) external view returns (uint256);
}

/// @notice What the ticket contract asks a show's discount coordinator.
interface IDiscountCoordinator {
    /// @dev What the buyer chose to share. Empty `grantedMasks` means the buyer declined.
    struct Consent {
        uint32   availableMask;     // the categories the buyer has data for
        uint32[] grantedMasks;      // one per data funder, in roster order: categories shared with that funder
        bytes32  commitment;        // a commitment to the buyer's consent, kept for the data module
    }

    /// @dev What the ticket contract needs to know about a committed sale, one entry per ticket.
    ///      Kept flat on purpose: it is cheap for the ticket contract to read.
    struct Sale {
        uint256[] pricePaid;        // list price less the discounts the ticket got
        uint256[] gas;
        uint256[] fee;              // Xao's fee, worked out on the list price
        uint256[] tax;
        uint256   checkoutTotal;    // what the buyer pays for the whole order
        uint256   discountTotal;
    }

    /// @notice Price an order exactly as `commit` would, and give the hash that identifies the result.
    function quote(
        address wallet,
        uint256[] calldata typeIds,
        uint256[] calldata listPrices,
        uint256 taxBps,
        uint256 feeBps,
        uint256 gasAllotment,
        Consent calldata consent
    ) external view returns (DiscountMath.OrderQuote memory q, bytes32 quoteHash);

    /// @notice Record a sale. Only the show's ticket contract may call it.
    function commit(
        address wallet,
        uint256[] calldata typeIds,
        uint256[] calldata listPrices,
        uint256 taxBps,
        uint256 feeBps,
        uint256 gasAllotment,
        Consent calldata consent,
        bytes32 expectedHash
    ) external returns (Sale memory sale);
}
