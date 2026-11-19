// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "../interfaces/IFanMembership.sol";
import "../interfaces/IGraphParties.sol";
import "../interfaces/IMiniOrg.sol";
import "../libraries/XaoRoles.sol";

/// @title FanMembership — a fan's membership in a band, venue or community (Phase 2F)
/// @notice One program per issuer and scope. Each membership is a soulbound
///         ERC-721: it can be bought, granted by the issuer, renewed and it
///         expires, but it can never be transferred. It proves a relationship
///         ("this wallet holds an active membership of this issuer, in this
///         tier"); the benefits that depend on it (ticket discounts, perks) live
///         in other contracts that ask this one.
/// @dev Deployed as a minimal-proxy clone by FanMembershipFactory.
///
///      Who may do what. The issuer is a plain address or a Mini-Org wallet:
///        - managers: the issuer, or an owner or admin of the issuer org. They
///          shape the program: tiers, prices, payment, sale window, pause.
///        - operators: managers plus an operator of the issuer org. They grant
///          memberships.
///
///      Left out on purpose (spec: MVP): suspending or revoking a membership
///      (memberships are non-revocable), claim-based issuance, tier upgrades,
///      transfers of any kind.
///
///      Implements IGraphParties (issuer as partyA) so GraphRegistry treats the
///      issuer, and an issuer org's operators, as authorized on this node.
contract FanMembership is IFanMembership, IGraphParties, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error AlreadyInitialized();
    error ZeroIssuer();
    error ZeroScopeRef();
    error InvalidSaleWindow();
    error NotManager();
    error NotOperator();
    error ProgramPaused_();
    error UnknownTier();
    error TierNotActive();
    error TierNotPurchasable();
    error TooManyTiers();
    error PriceNeedsPaymentToken();
    error SaleNotOpen();
    error SoldOut();
    error TierSoldOut();
    error ZeroRecipient();
    error FreeMembershipIsForSelf();
    error TooManyMemberships();
    error NotRenewable();
    error PermanentMembership();
    error NoSuchToken();
    error Soulbound();

    enum ScopeType { BAND, VENUE, PROMOTER, TOUR, SERIES, COLLECTIVE, GLOBAL }

    struct ProgramInit {
        address   issuer;
        ScopeType scopeType;
        address   scopeRef;          // the band, venue, promoter, tour ... this applies to; zero only for GLOBAL
        string    name;
        string    symbol;
        string    baseURI;
        bool      renewable;
        uint32    maxSupply;         // 0 = no limit
        address   paymentToken;      // ERC-20 used for paid tiers; zero if every tier is free
        address   paymentReceiver;
        uint64    saleStart;         // 0 = open from the start
        uint64    saleEnd;           // 0 = no end
    }

    struct Tier {
        string  name;
        string  metadataRef;
        uint32  priority;            // a higher number is a better tier
        uint64  baseDuration;        // seconds; 0 = permanent
        uint256 price;               // 0 = not for sale at a price (grant only, or free for self)
        uint256 renewalPrice;
        uint32  issuanceCap;         // 0 = no limit
        uint32  minted;
        bool    active;
        bool    purchasable;         // may be bought by the public
    }

    struct Membership {
        address holder;
        uint32  tierId;
        uint64  issuedAt;
        uint64  expiresAt;           // 0 = permanent
        bytes32 sourceType;          // how it was issued (a tag such as keccak("PURCHASE"))
        bytes32 sourceRef;           // what it came from (a ticket, a campaign ...)
    }

    uint256 public constant MAX_TIERS = 50;
    uint256 public constant MAX_MEMBERSHIPS_PER_HOLDER = 20;
    bytes32 public constant SOURCE_PURCHASE = keccak256("PURCHASE");
    bytes32 public constant SOURCE_RENEWAL  = keccak256("RENEWAL");

    // ─── STATE ────────────────────────────────────────────────────────────
    address public override issuer;
    ScopeType public scopeType;
    address public scopeRef;
    string  public name;
    string  public symbol;
    string  public baseURI;
    bool    public renewable;
    uint32  public maxSupply;
    uint32  public supplyMinted;
    address public paymentToken;
    address public paymentReceiver;
    uint64  public saleStart;
    uint64  public saleEnd;
    bool    public paused;
    bool    public initialized;

    uint256 public tierCount;
    mapping(uint256 => Tier) internal _tiers;

    uint256 public nextTokenId;                     // last id issued; ids start at 1
    mapping(uint256 => Membership) internal _memberships;
    mapping(address => uint256[]) internal _holderTokens;

    // ─── EVENTS ───────────────────────────────────────────────────────────
    event MembershipProgramCreated(address indexed issuer, ScopeType scopeType, address indexed scopeRef, string name, string symbol);
    event TierCreated(uint256 indexed tierId, string name, uint32 priority, uint64 baseDuration, uint256 price, uint256 renewalPrice);
    event TierUpdated(uint256 indexed tierId);
    event MembershipPurchased(uint256 indexed tokenId, address indexed holder, uint256 indexed tierId, address payer, uint256 price, uint64 expiresAt);
    event MembershipGranted(uint256 indexed tokenId, address indexed holder, uint256 indexed tierId, bytes32 sourceType, bytes32 sourceRef, uint64 expiresAt);
    event MembershipRenewed(uint256 indexed tokenId, address indexed payer, uint256 price, uint64 expiresAt);
    event ProgramPaused();
    event ProgramUnpaused();
    event PaymentConfigUpdated(address paymentToken, address paymentReceiver);
    event SaleWindowUpdated(uint64 saleStart, uint64 saleEnd);
    // ERC-721 / ERC-5192 (a token that is locked to its holder)
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Locked(uint256 tokenId);

    modifier onlyManager() {
        if (!_isManager(msg.sender)) revert NotManager();
        _;
    }

    /// @dev Locks the implementation; only clones can be initialized.
    constructor() {
        initialized = true;
    }

    function initialize(ProgramInit calldata p) external {
        if (initialized) revert AlreadyInitialized();
        if (p.issuer == address(0)) revert ZeroIssuer();
        if (p.scopeType != ScopeType.GLOBAL && p.scopeRef == address(0)) revert ZeroScopeRef();
        if (p.saleEnd != 0 && p.saleEnd <= p.saleStart) revert InvalidSaleWindow();

        initialized     = true;
        issuer          = p.issuer;
        scopeType       = p.scopeType;
        scopeRef        = p.scopeRef;
        name            = p.name;
        symbol          = p.symbol;
        baseURI         = p.baseURI;
        renewable       = p.renewable;
        maxSupply       = p.maxSupply;
        paymentToken    = p.paymentToken;
        paymentReceiver = p.paymentReceiver;
        saleStart       = p.saleStart;
        saleEnd         = p.saleEnd;

        emit MembershipProgramCreated(p.issuer, p.scopeType, p.scopeRef, p.name, p.symbol);
    }

    // ─── PROGRAM SETUP (managers) ─────────────────────────────────────────

    function createTier(
        string calldata tierName,
        string calldata metadataRef,
        uint32 priority,
        uint64 baseDuration,
        uint256 price,
        uint256 renewalPrice,
        uint32 issuanceCap,
        bool purchasable
    ) external onlyManager returns (uint256 tierId) {
        if (tierCount >= MAX_TIERS) revert TooManyTiers();
        if ((price != 0 || renewalPrice != 0) && !_canCharge()) revert PriceNeedsPaymentToken();

        tierId = ++tierCount;
        _tiers[tierId] = Tier({
            name:         tierName,
            metadataRef:  metadataRef,
            priority:     priority,
            baseDuration: baseDuration,
            price:        price,
            renewalPrice: renewalPrice,
            issuanceCap:  issuanceCap,
            minted:       0,
            active:       true,
            purchasable:  purchasable
        });
        emit TierCreated(tierId, tierName, priority, baseDuration, price, renewalPrice);
    }

    function updateTierMetadata(uint256 tierId, string calldata metadataRef) external onlyManager {
        _tier(tierId).metadataRef = metadataRef;
        emit TierUpdated(tierId);
    }

    /// @notice New prices apply to memberships bought or renewed from now on.
    function setTierPricing(uint256 tierId, uint256 price, uint256 renewalPrice) external onlyManager {
        if ((price != 0 || renewalPrice != 0) && !_canCharge()) revert PriceNeedsPaymentToken();
        Tier storage t = _tier(tierId);
        t.price = price;
        t.renewalPrice = renewalPrice;
        emit TierUpdated(tierId);
    }

    function setTierActive(uint256 tierId, bool active) external onlyManager {
        _tier(tierId).active = active;
        emit TierUpdated(tierId);
    }

    function setTierPurchasable(uint256 tierId, bool purchasable) external onlyManager {
        _tier(tierId).purchasable = purchasable;
        emit TierUpdated(tierId);
    }

    function setPaymentConfig(address token, address receiver) external onlyManager {
        paymentToken = token;
        paymentReceiver = receiver;
        emit PaymentConfigUpdated(token, receiver);
    }

    function setSaleWindow(uint64 start, uint64 end) external onlyManager {
        if (end != 0 && end <= start) revert InvalidSaleWindow();
        saleStart = start;
        saleEnd = end;
        emit SaleWindowUpdated(start, end);
    }

    function setBaseURI(string calldata uri) external onlyManager {
        baseURI = uri;
    }

    /// @notice Stops all new memberships and renewals until unpaused.
    function setPaused(bool value) external onlyManager {
        paused = value;
        if (value) emit ProgramPaused(); else emit ProgramUnpaused();
    }

    // ─── ISSUING ──────────────────────────────────────────────────────────

    /// @notice Buy a membership for `recipient`. The caller pays. Free tiers can
    ///         only be taken for yourself, so nobody can fill another wallet
    ///         with memberships it did not ask for.
    function purchaseMembership(uint256 tierId, address recipient) external nonReentrant returns (uint256 tokenId) {
        if (paused) revert ProgramPaused_();
        if (recipient == address(0)) revert ZeroRecipient();
        if (block.timestamp < saleStart || (saleEnd != 0 && block.timestamp > saleEnd)) revert SaleNotOpen();

        Tier storage t = _tier(tierId);
        if (!t.active) revert TierNotActive();
        if (!t.purchasable) revert TierNotPurchasable();
        if (t.price == 0 && recipient != msg.sender) revert FreeMembershipIsForSelf();

        uint256 price = t.price;
        uint64 expiresAt;
        (tokenId, expiresAt) = _issue(tierId, t, recipient, SOURCE_PURCHASE, bytes32(0));
        if (price != 0) IERC20(paymentToken).safeTransferFrom(msg.sender, paymentReceiver, price);

        emit MembershipPurchased(tokenId, recipient, tierId, msg.sender, price, expiresAt);
    }

    /// @notice The issuer's operators give a membership for free: a ticket
    ///         bundle, a milestone, a thank-you. Works for tiers that are not for sale.
    function grantMembership(uint256 tierId, address recipient, bytes32 sourceType, bytes32 sourceRef)
        external returns (uint256 tokenId)
    {
        if (!_isOperator(msg.sender)) revert NotOperator();
        if (paused) revert ProgramPaused_();
        if (recipient == address(0)) revert ZeroRecipient();

        Tier storage t = _tier(tierId);
        if (!t.active) revert TierNotActive();

        uint64 expiresAt;
        (tokenId, expiresAt) = _issue(tierId, t, recipient, sourceType, sourceRef);
        emit MembershipGranted(tokenId, recipient, tierId, sourceType, sourceRef, expiresAt);
    }

    /// @notice Extend a membership by one more period of its tier. Anyone can pay
    ///         for it; only the holder benefits. The new period starts when the
    ///         old one ends, or now if it already ended.
    function renewMembership(uint256 tokenId) external nonReentrant {
        if (paused) revert ProgramPaused_();
        if (!renewable) revert NotRenewable();
        Membership storage m = _memberships[tokenId];
        if (m.holder == address(0)) revert NoSuchToken();

        Tier storage t = _tiers[m.tierId];
        if (m.expiresAt == 0 || t.baseDuration == 0) revert PermanentMembership();

        uint64 from = m.expiresAt > block.timestamp ? m.expiresAt : uint64(block.timestamp);
        m.expiresAt = from + t.baseDuration;

        uint256 price = t.renewalPrice;
        if (price != 0) IERC20(paymentToken).safeTransferFrom(msg.sender, paymentReceiver, price);

        emit MembershipRenewed(tokenId, msg.sender, price, m.expiresAt);
    }

    // ─── QUERIES ──────────────────────────────────────────────────────────

    function isMembershipActive(uint256 tokenId) public view override returns (bool) {
        Membership storage m = _memberships[tokenId];
        if (m.holder == address(0)) return false;
        return m.expiresAt == 0 || block.timestamp <= m.expiresAt;
    }

    function isHolderActiveMember(address holder, uint256 tierId) external view override returns (bool) {
        uint256[] storage ids = _holderTokens[holder];
        for (uint256 i = 0; i < ids.length; i++) {
            if (!isMembershipActive(ids[i])) continue;
            if (tierId == 0 || _memberships[ids[i]].tierId == tierId) return true;
        }
        return false;
    }

    function hasActiveTier(address holder, uint32 minTierPriority) external view override returns (bool) {
        uint256[] storage ids = _holderTokens[holder];
        for (uint256 i = 0; i < ids.length; i++) {
            if (!isMembershipActive(ids[i])) continue;
            if (_tiers[_memberships[ids[i]].tierId].priority >= minTierPriority) return true;
        }
        return false;
    }

    function getHolderMemberships(address holder) external view returns (uint256[] memory) {
        return _holderTokens[holder];
    }

    function getMembership(uint256 tokenId) external view returns (Membership memory) {
        if (_memberships[tokenId].holder == address(0)) revert NoSuchToken();
        return _memberships[tokenId];
    }

    function getTier(uint256 tierId) external view returns (Tier memory) {
        return _tier(tierId);
    }

    // ─── GRAPH ────────────────────────────────────────────────────────────

    function partyA() external view override returns (address) {
        return issuer;
    }

    function partyB() external pure override returns (address) {
        return address(0);
    }

    // ─── ERC-721 (read-only: the token never moves) ───────────────────────

    function balanceOf(address owner) external view returns (uint256) {
        return _holderTokens[owner].length;
    }

    function ownerOf(uint256 tokenId) external view returns (address owner) {
        owner = _memberships[tokenId].holder;
        if (owner == address(0)) revert NoSuchToken();
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_memberships[tokenId].holder == address(0)) revert NoSuchToken();
        return string.concat(baseURI, Strings.toString(tokenId));
    }

    /// @notice ERC-5192: every membership is locked to its holder.
    function locked(uint256 tokenId) external view returns (bool) {
        if (_memberships[tokenId].holder == address(0)) revert NoSuchToken();
        return true;
    }

    function getApproved(uint256) external pure returns (address) { return address(0); }
    function isApprovedForAll(address, address) external pure returns (bool) { return false; }

    function approve(address, uint256) external pure { revert Soulbound(); }
    function setApprovalForAll(address, bool) external pure { revert Soulbound(); }
    function transferFrom(address, address, uint256) external pure { revert Soulbound(); }
    function safeTransferFrom(address, address, uint256) external pure { revert Soulbound(); }
    function safeTransferFrom(address, address, uint256, bytes calldata) external pure { revert Soulbound(); }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7      // ERC-165
            || id == 0x80ac58cd      // ERC-721
            || id == 0x5b5e139f      // ERC-721 metadata
            || id == 0xb45a3c0e;     // ERC-5192 (locked tokens)
    }

    // ─── INTERNAL ─────────────────────────────────────────────────────────

    function _issue(uint256 tierId, Tier storage t, address recipient, bytes32 sourceType, bytes32 sourceRef)
        internal returns (uint256 tokenId, uint64 expiresAt)
    {
        if (maxSupply != 0 && supplyMinted >= maxSupply) revert SoldOut();
        if (t.issuanceCap != 0 && t.minted >= t.issuanceCap) revert TierSoldOut();
        if (_holderTokens[recipient].length >= MAX_MEMBERSHIPS_PER_HOLDER) revert TooManyMemberships();

        supplyMinted++;
        t.minted++;
        tokenId = ++nextTokenId;
        expiresAt = t.baseDuration == 0 ? 0 : uint64(block.timestamp) + t.baseDuration;

        _memberships[tokenId] = Membership({
            holder:     recipient,
            tierId:     uint32(tierId),
            issuedAt:   uint64(block.timestamp),
            expiresAt:  expiresAt,
            sourceType: sourceType,
            sourceRef:  sourceRef
        });
        _holderTokens[recipient].push(tokenId);

        emit Transfer(address(0), recipient, tokenId);
        emit Locked(tokenId);
    }

    function _tier(uint256 tierId) internal view returns (Tier storage t) {
        if (tierId == 0 || tierId > tierCount) revert UnknownTier();
        t = _tiers[tierId];
    }

    function _canCharge() internal view returns (bool) {
        return paymentToken != address(0) && paymentReceiver != address(0);
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
