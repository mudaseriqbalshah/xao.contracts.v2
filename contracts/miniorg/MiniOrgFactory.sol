// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "../interfaces/IMiniOrg.sol";
import "./MiniOrgWallet.sol";
import "./MiniOrgGrant.sol";

/// @title MiniOrgFactory — creates Mini-Org wallets and the grants that go with them (Phase 2D)
/// @notice The one official source of orgs and grants. An org wallet accepts
///         only grants made here, so no one can attach a look-alike contract
///         that claims a role it was never given. The factory holds no funds
///         and keeps no authority over the orgs it creates.
contract MiniOrgFactory is IMiniOrgGrantRegistry {

    error ZeroAddress();
    error NotAnOrg();
    error NotAuthorized();

    address public immutable walletImplementation;
    address public immutable grantImplementation;
    address public immutable graphRegistry;

    address[] public allOrgs;
    mapping(address => bool) public isMiniOrg;
    mapping(address => bool) public override isOfficialGrant;
    mapping(address => address[]) internal _orgGrants;    // every grant ever made for an org

    event MiniOrgCreated(address indexed org, address indexed creator, bytes32 salt);
    event GrantCreated(address indexed org, address indexed grant, bytes32 indexed grantType, address issuer);

    constructor(address _walletImplementation, address _grantImplementation, address _graphRegistry) {
        if (_walletImplementation == address(0) || _grantImplementation == address(0)) revert ZeroAddress();
        walletImplementation = _walletImplementation;
        grantImplementation  = _grantImplementation;
        graphRegistry        = _graphRegistry;       // optional
    }

    // ─── ORGS ─────────────────────────────────────────────────────────────

    /// @notice Create an org wallet at an address you can know in advance.
    ///         The bootstrap admins attach the first grants and lose all power
    ///         once an owner grant is attached.
    /// @param treasury address(0) means the wallet itself holds the funds.
    function createMiniOrg(
        bytes32 salt,
        address treasury,
        address[] calldata rootAdmins,
        bytes32 metaHash,
        string calldata metaCID
    ) external returns (address org) {
        org = Clones.cloneDeterministic(walletImplementation, _orgSalt(msg.sender, salt));
        MiniOrgWallet(org).initialize(treasury, rootAdmins, metaHash, metaCID, graphRegistry, address(this));

        isMiniOrg[org] = true;
        allOrgs.push(org);
        emit MiniOrgCreated(org, msg.sender, salt);
    }

    /// @notice The address `createMiniOrg` will give `creator` for this salt.
    function predictMiniOrg(address creator, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(walletImplementation, _orgSalt(creator, salt), address(this));
    }

    // ─── GRANTS ───────────────────────────────────────────────────────────

    /// @notice Create a grant for an org. The caller must be allowed to add a
    ///         grant of this type to that org (owners for owner grants; admins
    ///         and owners for the rest; bootstrap admins before any owner).
    ///         Creating a grant does not attach it: call the org's addGrant.
    function createGrant(
        address org,
        bytes32 grantType_,
        uint64 effectiveFrom,
        uint64 effectiveTo,
        bytes32 metaHash,
        string calldata metaCID,
        MiniOrgGrant.RoleAssignment[] calldata assignments
    ) external returns (address grant) {
        if (!isMiniOrg[org]) revert NotAnOrg();
        if (!MiniOrgWallet(org).canManageGrantType(msg.sender, grantType_)) revert NotAuthorized();

        grant = Clones.clone(grantImplementation);
        MiniOrgGrant(grant).initialize(org, msg.sender, grantType_, effectiveFrom, effectiveTo, metaHash, metaCID, assignments);

        isOfficialGrant[grant] = true;
        _orgGrants[org].push(grant);
        emit GrantCreated(org, grant, grantType_, msg.sender);
    }

    // ─── VIEWS ────────────────────────────────────────────────────────────

    function getOrgCount() external view returns (uint256) {
        return allOrgs.length;
    }

    function getOrgGrants(address org) external view returns (address[] memory) {
        return _orgGrants[org];
    }

    function _orgSalt(address creator, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }
}
