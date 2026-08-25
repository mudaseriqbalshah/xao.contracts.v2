// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "./interfaces/IShowContract.sol";

interface ITicketUSDC {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title XAOTicket — ERC-1155 NFT Ticket contract (Phase 1 MVP)
/// @notice One contract per show. Deployed automatically by ShowContract.sign().
///         Lazy mint at point of sale, transfer-locked pre-endTime,
///         freely transferable collectible post-endTime.
contract XAOTicket is ERC1155, ERC2981, AccessControl, ReentrancyGuard, Pausable {

    // ─── ROLES ────────────────────────────────────────────────────────────
    bytes32 public constant ADMIN_ROLE   = keccak256("ADMIN_ROLE");
    bytes32 public constant SCANNER_ROLE = keccak256("SCANNER_ROLE");

    // ─── PROTOCOL CONSTANTS ───────────────────────────────────────────────
    uint256 public constant XAO_FEE_BPS   = 200;    // 2 %
    uint256 public constant GAS_ALLOTMENT = 1e6;    // $1 USDC (6 decimals)

    // ─── TICKET TYPE ENUM ─────────────────────────────────────────────────
    enum TicketType { COMP, PRESALE, GENERAL_ADMISSION, VIP, CUSTOM }

    // ─── STORAGE ──────────────────────────────────────────────────────────

    struct TicketTier {
        TicketType ticketType;
        string     customName;      // used when ticketType == CUSTOM
        uint256    priceUSDC;
        uint256    quantity;        // hard cap for this tier
        uint256    sold;            // never exceeds quantity
        uint256    onSaleTimestamp;
        // Resale splits — must sum to 10 000 BPS
        uint256    party1ResaleBPS;
        uint256    party2ResaleBPS;
        uint256    resellerBPS;
        string     image;           // NFT artwork for this ticket type (IPFS/HTTP URI)
    }

    address public immutable showContract;
    ITicketUSDC public immutable usdc;
    address public immutable treasury;
    uint256 public immutable totalCapacity; // mirror from ShowContract

    string public eventName;
    string public metadataDNSLink;

    mapping(uint256 => TicketTier) public tiers;
    uint256 public tierCount;

    mapping(uint256 => uint256) public tokenToTier;   // tokenId → tierId
    mapping(uint256 => bool)    public scanned;        // tokenId → scanned
    mapping(address => bool)    public approvedMarketplaces;

    uint256 private _nextTokenId;
    uint256 public totalSold;

    // ─── EVENTS ───────────────────────────────────────────────────────────
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
    event TicketAuthenticated(
        uint256 indexed tokenId,
        address indexed scanner,
        uint256         timestamp
    );
    event TicketRedeemed(
        uint256 indexed tokenId,
        address indexed scanner,
        uint256         timestamp
    );
    event MarketplaceApprovalSet(address indexed marketplace, bool approved);

    // ─── CONSTRUCTOR ──────────────────────────────────────────────────────

    constructor(
        address _showContract,
        address _usdc,
        address _treasury,
        string memory _eventName,
        uint256 _totalCapacity
    ) ERC1155("") {
        require(
            _showContract != address(0) && _usdc != address(0) && _treasury != address(0),
            "Zero address"
        );
        showContract  = _showContract;
        usdc          = ITicketUSDC(_usdc);
        treasury      = _treasury;
        eventName     = _eventName;
        totalCapacity = _totalCapacity;

        // ShowContract is the deployer — it becomes the default admin
        _grantRole(DEFAULT_ADMIN_ROLE, _showContract);
        _grantRole(ADMIN_ROLE, _showContract);

        // ADMIN_ROLE holders (e.g. party1) can grant/revoke SCANNER_ROLE
        _setRoleAdmin(SCANNER_ROLE, ADMIN_ROLE);
    }

    // ─── TIER MANAGEMENT ─────────────────────────────────────────────────

    /// @dev Calldata-friendly shape of one tier, used by the batch `addTiers`.
    struct TierInput {
        TicketType ticketType;
        string     customName;
        uint256    priceUSDC;
        uint256    quantity;
        uint256    onSaleTimestamp;
        uint256    party1ResaleBPS;
        uint256    party2ResaleBPS;
        uint256    resellerBPS;
        string     image;
    }

    /// @dev Tiers may only be added while the show is in DRAFT — i.e. BEFORE
    ///      anyone has signed. The frontend adds the form's tiers in the same
    ///      session it deploys the show and before it calls sign(), so those
    ///      succeed; any attempt after the first signature (status leaves DRAFT)
    ///      reverts. This guarantees the ticket types are exactly those set
    ///      before signing — none can be added later. Restricted to ADMIN_ROLE
    ///      (the show + party1).
    function _requireCanEditTiers() internal view {
        require(hasRole(ADMIN_ROLE, msg.sender), "Not authorized");
        // Status.DRAFT == 0 (see ShowContract.Status)
        require(IShowContract(showContract).status() == 0, "Tiers locked: set them before signing");
    }

    /// @dev Stores one tier. No auth / no signature-reset — callers gate first.
    function _addTierUnchecked(TierInput memory t) internal returns (uint256 tierId) {
        require(t.quantity > 0, "Zero quantity");
        require(
            t.party1ResaleBPS + t.party2ResaleBPS + t.resellerBPS == 10_000,
            "Resale BPS must sum to 10000"
        );
        tierId = tierCount;
        tiers[tierId] = TicketTier({
            ticketType:      t.ticketType,
            customName:      t.customName,
            priceUSDC:       t.priceUSDC,
            quantity:        t.quantity,
            sold:            0,
            onSaleTimestamp: t.onSaleTimestamp,
            party1ResaleBPS: t.party1ResaleBPS,
            party2ResaleBPS: t.party2ResaleBPS,
            resellerBPS:     t.resellerBPS,
            image:           t.image
        });
        tierCount++;
        emit TierAdded(tierId, t.ticketType, t.priceUSDC, t.quantity);
    }

    /// @notice Add a single ticket tier.
    function addTier(
        TicketType    _ticketType,
        string calldata _customName,
        uint256       _priceUSDC,
        uint256       _quantity,
        uint256       _onSaleTimestamp,
        uint256       _party1ResaleBPS,
        uint256       _party2ResaleBPS,
        uint256       _resellerBPS,
        string calldata _image
    ) external returns (uint256 tierId) {
        _requireCanEditTiers();
        tierId = _addTierUnchecked(TierInput({
            ticketType:      _ticketType,
            customName:      _customName,
            priceUSDC:       _priceUSDC,
            quantity:        _quantity,
            onSaleTimestamp: _onSaleTimestamp,
            party1ResaleBPS: _party1ResaleBPS,
            party2ResaleBPS: _party2ResaleBPS,
            resellerBPS:     _resellerBPS,
            image:           _image
        }));
        // A tier change during negotiation invalidates a prior signature on the
        // show, so the signer must re-approve before the contract can finalize.
        IShowContract(showContract).onTierChanged(msg.sender);
    }

    /// @notice Add many ticket tiers in ONE transaction (a single wallet
    ///         confirmation), instead of one addTier call per tier. Same auth,
    ///         same freeze rule, one signature-reset at the end.
    function addTiers(TierInput[] calldata inputs) external returns (uint256[] memory ids) {
        _requireCanEditTiers();
        ids = new uint256[](inputs.length);
        for (uint256 i = 0; i < inputs.length; i++) {
            ids[i] = _addTierUnchecked(inputs[i]);
        }
        IShowContract(showContract).onTierChanged(msg.sender);
    }

    // ─── TICKET PURCHASE (lazy mint) ─────────────────────────────────────

    /// @notice Buy a ticket. Caller must approve this contract for at least tier.priceUSDC.
    ///         Fee breakdown: 2% xaoFee + $1 gas → treasury; remainder → ShowContract escrow.
    function buyTicket(uint256 tierId)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 tokenId)
    {
        // No sales until BOTH parties have signed. The collection is deployed at
        // contract creation (so tiers can be set during negotiation), so without
        // this guard a past on-sale date could let tickets sell on an unsigned
        // contract. isFinalized() flips true only when both parties have signed.
        require(IShowContract(showContract).isFinalized(), "Contract not signed yet");
        require(tierId < tierCount, "Invalid tierId");
        TicketTier storage tier = tiers[tierId];
        require(block.timestamp >= tier.onSaleTimestamp, "Not on sale yet");
        require(tier.sold < tier.quantity, "Sold out");
        require(totalSold < totalCapacity, "Capacity reached");

        uint256 gross = tier.priceUSDC;

        if (gross > 0) {
            // 1. Collect full gross from buyer
            require(usdc.transferFrom(msg.sender, address(this), gross), "Payment failed");

            // 2. Calculate protocol fees
            uint256 xaoFee      = gross * XAO_FEE_BPS / 10_000;
            uint256 totalFees   = xaoFee + GAS_ALLOTMENT;

            // Cap fees at gross for very cheap tickets
            if (totalFees > gross) totalFees = gross;
            uint256 net = gross - totalFees;

            // 3. Send fees to treasury
            if (totalFees > 0) {
                require(usdc.transfer(treasury, totalFees), "Fee transfer failed");
            }

            // 4. Send net to ShowContract escrow
            if (net > 0) {
                require(usdc.transfer(showContract, net), "Revenue transfer failed");
                IShowContract(showContract).creditRevenue(net);
            }
        }

        // 5. Lazy-mint NFT to buyer
        tokenId = _nextTokenId++;
        tokenToTier[tokenId] = tierId;
        tier.sold++;
        totalSold++;
        _mint(msg.sender, tokenId, 1, "");

        emit TicketSold(tokenId, tierId, msg.sender, gross);
    }

