// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IPerkModule.sol";
import "../interfaces/IFanMembership.sol";
import "../interfaces/IGraphParties.sol";
import "../interfaces/IMiniOrg.sol";
import "../libraries/XaoRoles.sol";

interface IPerkTicket {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @dev What the module asks a show it is scoped to.
interface IPerkShow {
    function status() external view returns (uint8);        // 3 InDispute, 5 Cancelled
}

/// @title PerkModule — who gets which benefit, and what it is worth (Phase 2F)
/// @notice A module bound to one issuer and one scope (a show, a tour, a venue, an
///         artist or a campaign). Each perk is a plain rule: a benefit, who
///         qualifies, when it runs, and how often it can be used. The module only
///         decides and records; other contracts apply the benefit (ticketing for
///         presale, a point of sale for discounts, an app for badges, a minting
///         contract for rewards).
///
///         Perks never go stale: whether a wallet qualifies is checked live every
///         time. A membership that has ended, a ticket that was refunded, or an NFT
///         that was moved on stops the perk at once, with nothing to revoke. A module
///         scoped to a show also stops while that show is cancelled (from the moment
///         its refunds begin) or in dispute; what was already claimed stays claimed.
///
///         Ticket price discounts are NOT here. They are funded by the parties
///         that offer them and live in the discount program (DiscountMath).
/// @dev Deployed as a minimal-proxy clone by PerkModuleFactory.
///
///      Who may do what. The issuer is a plain address or a Mini-Org wallet:
///        - managers (the issuer, or an owner or admin of the issuer org): create
///          and pause perks, and name the executors that may record redemptions.
///        - operators (managers, plus an operator of the issuer org): hand a perk
///          to a wallet directly.
///        - executors (named by a manager): record that a perk was used, for
///          example a point of sale. A manager can do it too.
///        - a wallet claims its own rewards.
///
///      NFT_HOLD asks only whether the wallet holds any token of a collection now, so
///      a single-use or claim-once perk on it can be taken again by another wallet the
///      token is moved to; use it for passive perks, or cap the uses.
///
///      Left out: attendance-based and reputation eligibility, combining several
///      conditions in one perk, claims per cycle, per-purchase use, stacking beyond
///      "best of".
///
///      Implements IGraphParties (issuer as partyA) so GraphRegistry treats the
///      issuer, and an issuer org's operators, as authorized on this node.
contract PerkModule is IPerkModule, IGraphParties {

    error AlreadyInitialized();
    error ZeroIssuer();
    error ZeroScopeRef();
    error NotManager();
    error NotOperator();
    error NotExecutor();
    error UnknownPerk();
    error TooManyPerks();
    error InvalidWindow();
    error InvalidBenefit();
    error InvalidEligibility();
    error InvalidMode();
    error NotRedeemable();
    error NotClaimable();
    error NotEligible(EligibilityReason reason);
    error EventRefRequired();
    error ZeroWallet();
    error NothingToChange();
    error TooManyIds();

    enum ScopeType { SHOW, TOUR, VENUE, ARTIST, CAMPAIGN }
    enum PerkType { PRESALE_ACCESS, EVENT_ACCESS, POS_DISCOUNT, CLAIMABLE_REWARD, VOUCHER, BADGE }
    enum EligibilityType { MEMBERSHIP, TICKET_WINDOW, DIRECT_GRANT, NFT_HOLD }
    enum RedemptionMode { PASSIVE_CHECK, SINGLE_USE, PER_EVENT, CLAIM_ONCE }
    enum PerkState { ACTIVE, SUSPENDED, ARCHIVED }

    enum EligibilityReason {
        Eligible, UnknownPerk, NotActive, NotStarted, Ended,
        NotMember, NoQualifyingTicket, NoGrant, AlreadyUsed, CapReached,
        NotHolder, EventOff
    }

    struct ModuleInit {
        address   issuer;
        ScopeType scopeType;
        address   scopeRef;          // the show, tour, venue, artist or campaign these perks belong to
        string    metadataURI;
    }

    struct PerkInput {
        PerkType        perkType;
        EligibilityType eligibilityType;
        address         eligibilityRef;     // MEMBERSHIP: the membership program. TICKET_WINDOW: the ticket contract. NFT_HOLD: the collection
        uint32          minTierPriority;    // MEMBERSHIP: lowest tier priority that qualifies, 0 = any member
        uint64          windowFrom;         // TICKET_WINDOW: the ticket must have been bought from here ...
        uint64          windowTo;           // ... to here (0 = no end)
        uint256         benefitValue;       // POS_DISCOUNT: minor units, or basis points when isPercent
        bool            isPercent;
        bytes32         benefitTarget;      // what it applies to or yields: an item, a ticket type, a reward ...
        uint64          startTime;          // perk runs from here (0 = from now) ...
        uint64          endTime;            // ... to here (0 = no end)
        RedemptionMode  mode;
        uint32          maxUsesGlobal;      // 0 = no limit; counts recorded uses and claims
        string          metadataURI;
    }

    struct Perk {
        PerkType        perkType;
        EligibilityType eligibilityType;
        address         eligibilityRef;
        uint32          minTierPriority;
        uint64          windowFrom;
        uint64          windowTo;
        uint256         benefitValue;
        bool            isPercent;
        bytes32         benefitTarget;
        uint64          startTime;
        uint64          endTime;
        RedemptionMode  mode;
        uint32          maxUsesGlobal;
        uint32          usesGlobal;
        PerkState       state;
        string          metadataURI;
    }

    struct WalletPerkStatus {
        EligibilityReason reason;       // Eligible, or why not
        bool              usedByWallet; // a single-use or claim-once perk this wallet has already used
        uint32            usesGlobal;
        uint32            usesLeft;     // 0 together with maxUsesGlobal == 0 means no limit
    }

    uint256 public constant MAX_PERKS = 200;
    uint256 public constant MAX_IDS_PER_CALL = 50;
    uint256 private constant BPS = 10_000;

    // ─── STATE ────────────────────────────────────────────────────────────
    address   public override issuer;
    ScopeType public scopeType;
    address   public scopeRef;
    string    public metadataURI;
    bool      public initialized;

    uint256 public perkCount;
    mapping(uint256 => Perk) internal _perks;

    mapping(address => bool) public isExecutor;
    mapping(uint256 => mapping(address => bool)) public directGrant;            // perkId => wallet
    mapping(uint256 => mapping(address => bool)) public usedByWallet;           // single-use and claim-once perks
    mapping(uint256 => mapping(address => mapping(bytes32 => bool))) public usedForEvent;
    mapping(uint256 => mapping(address => uint32)) public walletUses;

    // ─── EVENTS ───────────────────────────────────────────────────────────
    event PerkModuleCreated(address indexed issuer, ScopeType scopeType, address indexed scopeRef, string metadataURI);
    event PerkCreated(uint256 indexed perkId, PerkType perkType, EligibilityType eligibilityType, address eligibilityRef, RedemptionMode mode);
    event PerkUpdated(uint256 indexed perkId);
    event PerkActivated(uint256 indexed perkId);
    event PerkDeactivated(uint256 indexed perkId);
    event PerkArchived(uint256 indexed perkId);
    event PerkGranted(uint256 indexed perkId, address indexed wallet, address indexed by);
    event PerkGrantRevoked(uint256 indexed perkId, address indexed wallet, address indexed by);
    event PerkRedeemed(uint256 indexed perkId, address indexed wallet, bytes32 eventRef, address indexed by);
    event RewardClaimed(uint256 indexed perkId, address indexed wallet, address recipient, bytes32 benefitTarget);
    event ExecutorSet(address indexed executor, bool allowed);

    modifier onlyManager() {
        if (!_isManager(msg.sender)) revert NotManager();
        _;
    }

    /// @dev Locks the implementation; only clones can be initialized.
    constructor() {
        initialized = true;
    }

    function initialize(ModuleInit calldata m) external {
        if (initialized) revert AlreadyInitialized();
        if (m.issuer == address(0)) revert ZeroIssuer();
        if (m.scopeRef == address(0)) revert ZeroScopeRef();

        initialized = true;
        issuer      = m.issuer;
        scopeType   = m.scopeType;
        scopeRef    = m.scopeRef;
        metadataURI = m.metadataURI;

        emit PerkModuleCreated(m.issuer, m.scopeType, m.scopeRef, m.metadataURI);
    }

    // ─── PERK SETUP (managers) ────────────────────────────────────────────

    function createPerk(PerkInput calldata p) external onlyManager returns (uint256 perkId) {
        if (perkCount >= MAX_PERKS) revert TooManyPerks();
        _validate(p);

        perkId = ++perkCount;
        _perks[perkId] = Perk({
            perkType:        p.perkType,
            eligibilityType: p.eligibilityType,
            eligibilityRef:  p.eligibilityRef,
            minTierPriority: p.minTierPriority,
            windowFrom:      p.windowFrom,
            windowTo:        p.windowTo,
            benefitValue:    p.benefitValue,
            isPercent:       p.isPercent,
            benefitTarget:   p.benefitTarget,
            startTime:       p.startTime,
            endTime:         p.endTime,
            mode:            p.mode,
            maxUsesGlobal:   p.maxUsesGlobal,
            usesGlobal:      0,
            state:           PerkState.ACTIVE,
            metadataURI:     p.metadataURI
        });
        emit PerkCreated(perkId, p.perkType, p.eligibilityType, p.eligibilityRef, p.mode);
    }

    /// @notice Only the text and the end of a perk can change: what it is, who
    ///         qualifies and how it is used stay as people saw them.
    function updatePerk(uint256 perkId, string calldata newMetadataURI, uint64 newEndTime) external onlyManager {
        Perk storage p = _perk(perkId);
        if (newEndTime != 0 && newEndTime <= p.startTime) revert InvalidWindow();
        p.metadataURI = newMetadataURI;
        p.endTime = newEndTime;
        emit PerkUpdated(perkId);
    }

    /// @notice Pause or resume a perk. An archived perk is gone for good.
    function setPerkActive(uint256 perkId, bool active) external onlyManager {
        Perk storage p = _perk(perkId);
        if (p.state == PerkState.ARCHIVED) revert NothingToChange();
        PerkState next = active ? PerkState.ACTIVE : PerkState.SUSPENDED;
        if (p.state == next) revert NothingToChange();
        p.state = next;
        if (active) emit PerkActivated(perkId); else emit PerkDeactivated(perkId);
    }

    function archivePerk(uint256 perkId) external onlyManager {
        Perk storage p = _perk(perkId);
        if (p.state == PerkState.ARCHIVED) revert NothingToChange();
        p.state = PerkState.ARCHIVED;
        emit PerkArchived(perkId);
    }

    function setExecutor(address executor, bool allowed) external onlyManager {
        isExecutor[executor] = allowed;
        emit ExecutorSet(executor, allowed);
    }

    // ─── DIRECT GRANTS (operators) ────────────────────────────────────────

    /// @notice Give a wallet a perk whose eligibility is DIRECT_GRANT.
    function grantPerk(uint256 perkId, address wallet) external {
        if (!_isOperator(msg.sender)) revert NotOperator();
        if (wallet == address(0)) revert ZeroWallet();
        Perk storage p = _perk(perkId);
        if (p.eligibilityType != EligibilityType.DIRECT_GRANT) revert InvalidEligibility();
        if (directGrant[perkId][wallet]) revert NothingToChange();
        directGrant[perkId][wallet] = true;
        emit PerkGranted(perkId, wallet, msg.sender);
    }

    function revokeGrant(uint256 perkId, address wallet) external {
        if (!_isOperator(msg.sender)) revert NotOperator();
        _perk(perkId);
        if (!directGrant[perkId][wallet]) revert NothingToChange();
        directGrant[perkId][wallet] = false;
        emit PerkGrantRevoked(perkId, wallet, msg.sender);
    }

    // ─── ELIGIBILITY ──────────────────────────────────────────────────────

    /// @notice Whether the wallet qualifies, and if not, why. Checked live.
    function eligibility(address wallet, uint256 perkId, PerkContext calldata ctx) public view returns (EligibilityReason) {
        if (perkId == 0 || perkId > perkCount) return EligibilityReason.UnknownPerk;
        Perk storage p = _perks[perkId];

        if (p.state != PerkState.ACTIVE) return EligibilityReason.NotActive;
        if (block.timestamp < p.startTime) return EligibilityReason.NotStarted;
        if (p.endTime != 0 && block.timestamp > p.endTime) return EligibilityReason.Ended;
        if (_eventOff()) return EligibilityReason.EventOff;

        if (p.eligibilityType == EligibilityType.MEMBERSHIP) {
            if (!_isMember(p.eligibilityRef, wallet, p.minTierPriority)) return EligibilityReason.NotMember;
        } else if (p.eligibilityType == EligibilityType.TICKET_WINDOW) {
            if (!_boughtTicketInWindow(p, wallet, ctx.ticketTokenId)) return EligibilityReason.NoQualifyingTicket;
        } else if (p.eligibilityType == EligibilityType.NFT_HOLD) {
            if (!_holdsToken(p.eligibilityRef, wallet)) return EligibilityReason.NotHolder;
        } else if (!directGrant[perkId][wallet]) {
            return EligibilityReason.NoGrant;
        }

        if (p.mode == RedemptionMode.SINGLE_USE || p.mode == RedemptionMode.CLAIM_ONCE) {
            if (usedByWallet[perkId][wallet]) return EligibilityReason.AlreadyUsed;
        } else if (p.mode == RedemptionMode.PER_EVENT && ctx.eventRef != bytes32(0)) {
            if (usedForEvent[perkId][wallet][ctx.eventRef]) return EligibilityReason.AlreadyUsed;
        }
        if (p.maxUsesGlobal != 0 && p.usesGlobal >= p.maxUsesGlobal) return EligibilityReason.CapReached;

        return EligibilityReason.Eligible;
    }

    function isEligible(address wallet, uint256 perkId, PerkContext calldata ctx) public view override returns (bool) {
        return eligibility(wallet, perkId, ctx) == EligibilityReason.Eligible;
    }

    // ─── BENEFITS ─────────────────────────────────────────────────────────

    function hasPresaleAccess(address wallet, uint256 perkId, PerkContext calldata ctx) external view override returns (bool) {
        return _is(perkId, PerkType.PRESALE_ACCESS) && isEligible(wallet, perkId, ctx);
    }

    function hasAccess(address wallet, uint256 perkId, PerkContext calldata ctx) external view override returns (bool) {
        return _is(perkId, PerkType.EVENT_ACCESS) && isEligible(wallet, perkId, ctx);
    }

    function hasStatus(address wallet, uint256 perkId, PerkContext calldata ctx) external view override returns (bool) {
        return _is(perkId, PerkType.BADGE) && isEligible(wallet, perkId, ctx);
    }

    function canClaim(address wallet, uint256 perkId, PerkContext calldata ctx) external view override returns (bool) {
        return _is(perkId, PerkType.CLAIMABLE_REWARD) && isEligible(wallet, perkId, ctx);
    }

    function getPOSDiscount(address wallet, uint256 perkId, uint256 price, PerkContext calldata ctx)
        public view override returns (uint256)
    {
        if (!_is(perkId, PerkType.POS_DISCOUNT) || !isEligible(wallet, perkId, ctx)) return 0;
        Perk storage p = _perks[perkId];
        uint256 amount = p.isPercent ? price * p.benefitValue / BPS : p.benefitValue;
        return amount > price ? price : amount;
    }

    /// @notice The best POS discount among several perks, never their sum.
    function getBestPOSDiscount(address wallet, uint256[] calldata perkIds, uint256 price, PerkContext calldata ctx)
        external view returns (uint256 best, uint256 bestPerkId)
    {
        if (perkIds.length > MAX_IDS_PER_CALL) revert TooManyIds();
        for (uint256 i = 0; i < perkIds.length; i++) {
            uint256 amount = getPOSDiscount(wallet, perkIds[i], price, ctx);
            if (amount > best) {
                best = amount;
                bestPerkId = perkIds[i];
            }
        }
    }

    // ─── USING A PERK ─────────────────────────────────────────────────────

    /// @notice Record that a perk was used. Executors and managers only, so a
    ///         wallet cannot use up its own perk by accident and a point of sale
    ///         can. Passive perks are never recorded; claim-once perks are claimed.
    function redeemPerk(uint256 perkId, address wallet, PerkContext calldata ctx) external {
        if (!isExecutor[msg.sender] && !_isManager(msg.sender)) revert NotExecutor();
        EligibilityReason reason = eligibility(wallet, perkId, ctx);
        if (reason != EligibilityReason.Eligible) revert NotEligible(reason);

        Perk storage p = _perks[perkId];
        if (p.mode == RedemptionMode.SINGLE_USE) {
            usedByWallet[perkId][wallet] = true;
        } else if (p.mode == RedemptionMode.PER_EVENT) {
            if (ctx.eventRef == bytes32(0)) revert EventRefRequired();
            usedForEvent[perkId][wallet][ctx.eventRef] = true;
        } else {
            revert NotRedeemable();
        }
        _recordUse(p, perkId, wallet);
        emit PerkRedeemed(perkId, wallet, ctx.eventRef, msg.sender);
    }

    /// @notice A wallet claims its own reward. The module records the claim;
    ///         whatever is minted or sent to `recipient` is done by the contract
    ///         that listens for RewardClaimed.
    function claimReward(uint256 perkId, address recipient, PerkContext calldata ctx) external {
        if (recipient == address(0)) revert ZeroWallet();
        Perk storage p = _perk(perkId);
        if (p.perkType != PerkType.CLAIMABLE_REWARD) revert NotClaimable();

        EligibilityReason reason = eligibility(msg.sender, perkId, ctx);
        if (reason != EligibilityReason.Eligible) revert NotEligible(reason);

        usedByWallet[perkId][msg.sender] = true;
        _recordUse(p, perkId, msg.sender);
        emit RewardClaimed(perkId, msg.sender, recipient, p.benefitTarget);
    }

    // ─── QUERIES ──────────────────────────────────────────────────────────

    function getPerk(uint256 perkId) external view returns (Perk memory) {
        return _perk(perkId);
    }

    function getWalletPerkStatus(address wallet, uint256 perkId, PerkContext calldata ctx)
        external view returns (WalletPerkStatus memory s)
    {
        s.reason = eligibility(wallet, perkId, ctx);
        if (s.reason == EligibilityReason.UnknownPerk) return s;
        Perk storage p = _perks[perkId];
        s.usedByWallet = usedByWallet[perkId][wallet];
        s.usesGlobal   = p.usesGlobal;
        s.usesLeft     = p.maxUsesGlobal == 0 ? 0 : (p.usesGlobal >= p.maxUsesGlobal ? 0 : p.maxUsesGlobal - p.usesGlobal);
    }

    /// @notice Every perk the wallet qualifies for right now, for an app to show.
    function getWalletActivePerks(address wallet, PerkContext calldata ctx) external view returns (uint256[] memory ids) {
        uint256[] memory tmp = new uint256[](perkCount);
        uint256 n;
        for (uint256 i = 1; i <= perkCount; i++) {
            if (eligibility(wallet, i, ctx) == EligibilityReason.Eligible) tmp[n++] = i;
        }
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) ids[i] = tmp[i];
    }

