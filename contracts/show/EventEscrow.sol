// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IShowBundle.sol";

/// @title EventEscrow — custody and payout engine for one show (Phase 2A)
/// @notice Holds every dollar tied to a show: party deposits and ticket
///         revenue. Funding milestones, payout rules, cancellation splits and
///         the final sweep are fixed at creation and enforced here.
///         On cancellation, ticket buyers are refunded first, in batches,
///         before anything else is distributed.
///         XAO's 2% of each ticket is held here and paid to the treasury only
///         when the show completes; it is released back to the buyer on refund.
/// @dev Deployed as a minimal-proxy clone by ShowFactory and set up via
///      initialize(). A payment that the token refuses (for example a
///      blocked recipient) is parked for that recipient to claim, so one bad
///      address cannot stall refunds or payouts for everyone else.
contract EventEscrow is ReentrancyGuard {

    error AlreadyInitialized();
    error NotFactory();
    error NotAParty();
    error NotTicketContract();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidBps();
    error RulesNotSorted();
    error InvalidPayoutRule();
    error InvalidSweepRule();
    error InvalidCancelRules();
    error TicketContractAlreadySet();
    error NotActive();
    error NotRefunding();
    error NotCompleted();
    error NotFinalized();
    error Frozen();
    error NotFrozen();
    error ShowAlreadyEnded();
    error MilestoneNotMissed();
    error InvalidBatchSize();
    error RefundsNotFinished();
    error InsufficientFundsForRefund();
    error SweepNotDue();
    error InvalidResolution();
    error NothingToClaim();
    error NothingToDistribute();
    error TransferFailed();

    // ─── ENUMS ────────────────────────────────────────────────────────────
    enum EscrowStatus { Active, Refunding, Completed, Expired }

    enum PayoutKind { FixedAmount, PercentageOfCurrentBalance }

    enum CancelReason { Manual, MissedFunding }

    /// @dev Interim dispute outcomes, used until the ArbitrationAgent exists.
    enum Resolution { None, Resume, ReleaseToPartyA, ReleaseToPartyB }

    // ─── STRUCTS ──────────────────────────────────────────────────────────
    struct FundingMilestone {
        uint64  byTime;
        uint256 minFunded;      // cumulative funding required by the deadline
    }

    struct PayoutRule {
        address    to;
        PayoutKind kind;
        uint256    value;       // amount, or bps (1–10000) of the current balance
        uint64     notBefore;
        bool       executed;
        bool       isGuarantee;
    }

    struct PayoutRuleInput {
        address    to;
        PayoutKind kind;
        uint256    value;
        uint64     notBefore;
        bool       isGuarantee;
    }

    struct SweepRule {
        address[] recipients;
        uint16[]  bps;          // sums to 10000
        uint64    notBefore;    // typically the show end time
    }

    /// @dev Applies to what is left after ticket refunds.
    struct CancelRule {
        uint64 notAfter;
        uint16 payBpsToPartyA;
        uint16 payBpsToPartyB;
        uint16 treasuryBps;
    }

    struct EscrowInit {
        bytes32            showId;
        address            show;
        address            partyA;
        address            partyB;     // may be address(0)
        address            payoutToken;
        address            treasury;
        FundingMilestone[] funding;
        PayoutRuleInput[]  payoutRules;
        SweepRule          sweep;
        CancelRule[]       cancelRules;
        uint16             defaultCancelRefundBps;
    }

    uint256 public constant MAX_BATCH = 200;

    // ─── STATE ────────────────────────────────────────────────────────────
    bytes32 public showId;
    IShowInstanceLike public show;
    address public factory;
    address public partyA;
    address public partyB;
    IERC20  public payoutToken;
    address public treasury;
    address public ticketContract;     // 0 if tickets are disabled

    EscrowStatus public status;

    FundingMilestone[] internal fundingMilestones;
    PayoutRule[]       internal payoutRules;
    SweepRule          internal sweepRule;
    CancelRule[]       internal cancelRules;
    bool public sweepExecuted;

    /// @notice Everything ever paid in: party deposits plus net ticket revenue.
    uint256 public totalFunded;
    /// @notice XAO's share of ticket sales, held until the show completes.
    uint256 public protocolFeeAccrued;
    /// @notice Payments the token refused, waiting for their recipient to claim.
    mapping(address => uint256) public unclaimed;
    uint256 public unclaimedTotal;

    // Refunds
    uint16  public defaultCancelRefundBps;
    uint16  public refundBps;
    uint64  public cancelledAt;
    uint256 public refundCursor;       // next tokenId to process
    uint256 public maxRefundTokenId;
    mapping(uint256 => bool) public refunded;
    uint256 public refundedCount;

    // Dispute
    bytes32 public activeCaseId;
    uint256 public disputeNonce;
    mapping(bytes32 => mapping(address => Resolution)) public resolutionVote;

    bool public initialized;

    // ─── EVENTS ───────────────────────────────────────────────────────────
    event Deposited(address indexed from, uint256 amount);
    event TicketRevenueReceived(uint256 escrowed, uint256 protocolFee);
    event PayoutExecuted(uint256 indexed ruleIndex, address indexed to, uint256 amount);
    event PayoutSkipped(uint256 indexed ruleIndex, uint256 required, uint256 available);
    event ProtocolFeePaid(uint256 amount);
    event FinalSweepExecuted(uint256 amount);
    event EscrowCompleted();

    event RefundingStarted(CancelReason reason, uint16 refundBps, uint256 maxRefundTokenId);
    event RefundProcessed(uint256 indexed tokenId, address indexed recipient, uint256 amount);
    event RefundProgress(uint256 nextCursor, uint256 refundedCount);
    event CancellationFinalized(uint256 ruleIndex, uint256 paidToA, uint256 paidToB, uint256 paidToTreasury);

    event DisputeRaised(bytes32 indexed caseId, address indexed by);
    event DisputeVoted(bytes32 indexed caseId, address indexed by, Resolution resolution);
    event DisputeSettled(bytes32 indexed caseId, Resolution resolution);

    event PaymentHeld(address indexed recipient, uint256 amount);
    event Claimed(address indexed recipient, uint256 amount);
    event LateFundsDistributed(uint256 amount);

    // ─── MODIFIERS ────────────────────────────────────────────────────────
    modifier onlyParty() {
        if (msg.sender != partyA && (partyB == address(0) || msg.sender != partyB)) revert NotAParty();
        _;
    }

    modifier whenActive() {
        if (status != EscrowStatus.Active) revert NotActive();
        _;
    }

    modifier notFrozen() {
        if (show.isFrozen()) revert Frozen();
        _;
    }

    /// @dev Locks the implementation; only clones can be initialized.
    constructor() {
        initialized = true;
    }

    // ─── INITIALIZATION ───────────────────────────────────────────────────

    function initialize(EscrowInit calldata init) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        factory = msg.sender;

        if (
            init.show == address(0) ||
            init.partyA == address(0) ||
            init.payoutToken == address(0) ||
            init.treasury == address(0)
        ) revert ZeroAddress();
        if (init.defaultCancelRefundBps > 10_000) revert InvalidBps();

        showId      = init.showId;
        show        = IShowInstanceLike(init.show);
        partyA      = init.partyA;
        partyB      = init.partyB;
        payoutToken = IERC20(init.payoutToken);
        treasury    = init.treasury;
        defaultCancelRefundBps = init.defaultCancelRefundBps;

        uint64 last;
        for (uint256 i = 0; i < init.funding.length; i++) {
            if (init.funding[i].byTime < last) revert RulesNotSorted();
            last = init.funding[i].byTime;
            fundingMilestones.push(init.funding[i]);
        }

        last = 0;
        for (uint256 i = 0; i < init.payoutRules.length; i++) {
            PayoutRuleInput calldata r = init.payoutRules[i];
            if (r.to == address(0) || r.value == 0) revert InvalidPayoutRule();
            if (r.kind == PayoutKind.PercentageOfCurrentBalance && r.value > 10_000) revert InvalidPayoutRule();
            if (r.notBefore < last) revert RulesNotSorted();
            last = r.notBefore;
            payoutRules.push(PayoutRule(r.to, r.kind, r.value, r.notBefore, false, r.isGuarantee));
        }

        uint256 n = init.sweep.recipients.length;
        if (n == 0 || n != init.sweep.bps.length) revert InvalidSweepRule();
        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            if (init.sweep.recipients[i] == address(0)) revert InvalidSweepRule();
            sum += init.sweep.bps[i];
            sweepRule.recipients.push(init.sweep.recipients[i]);
            sweepRule.bps.push(init.sweep.bps[i]);
        }
        if (sum != 10_000) revert InvalidSweepRule();
        sweepRule.notBefore = init.sweep.notBefore;

        // Cancel rules are time windows in ascending order; the last one must
        // be open-ended so every cancellation has a rule.
        n = init.cancelRules.length;
        if (n == 0) revert InvalidCancelRules();
        last = 0;
        for (uint256 i = 0; i < n; i++) {
            CancelRule calldata c = init.cancelRules[i];
            if (uint256(c.payBpsToPartyA) + c.payBpsToPartyB + c.treasuryBps != 10_000) {
                revert InvalidCancelRules();
            }
            if (c.notAfter < last) revert RulesNotSorted();
            last = c.notAfter;
            cancelRules.push(c);
        }
        if (last != type(uint64).max) revert InvalidCancelRules();
    }

    /// @notice Factory links the ticket contract once it has been deployed.
    function setTicketContract(address _ticketContract) external {
        if (msg.sender != factory) revert NotFactory();
        if (ticketContract != address(0)) revert TicketContractAlreadySet();
        if (_ticketContract == address(0)) revert ZeroAddress();
        ticketContract = _ticketContract;
    }

    // ─── FUNDING ──────────────────────────────────────────────────────────

    /// @notice Deposit into escrow (guarantee, advance, top-up). Open once the
    ///         show is signed, and during refunding so a shortfall can be covered.
    function deposit(uint256 amount) external nonReentrant {
        if (status != EscrowStatus.Active && status != EscrowStatus.Refunding) revert NotActive();
        if (!show.isFinalized()) revert NotFinalized();
        if (show.isFrozen()) revert Frozen();
        if (amount == 0) revert ZeroAmount();

        totalFunded += amount;
        _pullToken(msg.sender, amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Called by the ticket contract right after it has transferred
    ///         `escrowed` here. `protocolFee` of it is held for XAO.
    function creditTicketSale(uint256 escrowed, uint256 protocolFee) external whenActive notFrozen {
        if (msg.sender != ticketContract) revert NotTicketContract();
        protocolFeeAccrued += protocolFee;
        totalFunded += escrowed - protocolFee;
        emit TicketRevenueReceived(escrowed, protocolFee);
    }

    // ─── NORMAL PAYOUTS ───────────────────────────────────────────────────

    /// @notice Execute every payout rule that is due. Anyone may call.
    ///         A fixed payout that cannot be covered yet is skipped, not failed.
    function executeAvailablePayouts() external nonReentrant whenActive notFrozen {
        if (!show.isFinalized()) revert NotFinalized();

        uint256 len = payoutRules.length;
        for (uint256 i = 0; i < len; i++) {
            PayoutRule storage rule = payoutRules[i];
            if (rule.executed || block.timestamp < rule.notBefore) continue;

            uint256 available = distributable();
            uint256 amount;
            if (rule.kind == PayoutKind.FixedAmount) {
                if (available < rule.value) {
                    emit PayoutSkipped(i, rule.value, available);
                    continue;
                }
                amount = rule.value;
            } else {
                amount = available * rule.value / 10_000;
                // An empty escrow must not use up a percentage rule.
                if (amount == 0) {
                    emit PayoutSkipped(i, 0, available);
                    continue;
                }
            }

            rule.executed = true;
            _pay(rule.to, amount);
            emit PayoutExecuted(i, rule.to, amount);
        }
    }

    /// @notice Pay XAO its held fee, split what remains per the sweep rule and
    ///         complete the show. Anyone may call once the sweep is due.
    function executeFinalSweep() external nonReentrant whenActive notFrozen {
        if (!show.isFinalized()) revert NotFinalized();
        if (block.timestamp < sweepRule.notBefore) revert SweepNotDue();

        sweepExecuted = true;
        status = EscrowStatus.Completed;

        _payProtocolFee();
        uint256 amount = distributable();
        _splitBySweep(amount);

        emit FinalSweepExecuted(amount);
        emit EscrowCompleted();
        show.onCompleted();
    }

    // ─── CANCELLATION ─────────────────────────────────────────────────────

    /// @notice Either party can cancel until the show's end time.
    function cancel() external onlyParty whenActive notFrozen {
        if (block.timestamp >= show.showEndTime()) revert ShowAlreadyEnded();
        _startRefunding(CancelReason.Manual);
    }

    /// @notice Anyone can cancel a show whose funding milestone was missed.
    function cancelForMissedFunding(uint256 milestoneIndex) external whenActive notFrozen {
        FundingMilestone storage m = fundingMilestones[milestoneIndex];
        if (block.timestamp <= m.byTime || totalFunded >= m.minFunded) revert MilestoneNotMissed();
        _startRefunding(CancelReason.MissedFunding);
    }

    /// @notice Refund the next batch of tickets to whoever holds them now.
    ///         Anyone may call, repeatedly, until every ticket is processed.
    function continueRefunds(uint256 maxToProcess) external nonReentrant {
        if (status != EscrowStatus.Refunding) revert NotRefunding();
        if (maxToProcess == 0 || maxToProcess > MAX_BATCH) revert InvalidBatchSize();

        IShowTicketLike ticket = IShowTicketLike(ticketContract);
        uint256 cursor = refundCursor;
        uint256 maxId  = maxRefundTokenId;
        uint256 processed;

        while (cursor <= maxId && processed < maxToProcess) {
            uint256 tokenId = cursor;
            cursor++;
            processed++;

            if (refunded[tokenId] || !ticket.exists(tokenId)) continue;

            (uint256 escrowed, uint256 protocolFee) = ticket.getRefundBasis(tokenId);
            uint256 amount    = escrowed * refundBps / 10_000;
            uint256 feeWaived = protocolFee * refundBps / 10_000;

            protocolFeeAccrued -= feeWaived;
            if (amount > distributable()) revert InsufficientFundsForRefund();

            address recipient = ticket.ownerOf(tokenId);
            refunded[tokenId] = true;
            refundedCount++;
            ticket.burnRefunded(tokenId);

            _pay(recipient, amount);
            emit RefundProcessed(tokenId, recipient, amount);
        }

        refundCursor = cursor;
        emit RefundProgress(cursor, refundedCount);
    }

    /// @notice Once every ticket is refunded, split what remains per the
    ///         cancel rule that applied at the time of cancellation.
    function finalizeCancellationPayout() external nonReentrant {
        if (status != EscrowStatus.Refunding) revert NotRefunding();
        if (refundCursor <= maxRefundTokenId) revert RefundsNotFinished();

        status = EscrowStatus.Completed;
        _payProtocolFee();

        uint256 ruleIndex = _cancelRuleIndexAt(cancelledAt);
        CancelRule storage rule = cancelRules[ruleIndex];
        uint256 remaining  = distributable();
        uint256 toTreasury = remaining * rule.treasuryBps / 10_000;
        uint256 toB        = remaining * rule.payBpsToPartyB / 10_000;
        uint256 toA        = remaining - toTreasury - toB;

        if (partyB == address(0)) {
            toA += toB;
            toB = 0;
        }

        _pay(partyA, toA);
        _pay(partyB, toB);
        _pay(treasury, toTreasury);

        emit CancellationFinalized(ruleIndex, toA, toB, toTreasury);
        emit EscrowCompleted();
    }

    // ─── DISPUTE (interim: resolved by the parties) ───────────────────────

    /// @notice Freeze the escrow. No deposits, payouts or cancellation while frozen.
    function raiseDispute() external onlyParty whenActive notFrozen {
        if (!show.isFinalized()) revert NotFinalized();

        bytes32 caseId = keccak256(abi.encodePacked(showId, ++disputeNonce));
        activeCaseId = caseId;
        show.onDisputeOpened(caseId);
        emit DisputeRaised(caseId, msg.sender);
    }

    /// @notice Each party votes; the dispute settles when the votes match.
    ///         A party may change its vote until then.
    function resolveDispute(Resolution resolution) external onlyParty nonReentrant {
        bytes32 caseId = activeCaseId;
        if (caseId == bytes32(0)) revert NotFrozen();
        if (resolution == Resolution.None) revert InvalidResolution();
        if (resolution == Resolution.ReleaseToPartyB && partyB == address(0)) revert InvalidResolution();

        resolutionVote[caseId][msg.sender] = resolution;
        emit DisputeVoted(caseId, msg.sender, resolution);

        if (partyB != address(0) && resolutionVote[caseId][partyA] != resolutionVote[caseId][partyB]) {
            return;
        }

        activeCaseId = bytes32(0);
        show.onDisputeResolved(caseId);
        emit DisputeSettled(caseId, resolution);

        if (resolution == Resolution.Resume) return;

        status = EscrowStatus.Completed;
        _payProtocolFee();
        _pay(resolution == Resolution.ReleaseToPartyA ? partyA : partyB, distributable());
        emit EscrowCompleted();
        show.onCompleted();
    }

    // ─── AFTER COMPLETION ─────────────────────────────────────────────────

    /// @notice Collect a payment the token refused when it was first sent.
    function claim() external nonReentrant {
        uint256 amount = unclaimed[msg.sender];
        if (amount == 0) revert NothingToClaim();

        unclaimed[msg.sender] = 0;
        unclaimedTotal -= amount;
        if (!_tryTransfer(msg.sender, amount)) revert TransferFailed();
        emit Claimed(msg.sender, amount);
    }

    /// @notice Split funds that arrive after completion (for example resale
    ///         royalties) per the sweep rule. Anyone may call.
    function distributeLateFunds() external nonReentrant {
        if (status != EscrowStatus.Completed) revert NotCompleted();
        uint256 amount = distributable();
        if (amount == 0) revert NothingToDistribute();
        _splitBySweep(amount);
        emit LateFundsDistributed(amount);
    }

    // ─── VIEWS ────────────────────────────────────────────────────────────

    function escrowBalance() public view returns (uint256) {
        return payoutToken.balanceOf(address(this));
    }

    /// @notice Balance not already owed to XAO or to a held payment.
    function distributable() public view returns (uint256) {
        uint256 balance  = escrowBalance();
        uint256 reserved = protocolFeeAccrued + unclaimedTotal;
        return balance > reserved ? balance - reserved : 0;
    }

    function getFundingMilestones() external view returns (FundingMilestone[] memory) {
        return fundingMilestones;
    }

    function getPayoutRules() external view returns (PayoutRule[] memory) {
        return payoutRules;
    }

    function getSweepRule() external view returns (SweepRule memory) {
        return sweepRule;
    }

    function getCancelRules() external view returns (CancelRule[] memory) {
        return cancelRules;
    }

    // ─── INTERNAL ─────────────────────────────────────────────────────────

    function _startRefunding(CancelReason reason) internal {
        status       = EscrowStatus.Refunding;
        cancelledAt  = uint64(block.timestamp);
        refundBps    = defaultCancelRefundBps;
        refundCursor = 1;
        maxRefundTokenId = ticketContract == address(0)
            ? 0
            : IShowTicketLike(ticketContract).lastMintedId();

        show.onCancelled();
        emit RefundingStarted(reason, refundBps, maxRefundTokenId);
    }

    function _cancelRuleIndexAt(uint64 time) internal view returns (uint256) {
        uint256 len = cancelRules.length;
        for (uint256 i = 0; i < len; i++) {
            if (time <= cancelRules[i].notAfter) return i;
        }
        return len - 1;
    }

    function _payProtocolFee() internal {
        uint256 fee = protocolFeeAccrued;
        if (fee == 0) return;
        protocolFeeAccrued = 0;
        _pay(treasury, fee);
        emit ProtocolFeePaid(fee);
    }

    /// @dev The last recipient takes the rounding remainder so nothing is left behind.
    function _splitBySweep(uint256 amount) internal {
        uint256 n = sweepRule.recipients.length;
        uint256 paid;
        for (uint256 i = 0; i < n; i++) {
            uint256 share = i == n - 1 ? amount - paid : amount * sweepRule.bps[i] / 10_000;
            paid += share;
            _pay(sweepRule.recipients[i], share);
        }
    }

    /// @dev Sends `amount`, or parks it for the recipient if the token refuses.
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (!_tryTransfer(to, amount)) {
            unclaimed[to] += amount;
            unclaimedTotal += amount;
            emit PaymentHeld(to, amount);
        }
    }

    function _tryTransfer(address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory data) = address(payoutToken).call(
            abi.encodeCall(IERC20.transfer, (to, amount))
        );
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }

    function _pullToken(address from, uint256 amount) internal {
        (bool ok, bytes memory data) = address(payoutToken).call(
            abi.encodeCall(IERC20.transferFrom, (from, address(this), amount))
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