    // ─── SCANNING ────────────────────────────────────────────────────────

    /// @notice Scan a ticket.
    ///         Before doorsTime  → authentication only (emits TicketAuthenticated, does NOT set scanned).
    ///         At/after doorsTime → entry grant (sets scanned = true, emits TicketRedeemed).
    function scanTicket(uint256 tokenId) external onlyRole(SCANNER_ROLE) {
        require(tokenId < _nextTokenId, "Invalid token");

        IShowContract show = IShowContract(showContract);

        if (block.timestamp < show.doorsTime()) {
            // Auth only — do NOT mark as scanned
            emit TicketAuthenticated(tokenId, msg.sender, block.timestamp);
            return;
        }

        require(!scanned[tokenId], "Already redeemed");
        scanned[tokenId] = true;
        emit TicketRedeemed(tokenId, msg.sender, block.timestamp);
    }

    // ─── TRANSFER LOCK ───────────────────────────────────────────────────

    /// @dev Pre-endTime: transfers are only allowed via approved XAO marketplace operators.
    ///      Post-endTime: fully transferable collectible (no restriction).
    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 value,
        bytes memory data
    ) public override {
        if (from != address(0)) {
            IShowContract show = IShowContract(showContract);
            if (block.timestamp < show.endTime()) {
                require(approvedMarketplaces[msg.sender], "Transfers locked until show ends");
            }
        }
        super.safeTransferFrom(from, to, id, value, data);
    }

    /// @dev Batch version of the transfer lock.
    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values,
        bytes memory data
    ) public override {
        if (from != address(0)) {
            IShowContract show = IShowContract(showContract);
            if (block.timestamp < show.endTime()) {
                require(approvedMarketplaces[msg.sender], "Transfers locked until show ends");
            }
        }
        super.safeBatchTransferFrom(from, to, ids, values, data);
    }

    // ─── ERC-2981 ROYALTIES ──────────────────────────────────────────────

    /// @notice Returns ShowContract as royalty receiver; amount = party1 + party2 resale split.
    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        public
        view
        override
        returns (address receiver, uint256 royaltyAmount)
    {
        require(tokenId < _nextTokenId, "Invalid token");
        TicketTier storage tier = tiers[tokenToTier[tokenId]];
        uint256 totalRoyaltyBPS = tier.party1ResaleBPS + tier.party2ResaleBPS;
        return (showContract, salePrice * totalRoyaltyBPS / 10_000);
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

    /// @notice ERC-1155 metadata. Returns an on-chain JSON data URI whose
    ///         `image` is the ticket type's artwork, so wallets and
    ///         marketplaces render the NFT image without any external metadata
    ///         hosting. `tokenId` maps to its tier via `tokenToTier`.
    /// @dev    Assumes eventName / tier image contain no unescaped `"`.
    function uri(uint256 tokenId) public view override returns (string memory) {
        TicketTier storage tier = tiers[tokenToTier[tokenId]];
        string memory tierName = bytes(tier.customName).length > 0 ? tier.customName : "Ticket";
        // base64-encoded data URI — the format wallets, marketplaces, and
        // explorers reliably parse (the raw `;utf8,` variant is not universally
        // supported).
        string memory json = string(
            abi.encodePacked(
                '{"name":"', eventName, ' - ', tierName,
                '","description":"XAO event ticket","image":"', tier.image, '"}'
            )
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
    }

    function pause()   external onlyRole(ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(ADMIN_ROLE) { _unpause(); }

    // ─── VIEW HELPERS ────────────────────────────────────────────────────

    function getTier(uint256 tierId) external view returns (TicketTier memory) {
        require(tierId < tierCount, "Invalid tierId");
        return tiers[tierId];
    }

    function nextTokenId() external view returns (uint256) {
        return _nextTokenId;
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