    /// @notice Perks that are switched on and inside their dates, whoever asks.
    function getActivePerks() external view returns (uint256[] memory ids) {
        uint256[] memory tmp = new uint256[](perkCount);
        uint256 n;
        for (uint256 i = 1; i <= perkCount; i++) {
            Perk storage p = _perks[i];
            if (p.state != PerkState.ACTIVE) continue;
            if (block.timestamp < p.startTime || (p.endTime != 0 && block.timestamp > p.endTime)) continue;
            tmp[n++] = i;
        }
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) ids[i] = tmp[i];
    }

    // ─── GRAPH ────────────────────────────────────────────────────────────

    function partyA() external view override returns (address) {
        return issuer;
    }

    function partyB() external pure override returns (address) {
        return address(0);
    }

    // ─── INTERNAL ─────────────────────────────────────────────────────────

    function _validate(PerkInput calldata p) internal view {
        if (p.endTime != 0 && p.endTime <= p.startTime) revert InvalidWindow();

        if (p.eligibilityType == EligibilityType.MEMBERSHIP || p.eligibilityType == EligibilityType.NFT_HOLD) {
            if (p.eligibilityRef.code.length == 0) revert InvalidEligibility();
        } else if (p.eligibilityType == EligibilityType.TICKET_WINDOW) {
            if (p.eligibilityRef.code.length == 0) revert InvalidEligibility();
            if (p.windowTo != 0 && p.windowTo <= p.windowFrom) revert InvalidWindow();
        }

        if (p.perkType == PerkType.POS_DISCOUNT) {
            if (p.benefitValue == 0 || (p.isPercent && p.benefitValue > BPS)) revert InvalidBenefit();
        }
        // A reward is claimed once; nothing else is claimed. A badge is only ever looked at.
        if ((p.perkType == PerkType.CLAIMABLE_REWARD) != (p.mode == RedemptionMode.CLAIM_ONCE)) revert InvalidMode();
        if (p.perkType == PerkType.BADGE && p.mode != RedemptionMode.PASSIVE_CHECK) revert InvalidMode();
    }

    function _perk(uint256 perkId) internal view returns (Perk storage p) {
        if (perkId == 0 || perkId > perkCount) revert UnknownPerk();
        p = _perks[perkId];
    }

    function _is(uint256 perkId, PerkType t) internal view returns (bool) {
        return perkId != 0 && perkId <= perkCount && _perks[perkId].perkType == t;
    }

    function _recordUse(Perk storage p, uint256 perkId, address wallet) internal {
        p.usesGlobal++;
        walletUses[perkId][wallet]++;
    }

    /// @dev Calls into the membership program without letting it break the check.
    function _isMember(address program, address wallet, uint32 minPriority) internal view returns (bool) {
        (bool ok, bytes memory data) = program.staticcall(abi.encodeCall(IFanMembership.hasActiveTier, (wallet, minPriority)));
        return ok && data.length >= 32 && uint256(bytes32(data)) != 0;
    }

    /// @dev Whether the wallet holds any token of the collection. A collection that cannot answer
    ///      counts as not held.
    function _holdsToken(address collection, address wallet) internal view returns (bool) {
        (bool ok, bytes memory data) = collection.staticcall(abi.encodeWithSignature("balanceOf(address)", wallet));
        return ok && data.length >= 32 && uint256(bytes32(data)) != 0;
    }

    /// @dev For a module scoped to a show: the show is cancelled or in dispute. The show learns it is
    ///      cancelled the moment refunds begin. A scope that is not a show, or cannot answer, is never "off".
    function _eventOff() internal view returns (bool) {
        if (scopeType != ScopeType.SHOW) return false;
        (bool ok, bytes memory data) = scopeRef.staticcall(abi.encodeCall(IPerkShow.status, ()));
        if (!ok || data.length < 32) return false;
        uint256 status = uint256(bytes32(data));
        return status == 3 || status == 5;
    }

    /// @dev The wallet holds `tokenId` and it was bought inside the window. A refunded ticket is
    ///      burned, so it has no holder and stops counting by itself.
    function _boughtTicketInWindow(Perk storage p, address wallet, uint256 tokenId) internal view returns (bool) {
        if (tokenId == 0) return false;
        address ticket = p.eligibilityRef;

        try IPerkTicket(ticket).ownerOf(tokenId) returns (address holder) {
            if (holder != wallet) return false;
        } catch {
            return false;
        }
        // ticketData(tokenId) starts with the time the ticket was minted.
        (bool ok, bytes memory data) = ticket.staticcall(abi.encodeWithSignature("ticketData(uint256)", tokenId));
        if (!ok || data.length < 32) return false;
        uint256 boughtAt = uint256(bytes32(data));
        if (boughtAt < p.windowFrom) return false;
        if (p.windowTo != 0 && boughtAt > p.windowTo) return false;
        return true;
    }

    /// @dev Managers: the issuer, or an owner or admin of the issuer org.
    function _isManager(address who) internal view returns (bool) {
        if (who == issuer) return true;
        return _issuerHasRole(who, XaoRoles.ROLE_OWNER) || _issuerHasRole(who, XaoRoles.ROLE_ADMIN);
    }

    /// @dev Operators: managers, plus an operator of the issuer org.
    function _isOperator(address who) internal view returns (bool) {
        return _isManager(who) || _issuerHasRole(who, XaoRoles.ROLE_OPERATOR);
    }

    function _issuerHasRole(address who, bytes32 role) internal view returns (bool) {
        address org = issuer;
        if (org.code.length == 0) return false;
        (bool ok, bytes memory data) = org.staticcall(abi.encodeCall(IMiniOrgWallet.hasRole, (who, role)));
        return ok && data.length >= 32 && uint256(bytes32(data)) != 0;
    }
}
