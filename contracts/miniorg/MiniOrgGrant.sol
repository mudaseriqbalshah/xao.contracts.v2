// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IMiniOrg.sol";
import "../libraries/XaoRoles.sol";

/// @title MiniOrgGrant — one membership / role certificate for a Mini-Org (Phase 2D)
/// @notice Binds to exactly one org wallet and gives roles to a few addresses.
///         Assignments never change after creation: to change someone's role,
///         end this grant and attach a new one. It can be timeboxed (trial
///         members, touring musicians) and ended early.
/// @dev Deployed as a minimal-proxy clone by MiniOrgFactory.
///
///      Owner grants (the ones that confer ROLE_OWNER) are deliberately
///      stricter than the spec so an org can never lose its last owner:
///        - they must be permanent: no start delay, no end date, no per-role expiry;
///        - they cannot be ended here at all. They end only through the org
///          wallet's disableGrant, which refuses to remove the last owner.
contract MiniOrgGrant is IMiniOrgGrant {

    error AlreadyInitialized();
    error ZeroOrg();
    error ZeroIssuer();
    error InvalidGrantType();
    error InvalidEffectiveWindow();
    error NoAssignments();
    error TooManyAssignments();
    error ZeroUser();
    error InvalidRole();
    error OwnerRoleNeedsOwnerGrant();
    error OwnerGrantNeedsOwnerRole();
    error OwnerGrantMustBePermanent();
    error OwnerGrantsEndThroughTheWallet();
    error NotAuthorized();
    error AlreadyRevoked();

    struct RoleAssignment {
        address user;
        bytes32 role;
        uint64  expiresAt;      // 0 = no per-role expiry
    }

    uint256 public constant MAX_ASSIGNMENTS = 20;

    // ─── STATE ────────────────────────────────────────────────────────────
    address public override org;
    address public issuer;              // who created it; a record only, it carries no power
    bytes32 internal _grantType;
    bool    public active;
    uint64  public effectiveFrom;       // 0 = from the start
    uint64  public effectiveTo;         // 0 = no end date
    bytes32 public grantMetaHash;
    string  public grantMetaCID;
    bool    public initialized;

    mapping(address => mapping(bytes32 => bool))   internal _roleGranted;
    mapping(address => mapping(bytes32 => uint64)) internal _roleExpiry;
    address[] internal _assignees;
    mapping(address => bool) internal _isAssignee;

    // ─── EVENTS ───────────────────────────────────────────────────────────
    event GrantInitialized(
        address indexed org,
        address indexed issuer,
        bytes32 grantType,
        uint64 effectiveFrom,
        uint64 effectiveTo,
        bytes32 grantMetaHash,
        string grantMetaCID
    );
    event RoleAssigned(address indexed user, bytes32 indexed role, uint64 expiresAt);
    event GrantRevoked(address indexed by);

    /// @dev Locks the implementation; only clones can be initialized.
    constructor() {
        initialized = true;
    }

    function initialize(
        address _org,
        address _issuer,
        bytes32 grantType_,
        uint64 _effectiveFrom,
        uint64 _effectiveTo,
        bytes32 _grantMetaHash,
        string calldata _grantMetaCID,
        RoleAssignment[] calldata assignments
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (_org == address(0)) revert ZeroOrg();
        if (_issuer == address(0)) revert ZeroIssuer();
        if (!XaoRoles.isGrantType(grantType_)) revert InvalidGrantType();
        if (_effectiveTo != 0 && _effectiveTo <= _effectiveFrom) revert InvalidEffectiveWindow();
        if (assignments.length == 0) revert NoAssignments();
        if (assignments.length > MAX_ASSIGNMENTS) revert TooManyAssignments();

        bool isOwnerGrant = grantType_ == XaoRoles.OWNER_GRANT;
        if (isOwnerGrant && (_effectiveFrom != 0 || _effectiveTo != 0)) revert OwnerGrantMustBePermanent();

        initialized   = true;
        org           = _org;
        issuer        = _issuer;
        _grantType    = grantType_;
        active        = true;
        effectiveFrom = _effectiveFrom;
        effectiveTo   = _effectiveTo;
        grantMetaHash = _grantMetaHash;
        grantMetaCID  = _grantMetaCID;

        emit GrantInitialized(_org, _issuer, grantType_, _effectiveFrom, _effectiveTo, _grantMetaHash, _grantMetaCID);

        bool hasOwnerRole;
        for (uint256 i = 0; i < assignments.length; i++) {
            RoleAssignment calldata a = assignments[i];
            if (a.user == address(0)) revert ZeroUser();
            if (!XaoRoles.isRole(a.role)) revert InvalidRole();

            if (a.role == XaoRoles.ROLE_OWNER) {
                if (!isOwnerGrant) revert OwnerRoleNeedsOwnerGrant();
                hasOwnerRole = true;
            }
            if (isOwnerGrant && a.expiresAt != 0) revert OwnerGrantMustBePermanent();

            _roleGranted[a.user][a.role] = true;
            _roleExpiry[a.user][a.role]  = a.expiresAt;
            if (!_isAssignee[a.user]) {
                _isAssignee[a.user] = true;
                _assignees.push(a.user);
            }
            emit RoleAssigned(a.user, a.role, a.expiresAt);
        }
        if (isOwnerGrant && !hasOwnerRole) revert OwnerGrantNeedsOwnerRole();
    }

    // ─── VIEWS ────────────────────────────────────────────────────────────

    function grantType() external view override returns (bytes32) {
        return _grantType;
    }

    /// @notice Active only while not revoked and inside its time window.
    function isActive() public view override returns (bool) {
        if (!active) return false;
        if (effectiveFrom != 0 && block.timestamp < effectiveFrom) return false;
        if (effectiveTo != 0 && block.timestamp > effectiveTo) return false;
        return true;
    }

    function hasRole(address user, bytes32 role) external view override returns (bool) {
        if (!isActive() || !_roleGranted[user][role]) return false;
        uint64 exp = _roleExpiry[user][role];
        return exp == 0 || block.timestamp <= exp;
    }

    function getAssignees() external view returns (address[] memory) {
        return _assignees;
    }

    // ─── ENDING THE GRANT ─────────────────────────────────────────────────

    /// @notice Ends the grant immediately. For anything but an owner grant, the
    ///         caller must be able to manage non-owner grants in the org (an
    ///         admin, an owner, or a bootstrap admin before any owner exists).
    ///         Owner grants cannot be ended here; use the wallet's disableGrant,
    ///         which keeps at least one owner.
    function revoke() external {
        if (_grantType == XaoRoles.OWNER_GRANT) revert OwnerGrantsEndThroughTheWallet();
        if (!active) revert AlreadyRevoked();
        if (!IMiniOrgWallet(org).canManageNonOwnerGrants(msg.sender)) revert NotAuthorized();

        active = false;
        emit GrantRevoked(msg.sender);
    }
}
