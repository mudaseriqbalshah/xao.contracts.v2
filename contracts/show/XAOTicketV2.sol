// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "../interfaces/IShowBundle.sol";
import "../libraries/DiscountMath.sol";
import "../interfaces/IPerkModule.sol";
import "../interfaces/IDiscountCoordinator.sol";

/// @title XAOTicketV2 — ERC-1155 NFT tickets for one show (Phase 2A)
/// @notice Sells tickets the same way XAOTicket does: price tiers, lazy mint at
///         the point of sale, a 2% XAO fee plus a $1 gas allotment, and resale
///         royalties. What changed for the show bundle:
///         - the $1 goes to the treasury at sale; everything else, including
///           the 2%, goes to the show's escrow;
///         - each ticket records its current owner and what was paid, so the
///           escrow can refund holders automatically on cancellation;
///         - scanning is done by the EntryValidator, and a scanned ticket
///           cannot be transferred until the show ends.
/// @dev Deployed as a minimal-proxy clone by ShowFactory and set up via initialize().
contract XAOTicketV2 is ERC1155, ERC2981, AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    error AlreadyInitialized();
    error ZeroAddress();
    error NotAuthorized();
    error TiersLocked();
    error ZeroQuantity();
    error ResaleBpsMustSumTo10000();
    error ShowNotSigned();
    error InvalidTier();
    error NotOnSaleYet();
    error InvalidGate();
    error NoDiscountProgram();
    error InvalidOrder();
    error PriceAboveMax();
    error NotEligibleForTier();
    error SoldOut();
    error CapacityReached();
    error NotEntryValidator();
    error NotEscrow();
    error InvalidToken();
    error TransfersLocked();

    // ─── ROLES ────────────────────────────────────────────────────────────
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── PROTOCOL CONSTANTS ───────────────────────────────────────────────
    uint256 public constant XAO_FEE_BPS   = 200;    // 2 %
    uint256 public constant GAS_ALLOTMENT = 1e6;    // $1 USDC (6 decimals)

    // ─── TICKET TYPE ENUM ─────────────────────────────────────────────────
    enum TicketType { COMP, PRESALE, GENERAL_ADMISSION, VIP, CUSTOM }

    /// @dev Who may buy a tier, decided by a perk module the parties name when they set the show up.
    ///      NONE: anyone, from the tier's on-sale time.
    ///      PRESALE: holders of a PRESALE_ACCESS perk may buy from `presaleFrom`, before the
    ///               general on-sale time; after that anyone may.
    ///      MEMBERS_ONLY: only holders of an EVENT_ACCESS perk may buy, whenever it is on sale.
    ///      The perk is only looked at, never used up, so a holder can buy as many tickets as the
    ///      show allows. Use passive-check perks for gates.
    enum GateMode { NONE, PRESALE, MEMBERS_ONLY }

    // ─── STORAGE ──────────────────────────────────────────────────────────
    struct TicketTier {
        TicketType ticketType;
        string     customName;      // used when ticketType == CUSTOM
        uint256    priceUSDC;
        uint256    quantity;        // hard cap for this tier
        uint256    sold;            // never exceeds quantity
        uint256    onSaleTimestamp;
        // Resale splits — must sum to 10 000 BPS
        uint256    partyAResaleBPS;
        uint256    partyBResaleBPS;
        uint256    resellerBPS;
        string     image;           // NFT artwork for this ticket type (IPFS/HTTP URI)
        GateMode   gateMode;
        address    gateModule;      // the perk module asked
        uint256    gateId;          // the perk in that module
        uint256    presaleFrom;     // PRESALE: when perk holders may start buying
    }

    /// @dev Calldata-friendly shape of one tier.
    struct TierInput {
        TicketType ticketType;
        string     customName;
        uint256    priceUSDC;
        uint256    quantity;
        uint256    onSaleTimestamp;
        uint256    partyAResaleBPS;
        uint256    partyBResaleBPS;
        uint256    resellerBPS;
        string     image;
        GateMode   gateMode;
        address    gateModule;
        uint256    gateId;
        uint256    presaleFrom;
    }

    struct TicketData {
        uint64  mintTime;
        uint64  scanTime;
        uint16  rescanCount;
        bool    scanned;
        bool    refunded;
        uint256 pricePaid;      // what the buyer paid for this ticket: its list price less its discounts, gas included
        uint256 escrowed;       // part of it that reached the escrow
        uint256 protocolFee;    // part of `escrowed` held for XAO
        uint256 tax;            // part of `escrowed` held for the tax receiver
        uint256 listPrice;      // the tier's price when it was bought
        uint256 discount;       // how much of it a discount took off; above zero marks a discounted ticket
    }

    struct TicketInit {
        address     show;
        address     escrow;
        address     entryValidator;
        address     usdc;
        address     treasury;
        address     admin;          // partyA
        string      eventName;
        uint256     totalCapacity;
        uint256     salesTaxBPS;    // share of the list price held as sales tax
        address     discountCoordinator; // the show's discount coordinator, or zero
        TierInput[] tiers;
    }

    IShowInstanceLike public show;
    address public escrow;
    address public entryValidator;
    IERC20  public usdc;
    address public treasury;
    uint256 public totalCapacity;
    uint256 public salesTaxBPS;
    address public discountCoordinator;

    string public eventName;
    string public metadataDNSLink;

    mapping(uint256 => TicketTier) public tiers;
    uint256 public tierCount;

    mapping(uint256 => uint256)    public tokenToTier;   // tokenId → tierId
    mapping(uint256 => TicketData) public ticketData;
    mapping(uint256 => address)    internal _owners;     // tokenId → current holder
    mapping(address => bool)       public approvedMarketplaces;

    uint256 public lastMintedId;    // token ids run 1..lastMintedId
    uint256 public totalSold;

    bool public initialized;

    // ─── EVENTS ───────────────────────────────────────────────────────────
    event TicketDiscounted(uint256 indexed tokenId, uint256 listPrice, uint256 discount);
    event TicketOrder(address indexed buyer, uint256 firstTokenId, uint256 count, uint256 discountTotal);
    event TierGated(uint256 indexed tierId, GateMode mode, address indexed module, uint256 perkId, uint256 presaleFrom);
    event TierAdded(
        uint256 indexed tierId,
        TicketType      ticketType,
        uint256         priceUSDC,
        uint256         quantity
    );
    event TicketSold(
        uint256 indexed tokenId,
        uint256 indexed tierId,
        address indexed buyer,
        uint256         priceUSDC
    );
    event TicketScanned(uint256 indexed tokenId, bytes32 gateId, uint64 time);
    event TicketRescanned(uint256 indexed tokenId, bytes32 gateId, uint16 rescanCount);
    event TicketRefunded(uint256 indexed tokenId, address indexed holder);
    event MarketplaceApprovalSet(address indexed marketplace, bool approved);

    /// @dev Locks the implementation; only clones can be initialized.
    constructor() ERC1155("") {
        initialized = true;
    }

    function initialize(TicketInit calldata init) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;

        if (
            init.show == address(0) ||
            init.escrow == address(0) ||
            init.entryValidator == address(0) ||
            init.usdc == address(0) ||
            init.treasury == address(0) ||
            init.admin == address(0)
        ) revert ZeroAddress();

        show           = IShowInstanceLike(init.show);
        escrow         = init.escrow;
        entryValidator = init.entryValidator;
        usdc           = IERC20(init.usdc);
        treasury       = init.treasury;
        eventName      = init.eventName;
        totalCapacity  = init.totalCapacity;
        salesTaxBPS    = init.salesTaxBPS;
        discountCoordinator = init.discountCoordinator;

        // partyA administers the collection and can grant ADMIN_ROLE to others.
        _grantRole(DEFAULT_ADMIN_ROLE, init.admin);
        _grantRole(ADMIN_ROLE, init.admin);

        for (uint256 i = 0; i < init.tiers.length; i++) {
            _addTierUnchecked(init.tiers[i]);
        }
    }

    // ─── TIER MANAGEMENT ─────────────────────────────────────────────────

    /// @dev Tiers may only be added before anyone has signed the show, so the
    ///      ticket types are exactly the ones both parties signed.
    function _requireCanEditTiers() internal view {
        if (!hasRole(ADMIN_ROLE, msg.sender)) revert NotAuthorized();
        if (show.anySigned()) revert TiersLocked();
    }

    /// @dev Asks the tier's perk module whether the buyer qualifies. A module that
    ///      fails to answer counts as a no: the gate closes rather than opens.
    function _gatePasses(TicketTier storage tier) internal view returns (bool) {
        IPerkModule.PerkContext memory ctx;     // nothing to prove: the perk is about the wallet
        if (tier.gateMode == GateMode.PRESALE) {
            try IPerkModule(tier.gateModule).hasPresaleAccess(msg.sender, tier.gateId, ctx) returns (bool ok) { return ok; }
            catch { return false; }
        }
        try IPerkModule(tier.gateModule).hasAccess(msg.sender, tier.gateId, ctx) returns (bool ok) { return ok; }
        catch { return false; }
    }

    function _addTierUnchecked(TierInput memory t) internal returns (uint256 tierId) {
        if (t.quantity == 0) revert ZeroQuantity();
        if (t.partyAResaleBPS + t.partyBResaleBPS + t.resellerBPS != 10_000) {
            revert ResaleBpsMustSumTo10000();
        }
        if (t.gateMode != GateMode.NONE) {
            if (t.gateModule.code.length == 0) revert InvalidGate();
            // A presale has to open before the general sale, so the general sale needs a time.
            if (t.gateMode == GateMode.PRESALE && (t.onSaleTimestamp == 0 || t.presaleFrom >= t.onSaleTimestamp)) {
                revert InvalidGate();
            }
        }
        tierId = tierCount;
        tiers[tierId] = TicketTier({
            ticketType:      t.ticketType,
            customName:      t.customName,
            priceUSDC:       t.priceUSDC,
            quantity:        t.quantity,
            sold:            0,
            onSaleTimestamp: t.onSaleTimestamp,
            partyAResaleBPS: t.partyAResaleBPS,
            partyBResaleBPS: t.partyBResaleBPS,
            resellerBPS:     t.resellerBPS,
            image:           t.image,
            gateMode:        t.gateMode,
            gateModule:      t.gateModule,
            gateId:          t.gateId,
            presaleFrom:     t.presaleFrom
        });
        tierCount++;
        if (t.gateMode != GateMode.NONE) emit TierGated(tierId, t.gateMode, t.gateModule, t.gateId, t.presaleFrom);
        emit TierAdded(tierId, t.ticketType, t.priceUSDC, t.quantity);
    }

    /// @notice Add a single ticket tier.
    function addTier(TierInput calldata input) external returns (uint256 tierId) {
        _requireCanEditTiers();
        tierId = _addTierUnchecked(input);
    }

    /// @notice Add many ticket tiers in one transaction.
    function addTiers(TierInput[] calldata inputs) external returns (uint256[] memory ids) {
        _requireCanEditTiers();
        ids = new uint256[](inputs.length);
        for (uint256 i = 0; i < inputs.length; i++) {
            ids[i] = _addTierUnchecked(inputs[i]);
        }
    }

    // ─── TICKET PURCHASE (lazy mint) ─────────────────────────────────────

    /// @notice Buy a ticket. Caller must approve this contract for at least tier.priceUSDC.
    ///         $1 gas allotment → treasury now. The rest → the show's escrow,
    ///         where the 2% XAO fee is held until the show completes.
    function buyTicket(uint256 tierId)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 tokenId)
    {
        // No sales until every party has signed.
        if (!show.isFinalized()) revert ShowNotSigned();
        uint256 gross = _admit(tierId);

        // Gas, XAO's fee and the sales tax are each a share of the list price, squeezed
        // in that order if the ticket is too cheap to hold them (see DiscountMath).
        DiscountMath.Breakdown memory parts = DiscountMath.breakdown(gross, salesTaxBPS, XAO_FEE_BPS, GAS_ALLOTMENT);
        uint256 escrowed = gross - parts.gas;      // fee and tax stay inside it, so a refund returns them

        tokenId = _record(tierId, gross, parts.gas, parts.fee, parts.tax, 0);

        if (gross > 0) {
            usdc.safeTransferFrom(msg.sender, address(this), gross);
            if (parts.gas > 0) usdc.safeTransfer(treasury, parts.gas);
            if (escrowed > 0) usdc.safeTransfer(escrow, escrowed);
        }
        // Always reported, so the escrow rejects sales it is not open for.
        IEventEscrowLike(escrow).creditTicketSale(escrowed, parts.fee, parts.tax);

        _mint(msg.sender, tokenId, 1, "");

        emit TicketSold(tokenId, tierId, msg.sender, gross);
    }

    /// @notice Buy several tickets in one order, with the show's discounts. Every
    ///         discount goes to one eligible ticket of the order, chosen by the
    ///         contract; `expectedHash` is the hash of the quote the buyer saw (see
    ///         `quoteTickets`), so a sale whose price changed in the meantime is
    ///         refused, and `maxTotal` is the most the buyer will pay for the order.
    ///         The buyer pays each ticket's list price less its discounts; gas, Xao's
    ///         fee and the tax are the same as without a discount. Every ticket is
    ///         recorded with what was actually paid for it, so a cancelled show
    ///         refunds exactly that. Tickets bought with `buyTicket` get no discount.
    function buyTickets(
        uint256[] calldata tierIds,
        IDiscountCoordinator.Consent calldata consent,
        bytes32 expectedHash,
        uint256 maxTotal
    ) external nonReentrant whenNotPaused returns (uint256[] memory tokenIds) {
        address coordinator = discountCoordinator;
        if (coordinator == address(0)) revert NoDiscountProgram();
        if (!show.isFinalized()) revert ShowNotSigned();
        uint256 n = tierIds.length;
        if (n == 0 || n > DiscountMath.MAX_ORDER_ITEMS) revert InvalidOrder();

        uint256[] memory prices = new uint256[](n);
        for (uint256 i = 0; i < n; i++) prices[i] = _admit(tierIds[i]);

        IDiscountCoordinator.Sale memory sale = IDiscountCoordinator(coordinator).commit(
            msg.sender, tierIds, prices, salesTaxBPS, XAO_FEE_BPS, GAS_ALLOTMENT, consent, expectedHash
        );
        if (sale.checkoutTotal > maxTotal) revert PriceAboveMax();

        tokenIds = new uint256[](n);
        uint256 gasTotal;
        uint256 escrowTotal;
        uint256 feeTotal;
        uint256 taxTotal;
        for (uint256 i = 0; i < n; i++) {
            tokenIds[i] = _record(tierIds[i], prices[i], sale.gas[i], sale.fee[i], sale.tax[i], prices[i] - sale.pricePaid[i]);
            gasTotal    += sale.gas[i];
            escrowTotal += sale.pricePaid[i] - sale.gas[i];
            feeTotal    += sale.fee[i];
            taxTotal    += sale.tax[i];
        }

        if (sale.checkoutTotal > 0) {
            usdc.safeTransferFrom(msg.sender, address(this), sale.checkoutTotal);
            if (gasTotal > 0) usdc.safeTransfer(treasury, gasTotal);
            if (escrowTotal > 0) usdc.safeTransfer(escrow, escrowTotal);
        }
        IEventEscrowLike(escrow).creditTicketSale(escrowTotal, feeTotal, taxTotal);

        for (uint256 i = 0; i < n; i++) {
            _mint(msg.sender, tokenIds[i], 1, "");
            emit TicketSold(tokenIds[i], tierIds[i], msg.sender, sale.pricePaid[i]);
            if (sale.pricePaid[i] < prices[i]) emit TicketDiscounted(tokenIds[i], prices[i], prices[i] - sale.pricePaid[i]);
        }
        emit TicketOrder(msg.sender, tokenIds[0], n, sale.discountTotal);
    }

    /// @dev Checks that a ticket of this tier can be bought now and takes a seat from it.
    function _admit(uint256 tierId) internal returns (uint256 listPrice) {
        if (tierId >= tierCount) revert InvalidTier();
        TicketTier storage tier = tiers[tierId];
        if (tier.gateMode == GateMode.MEMBERS_ONLY && !_gatePasses(tier)) revert NotEligibleForTier();
        if (block.timestamp < tier.onSaleTimestamp) {
            // Before the general sale only a presale tier is open, and only to its perk holders.
            if (tier.gateMode != GateMode.PRESALE || block.timestamp < tier.presaleFrom) revert NotOnSaleYet();
            if (!_gatePasses(tier)) revert NotEligibleForTier();
        }
        if (tier.sold >= tier.quantity) revert SoldOut();
        if (totalSold >= totalCapacity) revert CapacityReached();
        tier.sold++;
        totalSold++;
        listPrice = tier.priceUSDC;
    }

    /// @dev Writes down a ticket and what was paid for it. The token itself is minted by the caller, last.
    function _record(uint256 tierId, uint256 listPrice, uint256 gas, uint256 fee, uint256 tax, uint256 discount)
        internal returns (uint256 tokenId)
    {
        tokenId = ++lastMintedId;
        tokenToTier[tokenId] = tierId;
        uint256 paid = listPrice - discount;
        ticketData[tokenId] = TicketData({
            mintTime:    uint64(block.timestamp),
            scanTime:    0,
            rescanCount: 0,
            scanned:     false,
            refunded:    false,
            pricePaid:   paid,
            escrowed:    paid - gas,
            protocolFee: fee,
            tax:         tax,
            listPrice:   listPrice,
            discount:    discount
        });
    }

    // ─── SCANNING (entry validator only) ─────────────────────────────────

    /// @notice First scan marks the ticket Scanned and returns true. Any later
    ///         scan is counted and returns false.
    function scan(uint256 tokenId, bytes32 gateId) external returns (bool accepted) {
        if (msg.sender != entryValidator) revert NotEntryValidator();
        if (!exists(tokenId)) revert InvalidToken();

        TicketData storage t = ticketData[tokenId];
        if (!t.scanned) {
            t.scanned  = true;
            t.scanTime = uint64(block.timestamp);
            emit TicketScanned(tokenId, gateId, t.scanTime);
            return true;
        }

        t.rescanCount++;
        emit TicketRescanned(tokenId, gateId, t.rescanCount);
        return false;
    }

    // ─── REFUND SUPPORT (escrow only) ────────────────────────────────────

    /// @notice Burn a ticket the escrow is refunding.
    function burnRefunded(uint256 tokenId) external {
        if (msg.sender != escrow) revert NotEscrow();
        address holder = _owners[tokenId];
        if (holder == address(0)) revert InvalidToken();

        ticketData[tokenId].refunded = true;
        _burn(holder, tokenId, 1);
        emit TicketRefunded(tokenId, holder);
    }

    // ─── TRANSFER LOCK + OWNER TRACKING ──────────────────────────────────

    /// @dev Before the show ends, a ticket moves only through an approved XAO
    ///      marketplace, and not at all once it has been scanned. After the
    ///      show ends it is a freely transferable collectible.
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override {
        bool isTransfer = from != address(0) && to != address(0);
        bool locked = isTransfer && block.timestamp < show.showEndTime();
        if (locked && !approvedMarketplaces[_msgSender()]) revert TransfersLocked();

        for (uint256 i = 0; i < ids.length; i++) {
            if (values[i] == 0) continue;
            if (locked && ticketData[ids[i]].scanned) revert TransfersLocked();
            _owners[ids[i]] = to;
        }

        super._update(from, to, ids, values);
    }

    // ─── ERC-2981 ROYALTIES ──────────────────────────────────────────────

    /// @notice Royalty receiver is the show's escrow; amount = partyA + partyB resale split.
    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        public
        view
        override
        returns (address receiver, uint256 royaltyAmount)
    {
        if (tokenId == 0 || tokenId > lastMintedId) revert InvalidToken();
        TicketTier storage tier = tiers[tokenToTier[tokenId]];
        uint256 totalRoyaltyBPS = tier.partyAResaleBPS + tier.partyBResaleBPS;
        return (escrow, salePrice * totalRoyaltyBPS / 10_000);
    }

    // ─── ADMIN ───────────────────────────────────────────────────────────

    function setMarketplaceApproval(address marketplace, bool approved)
        external
        onlyRole(ADMIN_ROLE)
    {
        approvedMarketplaces[marketplace] = approved;
        emit MarketplaceApprovalSet(marketplace, approved);
    }

    function setMetadataDNSLink(string memory link) external onlyRole(ADMIN_ROLE) {
        metadataDNSLink = link;
    }

    function pause()   external onlyRole(ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(ADMIN_ROLE) { _unpause(); }

    // ─── METADATA ────────────────────────────────────────────────────────

    /// @notice ERC-1155 metadata as an on-chain JSON data URI whose `image` is
    ///         the ticket type's artwork.
    /// @dev    Assumes eventName / tier image contain no unescaped `"`.
    function uri(uint256 tokenId) public view override returns (string memory) {
        TicketTier storage tier = tiers[tokenToTier[tokenId]];
        string memory tierName = bytes(tier.customName).length > 0 ? tier.customName : "Ticket";
        string memory json = string(
            abi.encodePacked(
                '{"name":"', eventName, ' - ', tierName,
                '","description":"XAO event ticket","image":"', tier.image, '"}'
            )
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
    }

    // ─── VIEW HELPERS ────────────────────────────────────────────────────

    /// @notice True for a minted ticket that has not been refunded.
    function exists(uint256 tokenId) public view returns (bool) {
        return _owners[tokenId] != address(0);
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address holder = _owners[tokenId];
        if (holder == address(0)) revert InvalidToken();
        return holder;
    }

    function getPricePaid(uint256 tokenId) external view returns (uint256) {
        return ticketData[tokenId].pricePaid;
    }

    function getRefundBasis(uint256 tokenId) external view returns (uint256 escrowed, uint256 protocolFee, uint256 tax) {
        TicketData storage t = ticketData[tokenId];
        return (t.escrowed, t.protocolFee, t.tax);
    }

    function isRefunded(uint256 tokenId) external view returns (bool) {
        return ticketData[tokenId].refunded;
    }

    function isScanned(uint256 tokenId) external view returns (bool) {
        return ticketData[tokenId].scanned;
    }

    function getTier(uint256 tierId) external view returns (TicketTier memory) {
        if (tierId >= tierCount) revert InvalidTier();
        return tiers[tierId];
    }

    function nextTokenId() external view returns (uint256) {
        return lastMintedId + 1;
    }

    // ─── INTERFACE SUPPORT ───────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, ERC2981, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
