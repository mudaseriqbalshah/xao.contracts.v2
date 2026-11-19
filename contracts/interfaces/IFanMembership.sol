// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice What other modules (discounts, perks, ticketing) ask a fan membership
///         program. A program is bound to one issuer and one scope, so none of
///         these calls takes a scope argument.
interface IFanMembership {
    /// @return the org or wallet that issues this program's memberships
    function issuer() external view returns (address);

    /// @notice True if the token exists, has not expired, and its program is not ended.
    function isMembershipActive(uint256 tokenId) external view returns (bool);

    /// @notice True if `holder` holds an active membership. `tierId` 0 means any tier.
    function isHolderActiveMember(address holder, uint256 tierId) external view returns (bool);

    /// @notice True if `holder` holds an active membership whose tier priority is
    ///         at least `minTierPriority` (a higher number is a better tier).
    function hasActiveTier(address holder, uint32 minTierPriority) external view returns (bool);
}
