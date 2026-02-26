// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./XAOTicket.sol";

interface IShowUSDC {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title ShowContract — XAO Show Agreement + Escrow (Phase 1 MVP)
/// @notice Replaces EventContract. Governs show agreements between promoters,
///         artists, venues, and booking agents. Manages payment schedules,
///         escrow, cancellation refunds, dispute gating, and XAOTicket deployment.
contract ShowContract is AccessControl, ReentrancyGuard, Pausable {

    // ─── ROLES ────────────────────────────────────────────────────────────
    bytes32 public constant ADMIN_ROLE    = keccak256("ADMIN_ROLE");
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");

    // ─── PROTOCOL CONSTANTS ───────────────────────────────────────────────
    uint256 public constant XAO_FEE_BPS       = 200;   // 2 %
    uint256 public constant GAS_ALLOTMENT     = 1e6;   // $1 USDC (6 decimals)
    uint256 public constant CONTRACT_EDIT_FEE = 1e6;   // $1 USDC per CID update

    // ─── ENUMS ────────────────────────────────────────────────────────────
    enum PartyRole { PROMOTER, ARTIST, VENUE, BOOKING_AGENT, PRODUCTION, OTHER }

    enum Status {
        DRAFT,
        PROPOSED,
        COUNTER_PROPOSED,
        APPROVED,
        ACTIVE,
        COMPLETED,
        CANCELLED,
        DISPUTED
    }

    // ─── CORE STRUCTS ─────────────────────────────────────────────────────
    struct Party {
        address   wallet;
        PartyRole role;
        string    xaoUsername;
    }

    struct PaymentSchedule {
        uint256 timestamp;   // when payment is due
        uint256 pctBPS;      // % of guarantee (informational)
        uint256 usdcAmount;  // absolute USDC amount
    }

    struct CancellationRefund {
        uint256 cutoffTimestamp; // if cancelled before this date...
        uint256 refundPctBPS;    // ...refund this % of deposit
        uint256 refundUSDC;      // auto-populated from pct
    }

    // ─── CONSTRUCTOR CONFIG STRUCTS ───────────────────────────────────────
    struct PartyConfig {
        address   wallet;
        PartyRole role;
        string    xaoUsername;
    }

    struct DatesConfig {
        uint256 announcementDate;
        uint256 eventStartDate;
        uint256 eventEndDate;      // defaults to eventStartDate if 0
        uint256 loadInTime;
        uint256 doorsTime;
        uint256 startTime;
        uint256 endTime;
        uint256 setTime;
        uint256 setLengthMinutes;
    }

    struct LocationConfig {
        string  venueName;
        string  venueAddress;
        uint256 radiusMiles;
        uint256 radiusDays;
    }

    struct TicketConfig {
        bool    ticketsEnabled;
        uint256 totalCapacity;
        uint256 salesTaxBPS;
    }

    struct FinancialConfig {
        uint256 guaranteeUSDC;    // flat dollar guarantee (mutually exclusive with pct)
        uint256 guaranteePctBPS;  // % of ticket sales as guarantee (mutually exclusive with flat)
        uint256 backendBPS;       // artist % of revenue beyond guarantee
        uint256 barSplitBPS;      // informational (non-enforceable in Phase 1)
        uint256 merchSplitBPS;    // informational (non-enforceable in Phase 1)
    }

    struct PromoConfig {
        string  eventName;
        string  flyerDNSLink;       // mutable IPNS/DNSLink reference
        bytes32 flyerCIDHash;       // immutable first-pin hash
        string  riderIPFSCID;
        string  contractLegal;
        string  ticketLegal;
        bytes32 contractCIDHash;    // sha256(IPFS CID of contract JSON)
    }

    // ─── PARTIES ──────────────────────────────────────────────────────────
    Party public party1;   // contract creator (usually promoter)
    Party public party2;   // recipient (usually artist)

    // ─── DATES & TIMES (Unix timestamps) ──────────────────────────────────
    uint256 public announcementDate;
    uint256 public eventStartDate;
    uint256 public eventEndDate;
    uint256 public loadInTime;
    uint256 public doorsTime;
    uint256 public startTime;
    uint256 public endTime;
    uint256 public setTime;
    uint256 public setLengthMinutes;

    // ─── LOCATION ─────────────────────────────────────────────────────────
    string  public venueName;
    string  public venueAddress;
    uint256 public radiusMiles;
    uint256 public radiusDays;

    // ─── TICKETS ──────────────────────────────────────────────────────────
    bool    public ticketsEnabled;
    uint256 public totalCapacity;
    uint256 public salesTaxBPS;

    // ─── FINANCIALS ───────────────────────────────────────────────────────
    uint256 public guaranteeUSDC;    // mutually exclusive with guaranteePctBPS
    uint256 public guaranteePctBPS;  // mutually exclusive with guaranteeUSDC
    uint256 public backendBPS;
    uint256 public barSplitBPS;
    uint256 public merchSplitBPS;

    // ─── PAYMENT SCHEDULES ────────────────────────────────────────────────
    PaymentSchedule[]   public party1Deposits;
    CancellationRefund[] public party1CancellationRefunds;
    PaymentSchedule[]   public party2Deposits;
    CancellationRefund[] public party2CancellationRefunds;
    PaymentSchedule[]   public party1Payouts;
    PaymentSchedule[]   public party2Payouts;

    // ─── PROMOTION ────────────────────────────────────────────────────────
    string  public eventName;
    string  public flyerDNSLink;
    bytes32 public originalFlyerCIDHash;

    // ─── LEGAL (IPFS CIDs stored as strings) ──────────────────────────────
    string public riderIPFSCID;
    string public contractLegalLanguage;
    string public ticketLegalLanguage;

    // ─── CONTRACT INTEGRITY ───────────────────────────────────────────────
    bytes32 public contractCIDHash;   // sha256(IPFS CID of signed contract JSON)

    // ─── SIGNING & STATUS ─────────────────────────────────────────────────
    mapping(address => bool) public hasSigned;
    bool   public isFinalized;
    Status public status;

    // ─── ESCROW ───────────────────────────────────────────────────────────
    uint256 public escrowBalance;
    address public ticketCollection;   // XAOTicket contract deployed on finalization

    // ─── PROTOCOL REFERENCES ──────────────────────────────────────────────
    IShowUSDC public immutable usdc;
    address   public immutable treasury;

    // ─── DISPUTE STATE ────────────────────────────────────────────────────
    mapping(address => bool) public hasVotedResolve;
    mapping(address => bool) public resolveVote;   // true = releaseToParty2

    // ─── EVENTS ───────────────────────────────────────────────────────────
    event ContractSigned(address indexed signer, Status newStatus);
    event ContractFinalized(address indexed contractAddr, bytes32 cidHash);
    event ContractUpdated(address indexed contractAddr, bytes32 newCIDHash, address indexed updatedBy);
    event ContractCancelled(address indexed by);
    event DisputeOpened(address indexed contractAddr, address indexed raisedBy);
    event DisputeResolved(address indexed contractAddr, bool releasedToParty2);
    event EscrowDeposited(address indexed depositor, uint256 amount);
    event EscrowWithdrawn(address indexed recipient, uint256 amount);
    event TicketCollectionDeployed(address indexed ticketContract);
    event RevenueReceived(uint256 amount);
    event StatusChanged(Status newStatus);

    // ─── MODIFIERS ────────────────────────────────────────────────────────
    modifier onlyParty() {
        require(
            msg.sender == party1.wallet || msg.sender == party2.wallet,
            "Not a party"
        );
        _;
    }

    modifier onlyParty1() {
        require(msg.sender == party1.wallet, "Not party1");
        _;
    }

    modifier notFinalized() {
        require(!isFinalized, "Already finalized");
        _;
    }

    modifier notTerminal() {
        require(
            status != Status.CANCELLED && status != Status.COMPLETED,
            "Terminal state"
        );
        _;
    }

    modifier notDisputed() {
        require(status != Status.DISPUTED, "Escrow frozen");
        _;
    }

    // ─── CONSTRUCTOR ──────────────────────────────────────────────────────

    constructor(
        PartyConfig    memory _p1,
        address               _p2Wallet,
        PartyRole             _p2Role,
        DatesConfig    memory _dates,
        LocationConfig memory _loc,
        TicketConfig   memory _tickets,
        FinancialConfig memory _fin,
        PromoConfig    memory _promo,
        address               _usdc,
        address               _treasury
    ) {
        require(_p1.wallet != address(0) && _p2Wallet != address(0), "Zero party address");
        require(_usdc != address(0) && _treasury != address(0), "Zero protocol address");
        require(
            !(_fin.guaranteeUSDC > 0 && _fin.guaranteePctBPS > 0),
            "Guarantee: use flat or pct, not both"
        );

        // Parties
        party1 = Party(_p1.wallet, _p1.role, _p1.xaoUsername);
        party2 = Party(_p2Wallet, _p2Role, "");

        // Dates
        announcementDate = _dates.announcementDate;
        eventStartDate   = _dates.eventStartDate;
        eventEndDate     = _dates.eventEndDate > 0 ? _dates.eventEndDate : _dates.eventStartDate;
        loadInTime       = _dates.loadInTime;
        doorsTime        = _dates.doorsTime;
        startTime        = _dates.startTime;
        endTime          = _dates.endTime;
        setTime          = _dates.setTime;
        setLengthMinutes = _dates.setLengthMinutes;

        // Location
        venueName    = _loc.venueName;
        venueAddress = _loc.venueAddress;
        radiusMiles  = _loc.radiusMiles;
        radiusDays   = _loc.radiusDays;

        // Tickets
        ticketsEnabled = _tickets.ticketsEnabled;
        totalCapacity  = _tickets.totalCapacity;
        salesTaxBPS    = _tickets.salesTaxBPS;

        // Financials
        guaranteeUSDC   = _fin.guaranteeUSDC;
        guaranteePctBPS = _fin.guaranteePctBPS;
        backendBPS      = _fin.backendBPS;
        barSplitBPS     = _fin.barSplitBPS;
        merchSplitBPS   = _fin.merchSplitBPS;

        // Promo / legal
        eventName            = _promo.eventName;
        flyerDNSLink         = _promo.flyerDNSLink;
        originalFlyerCIDHash = _promo.flyerCIDHash;
        riderIPFSCID         = _promo.riderIPFSCID;
        contractLegalLanguage = _promo.contractLegal;
        ticketLegalLanguage  = _promo.ticketLegal;
        contractCIDHash      = _promo.contractCIDHash;

        // Protocol
        usdc     = IShowUSDC(_usdc);
        treasury = _treasury;

        status = Status.DRAFT;

        _grantRole(DEFAULT_ADMIN_ROLE, _p1.wallet);
        _grantRole(ADMIN_ROLE, _p1.wallet);
    }

    // ─── SIGNING ──────────────────────────────────────────────────────────

    /// @notice Sign the contract.
    ///         party1 signs first → PROPOSED.
    ///         party2 signs (PROPOSED or COUNTER_PROPOSED) → APPROVED.
    ///         On APPROVED: isFinalized = true, XAOTicket deployed if ticketsEnabled.
    function sign() external onlyParty whenNotPaused {
        require(!hasSigned[msg.sender], "Already signed");
        require(!isFinalized, "Already finalized");
        require(
            status != Status.CANCELLED &&
            status != Status.COMPLETED &&
            status != Status.DISPUTED,
            "Terminal or disputed state"
        );

        hasSigned[msg.sender] = true;

        if (hasSigned[party1.wallet] && hasSigned[party2.wallet]) {
            isFinalized = true;
            status = Status.APPROVED;
            if (ticketsEnabled) {
                _deployTicketCollection();
            }
            emit ContractFinalized(address(this), contractCIDHash);
        } else if (msg.sender == party1.wallet) {
            if (status == Status.DRAFT || status == Status.COUNTER_PROPOSED) {
                status = Status.PROPOSED;
            }
        }
        // party2 signs while PROPOSED → wait for the finalized check above
        // (hasSigned[party2] = true, but hasSigned[party1] may be false after counter-prop)

        emit ContractSigned(msg.sender, status);
    }

    /// @dev Deploy an XAOTicket for this show and grant party1 ADMIN_ROLE on it.
    function _deployTicketCollection() internal {
        XAOTicket ticket = new XAOTicket(
            address(this),
            address(usdc),
            treasury,
            eventName,
            totalCapacity
        );
        ticketCollection = address(ticket);
        // Grant party1 admin so they can add tiers and scanners
        ticket.grantRole(ticket.ADMIN_ROLE(), party1.wallet);
        emit TicketCollectionDeployed(address(ticket));
    }

    // ─── CID UPDATE (with edit fee) ───────────────────────────────────────

    /// @notice Update the contract IPFS CID. Charges $1 USDC edit fee to caller.
    ///         Reverts if contract is already finalized.
    ///         If party2 edits while PROPOSED → COUNTER_PROPOSED (resets party1 sig).
    ///         If party1 edits while COUNTER_PROPOSED → PROPOSED (resets party2 sig).
    function updateContractCID(bytes32 newCIDHash)
        external
        onlyParty
        notFinalized
        whenNotPaused
        nonReentrant
    {
        require(usdc.transferFrom(msg.sender, treasury, CONTRACT_EDIT_FEE), "Edit fee failed");

        if (status == Status.PROPOSED && msg.sender == party2.wallet) {
            hasSigned[party1.wallet] = false;
            status = Status.COUNTER_PROPOSED;
        } else if (status == Status.COUNTER_PROPOSED && msg.sender == party1.wallet) {
            hasSigned[party2.wallet] = false;
            status = Status.PROPOSED;
        }

        contractCIDHash = newCIDHash;
        emit ContractUpdated(address(this), newCIDHash, msg.sender);
    }

    // ─── CANCEL ───────────────────────────────────────────────────────────

    function cancelContract() external onlyParty notTerminal whenNotPaused {
        status = Status.CANCELLED;
        emit ContractCancelled(msg.sender);
    }

    // ─── DISPUTE GATE ─────────────────────────────────────────────────────

    /// @notice Freeze escrow by raising a dispute. Only valid after finalization.
    function raiseDispute() external onlyParty whenNotPaused {
        require(isFinalized, "Not finalized");
        require(
            status != Status.CANCELLED &&
            status != Status.COMPLETED &&
            status != Status.DISPUTED,
            "Invalid state for dispute"
        );
        status = Status.DISPUTED;
        emit DisputeOpened(address(this), msg.sender);
    }

    /// @notice Both parties must call resolveDispute() with the same _releaseToParty2 value.
    ///         On agreement: escrow is released and status becomes COMPLETED.
    function resolveDispute(bool releaseToParty2)
        external
        onlyParty
        nonReentrant
        whenNotPaused
    {
        require(status == Status.DISPUTED, "Not disputed");
        require(!hasVotedResolve[msg.sender], "Already voted");

        hasVotedResolve[msg.sender] = true;
        resolveVote[msg.sender] = releaseToParty2;

        // Only execute when both parties have voted
        if (hasVotedResolve[party1.wallet] && hasVotedResolve[party2.wallet]) {
            require(
                resolveVote[party1.wallet] == resolveVote[party2.wallet],
                "Parties disagree on resolution"
            );

            bool toParty2 = resolveVote[party1.wallet];
            status = Status.COMPLETED;

            if (escrowBalance > 0) {
                uint256 amount = escrowBalance;
                escrowBalance = 0;
                address recipient = toParty2 ? party2.wallet : party1.wallet;
                require(usdc.transfer(recipient, amount), "Transfer failed");
                emit EscrowWithdrawn(recipient, amount);
            }
            emit DisputeResolved(address(this), toParty2);
            emit StatusChanged(Status.COMPLETED);
        }
    }

    // ─── ESCROW ───────────────────────────────────────────────────────────

    /// @notice Deposit USDC into escrow (guarantee, advance, etc.).
    function depositGuarantee(uint256 amount)
        external
        onlyParty
        nonReentrant
        notDisputed
        whenNotPaused
    {
        require(isFinalized, "Not finalized");
        require(amount > 0, "Zero amount");
        require(usdc.transferFrom(msg.sender, address(this), amount), "Transfer failed");
        escrowBalance += amount;
        emit EscrowDeposited(msg.sender, amount);
    }

    /// @notice Called by XAOTicket after routing net revenue to this contract.
    ///         XAOTicket transfers USDC directly then calls this to update the escrow counter.
    function creditRevenue(uint256 amount) external nonReentrant notDisputed {
        require(msg.sender == ticketCollection, "Not ticket contract");
        require(amount > 0, "Zero amount");
        escrowBalance += amount;
        emit RevenueReceived(amount);
    }

    /// @notice Party1 withdraws from escrow after the show is COMPLETED.
    function withdrawEscrow(address to, uint256 amount)
        external
        onlyParty1
        nonReentrant
        whenNotPaused
    {
        require(status == Status.COMPLETED, "Not completed");
        require(to != address(0), "Zero address");
        require(amount > 0 && amount <= escrowBalance, "Invalid amount");
        escrowBalance -= amount;
        require(usdc.transfer(to, amount), "Transfer failed");
        emit EscrowWithdrawn(to, amount);
    }

    /// @notice Party1 marks the show as COMPLETED (can only be called after endTime).
    function markCompleted() external onlyParty1 notDisputed whenNotPaused {
        require(
            status == Status.APPROVED || status == Status.ACTIVE,
            "Must be APPROVED or ACTIVE"
        );
        require(block.timestamp >= endTime, "Show not ended yet");
        status = Status.COMPLETED;
        emit StatusChanged(Status.COMPLETED);
    }

    // ─── PAYMENT SCHEDULE MANAGEMENT ──────────────────────────────────────

    function addParty1Deposit(uint256 ts, uint256 pct, uint256 amt)
        external onlyParty1 notFinalized
    {
        party1Deposits.push(PaymentSchedule(ts, pct, amt));
    }

    function addParty2Deposit(uint256 ts, uint256 pct, uint256 amt)
        external onlyParty1 notFinalized
    {
        party2Deposits.push(PaymentSchedule(ts, pct, amt));
    }

    function addParty1Payout(uint256 ts, uint256 pct, uint256 amt)
        external onlyParty1 notFinalized
    {
        party1Payouts.push(PaymentSchedule(ts, pct, amt));
    }

    function addParty2Payout(uint256 ts, uint256 pct, uint256 amt)
        external onlyParty1 notFinalized
    {
        party2Payouts.push(PaymentSchedule(ts, pct, amt));
    }

    function addParty1CancellationRefund(uint256 cutoff, uint256 pct, uint256 amt)
        external onlyParty1 notFinalized
    {
        party1CancellationRefunds.push(CancellationRefund(cutoff, pct, amt));
    }

    function addParty2CancellationRefund(uint256 cutoff, uint256 pct, uint256 amt)
        external onlyParty1 notFinalized
    {
        party2CancellationRefunds.push(CancellationRefund(cutoff, pct, amt));
    }

    // ─── VIEW HELPERS ─────────────────────────────────────────────────────

    function getParty1Deposits()             external view returns (PaymentSchedule[]   memory) { return party1Deposits; }
    function getParty2Deposits()             external view returns (PaymentSchedule[]   memory) { return party2Deposits; }
    function getParty1Payouts()              external view returns (PaymentSchedule[]   memory) { return party1Payouts; }
    function getParty2Payouts()              external view returns (PaymentSchedule[]   memory) { return party2Payouts; }
    function getParty1CancellationRefunds()  external view returns (CancellationRefund[] memory) { return party1CancellationRefunds; }
    function getParty2CancellationRefunds()  external view returns (CancellationRefund[] memory) { return party2CancellationRefunds; }

    // ─── MISC SETTERS ─────────────────────────────────────────────────────

    function setParty2Username(string memory username) external {
        require(msg.sender == party2.wallet, "Not party2");
        party2.xaoUsername = username;
    }

    function setFlyerDNSLink(string memory link) external onlyParty {
        flyerDNSLink = link;
    }

    // ─── ADMIN ────────────────────────────────────────────────────────────

    function pause()   external onlyRole(ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(ADMIN_ROLE) { _unpause(); }
}
