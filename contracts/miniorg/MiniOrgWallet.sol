// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IMiniOrg.sol";
import "../interfaces/IGraphAuthorizer.sol";
import "../libraries/XaoRoles.sol";

/// @title MiniOrgWallet — the on-chain identity and membership hub of a band, venue, promoter or crew (Phase 2D)
/// @notice This address is the org's identity: it can be partyA or partyB of
///         shows, tours and standing agreements. Who may act for it is decided
///         by the grant contracts attached to it. This first part holds the
///         identity, the grant registry and the permission checks; acting as a
///         party (signing, funding) and the treasury controls come next.
/// @dev Deployed as a minimal-proxy clone by MiniOrgFactory.
///
///      Rules (client-confirmed):
///        - Only owners add or end owner grants. Admins manage everything else.
///        - Several owners are allowed. The last owner grant can never be ended.
///        - Bootstrap admins can attach the first grants, and lose all power the
///          moment the first owner grant is attached.
///
///      Deviations from the written spec, to keep the above true:
///        - Only grants made by the official factory can be attached, so a fake
///          grant cannot claim a role it does not have.
///        - At most MAX_GRANTS grants are attached at once, so permission
///          checks cannot run out of gas.
///        - Owner grants are permanent and end only here (see MiniOrgGrant).
contract MiniOrgWallet is IMiniOrgWallet, IGraphAuthorizer {

    error AlreadyInitialized();
    error ZeroAddress();
    error NoRootAdmins();
    error TooManyRootAdmins();
    error NotAuthorized();
    error NotAnOfficialGrant();
    error WrongOrg();
    error GrantAlreadyAttached();
    error GrantNotAttached();
    error TooManyGrants();
    error CannotEndLastOwner();

    uint256 public constant MAX_GRANTS      = 50;
    uint256 public constant MAX_ROOT_ADMINS = 10;

    // ─── STATE ────────────────────────────────────────────────────────────
    address public treasury;            // where the org's funds live: this contract, or an external Safe
    address public graphRegistry;       // optional
    address public grantRegistry;       // the factory whose grants this wallet accepts
    bytes32 public orgMetaHash;
    string  public orgMetaCID;

    address[] internal _grants;                    // attached grants only
    mapping(address => uint256) internal _grantSlot;   // index + 1; 0 = not attached
    uint256 public ownerGrantCount;                // attached grants of type OWNER_GRANT

    mapping(address => bool) public rootAdmins;
    bool public bootstrapMode;                     // true until the first owner grant is attached
    bool public initialized;

    // ─── EVENTS ───────────────────────────────────────────────────────────
    event MiniOrgInitialized(address treasury, bytes32 orgMetaHash, string orgMetaCID, bool bootstrapMode);
    event TreasuryUpdated(address indexed newTreasury);
    event RootAdminSet(address indexed admin, bool allowed);
    event BootstrapModeEnded();
    event GrantAdded(address indexed grant, bytes32 grantType);
    event GrantDisabled(address indexed grant);

    /// @dev Locks the implementation; only clones can be initialized.
    constructor() {
        initialized = true;
    }

    /// @param initialTreasury address(0) means this contract holds the funds.
    function initialize(
        address initialTreasury,
        address[] calldata initialRootAdmins,
        bytes32 _orgMetaHash,
        string calldata _orgMetaCID,
        address _graphRegistry,
        address _grantRegistry
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (_grantRegistry == address(0)) revert ZeroAddress();
        if (initialRootAdmins.length == 0) revert NoRootAdmins();
        if (initialRootAdmins.length > MAX_ROOT_ADMINS) revert TooManyRootAdmins();

        initialized   = true;
        treasury      = initialTreasury == address(0) ? address(this) : initialTreasury;
        orgMetaHash   = _orgMetaHash;
        orgMetaCID    = _orgMetaCID;
        graphRegistry = _graphRegistry;
        grantRegistry = _grantRegistry;
        bootstrapMode = true;

        for (uint256 i = 0; i < initialRootAdmins.length; i++) {
            address a = initialRootAdmins[i];
            if (a == address(0)) revert ZeroAddress();
            rootAdmins[a] = true;
            emit RootAdminSet(a, true);
        }

        emit MiniOrgInitialized(treasury, _orgMetaHash, _orgMetaCID, true);
    }

    // ─── PERMISSION QUERIES ───────────────────────────────────────────────

    /// @notice True if any attached, active grant gives `user` this role.
    function hasRole(address user, bytes32 role) public view override returns (bool) {
        uint256 n = _grants.length;
        for (uint256 i = 0; i < n; i++) {
            if (IMiniOrgGrant(_grants[i]).hasRole(user, role)) return true;
        }
        return false;
    }

    function isOwner(address user)     external view returns (bool) { return hasRole(user, XaoRoles.ROLE_OWNER); }
    function isAdmin(address user)     external view returns (bool) { return hasRole(user, XaoRoles.ROLE_ADMIN); }
    function isTreasurer(address user) external view returns (bool) { return hasRole(user, XaoRoles.ROLE_TREASURER); }
    function isOperator(address user)  external view returns (bool) { return hasRole(user, XaoRoles.ROLE_OPERATOR); }
    function isMember(address user)    external view returns (bool) { return hasRole(user, XaoRoles.ROLE_MEMBER); }

    /// @notice Owners, admins and operators may register and confirm graph
    ///         edges for this org.
    function isGraphOperator(address op) external view override(IMiniOrgWallet, IGraphAuthorizer) returns (bool) {
        return hasRole(op, XaoRoles.ROLE_OWNER)
            || hasRole(op, XaoRoles.ROLE_ADMIN)
            || hasRole(op, XaoRoles.ROLE_OPERATOR);
    }

    /// @notice Admins and owners manage every grant except owner grants; so do
    ///         the bootstrap admins until the first owner exists.
    function canManageNonOwnerGrants(address caller) public view override returns (bool) {
        return (bootstrapMode && rootAdmins[caller])
            || hasRole(caller, XaoRoles.ROLE_ADMIN)
            || hasRole(caller, XaoRoles.ROLE_OWNER);
    }

    /// @notice Only owners manage owner grants; before any owner exists, the
    ///         bootstrap admins attach the first one.
    function canManageOwnerGrants(address caller) public view override returns (bool) {
        return hasRole(caller, XaoRoles.ROLE_OWNER) || (bootstrapMode && rootAdmins[caller]);
    }

    /// @notice Whether `caller` may add a grant of this type to the org.
    function canManageGrantType(address caller, bytes32 grantType_) public view returns (bool) {
        return grantType_ == XaoRoles.OWNER_GRANT
            ? canManageOwnerGrants(caller)
            : canManageNonOwnerGrants(caller);
    }

    // ─── GRANT MANAGEMENT ─────────────────────────────────────────────────

    /// @notice Attach a grant made by the official factory for this org.
    function addGrant(address grant) external {
        if (!IMiniOrgGrantRegistry(grantRegistry).isOfficialGrant(grant)) revert NotAnOfficialGrant();
        if (IMiniOrgGrant(grant).org() != address(this)) revert WrongOrg();
        if (_grantSlot[grant] != 0) revert GrantAlreadyAttached();

        bytes32 gType = IMiniOrgGrant(grant).grantType();
        if (!canManageGrantType(msg.sender, gType)) revert NotAuthorized();
        if (_grants.length >= MAX_GRANTS) revert TooManyGrants();

        _grants.push(grant);
        _grantSlot[grant] = _grants.length;
        emit GrantAdded(grant, gType);

        if (gType == XaoRoles.OWNER_GRANT) {
            ownerGrantCount++;
            if (bootstrapMode) {
                bootstrapMode = false;
                emit BootstrapModeEnded();
            }
        }
    }

    /// @notice Detach a grant: its authority stops at once. An owner grant can
    ///         be detached only by an owner, and never if it is the last one.
    function disableGrant(address grant) external {
        uint256 slot = _grantSlot[grant];
        if (slot == 0) revert GrantNotAttached();

        bool isOwnerGrant = IMiniOrgGrant(grant).grantType() == XaoRoles.OWNER_GRANT;
        bool allowed = isOwnerGrant ? canManageOwnerGrants(msg.sender) : canManageNonOwnerGrants(msg.sender);
        if (!allowed) revert NotAuthorized();
        if (isOwnerGrant) {
            if (ownerGrantCount <= 1) revert CannotEndLastOwner();
            ownerGrantCount--;
        }

        // Swap-and-pop keeps the list short, so permission checks stay cheap.
        uint256 last = _grants.length;
        if (slot != last) {
            address moved = _grants[last - 1];
            _grants[slot - 1] = moved;
            _grantSlot[moved] = slot;
        }
        _grants.pop();
        delete _grantSlot[grant];

        emit GrantDisabled(grant);
    }

    function isGrantEnabled(address grant) external view returns (bool) {
        return _grantSlot[grant] != 0;
    }

    function getGrants() external view returns (address[] memory) {
        return _grants;
    }

    function grantCount() external view returns (uint256) {
        return _grants.length;
    }

    // ─── TREASURY POINTER ─────────────────────────────────────────────────

    /// @notice Point the org at a different treasury (this contract or a Safe).
    ///         Shows already created keep paying the address they were made with.
    function setTreasury(address newTreasury) external {
        if (!canManageOwnerGrants(msg.sender)) revert NotAuthorized();
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }
}
