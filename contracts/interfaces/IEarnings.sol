// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice The money categories shared by every contract that pays earnings
///         and by standing agreements, so a split can be looked up by the same
///         number on both sides. A StandingAgreement's splits are kept per
///         stream; a payer records what it paid under the same stream.
enum Stream { Guarantee, TicketRevenue, MerchRevenue, BarRevenue, SponsorshipRevenue, Other }

/// @notice Implemented by a contract that pays out earnings, such as a show's
///         escrow now and a merch or bar contract later. A wallet that applies
///         standing agreements asks the payer what it earned, instead of
///         trusting a label from whoever holds the money. Money moved into a
///         wallet by its owner, or sent by anything that is not a payer, is
///         never recorded, so it is never split.
interface IEarningsSource {
    /// @notice The total `recipient` has earned from this contract under
    ///         `stream`. Counted when the payment is made, or when it is held for
    ///         the recipient to claim because the token refused it. It is what was
    ///         earned, not what is in the recipient's wallet now.
    function earnedBy(address recipient, Stream stream) external view returns (uint256);
}
