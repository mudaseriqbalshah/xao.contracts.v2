// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IGraphParties.sol";
import "../interfaces/IShowBundle.sol";

/// @title SupportSlotAgreement — a guaranteed opener slot under a show (Phase 2A)
/// @notice A subordinate contract between a show organizer (venue, promoter or
///         tour manager) and a supporting artist, for a flat guarantee. It does
///         not receive ticket revenue. Its guarantee is funded from the parent
///         show's escrow (money earmarked there, not moved) and/or directly by
///         the organizer, and is paid to the band when the show completes or a
///         ruling says it is owed. Its disputes are separate from the parent
///         show's, and the ruling is binary: breach or no breach.
/// @dev Deployed as a minimal-proxy clone by SupportSlotFactory and set up via
///      initialize(). Until the ArbitrationAgent exists, a dispute is settled
///      when both parties vote for the same ruling.
contract SupportSlotAgreement is IGraphParties, ISubordinateLike, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error AlreadyInitialized();
    error ZeroAddress();
    error SamePartyOnBothSides();
    error ZeroGuarantee();
    error ZeroTermsHash();
    error TokenMismatch();
    error EscrowNotOfShow();
    error NotAParty();
    error NotOrganizer();
    error NotParentEscrow();
    error NotDraft();
    error NotSignedOrActive();
    error NotActive();
    error NotInDispute();
    error AlreadySigned();
    error ParentShowEnded();
    error ParentShowNotEnded();
    error ParentShowCancelled();
    error OverFunded();
    error ZeroAmount();
    error InvalidRuling();
    error NotYetPayable();
    error NothingToClaim();
    error TransferFailed();
    error AlreadyAgreedToCancel();

    enum Status { Draft, Signed, Active, InDispute, Completed, Cancelled }

    /// @dev Binary outcome. Breach by the organizer still pays the band.
    enum Ruling { None, NoBreach, BreachBySupport, BreachByOrganizer }

    struct SlotInit {
        address partyA;          // organizer
        address partyB;          // support band
        address parentShow;
        address parentEscrow;
        uint256 guaranteeAmount;
        address payoutToken;     // must be the parent escrow's token
        bytes32 termsHash;
        string  termsCID;
    }

    // ShowInstance.ShowStatus values this contract reacts to.
    uint8 private constant SHOW_COMPLETED = 4;
    uint8 private constant SHOW_CANCELLED = 5;
    uint8 private constant SHOW_EXPIRED   = 6;

    // ─── STATE ────────────────────────────────────────────────────────────
    address public override partyA;
    address public override partyB;
    address public override parentShow;
    address public override parentEscrow;

    uint256 public guaranteeAmount;
    IERC20  public payoutToken;

    bytes32 public termsHash;
    string  public termsCID;

    uint256 public fundedFromParent;
    uint256 public fundedDirect;

    Status public status;
    Status internal _statusBeforeDispute;
    mapping(address => bool) public hasSigned;
    mapping(address => bool) public agreedToCancel;

    bytes32 public activeCaseId;
    uint256 public disputeNonce;
    mapping(bytes32 => mapping(address => Ruling)) public rulingVote;
    Ruling public ruling;

    /// @notice Payments the token refused, waiting for their recipient to claim.
    mapping(address => uint256) public unclaimed;

    bool public initialized;

    // ─── EVENTS ───────────────────────────────────────────────────────────
    event SupportSlotInitialized(address indexed parentShow, address indexed band, uint256 guarantee);
    event Signed(address indexed by);
    event Activated();
    event FundedFromParent(uint256 amount);
    event FundedDirect(uint256 amount);
    event DisputeOpened(bytes32 caseId);
    event DisputeVoted(bytes32 indexed caseId, address indexed by, Ruling ruling);
    event DisputeResolved(bytes32 caseId, bool breach, address breachingParty);
    event PayoutExecuted(uint256 amount);
    event CancelAgreed(address indexed by);
    event Cancelled();
    event PaymentHeld(address indexed recipient, uint256 amount);
    event Claimed(address indexed recipient, uint256 amount);

    modifier onlyParty() {
        if (msg.sender != partyA && msg.sender != partyB) revert NotAParty();
        _;
    }

    /// @dev Locks the implementation; only clones can be initialized.
    constructor() {
        initialized = true;
    }

    function initialize(SlotInit calldata init) external {
        if (initialized) revert AlreadyInitialized();
        if (
            init.partyA == address(0) || init.partyB == address(0) ||
            init.parentShow == address(0) || init.parentEscrow == address(0) ||
            init.payoutToken == address(0)
        ) revert ZeroAddress();
        if (init.partyA == init.partyB) revert SamePartyOnBothSides();
        if (init.guaranteeAmount == 0) revert ZeroGuarantee();
        if (init.termsHash == bytes32(0)) revert ZeroTermsHash();
        if (IEventEscrowLike(init.parentEscrow).payoutToken() != init.payoutToken) revert TokenMismatch();
        if (IShowInstanceLike(init.parentShow).escrow() != init.parentEscrow) revert EscrowNotOfShow();

        initialized     = true;
        partyA          = init.partyA;
        partyB          = init.partyB;
        parentShow      = init.parentShow;
        parentEscrow    = init.parentEscrow;
        guaranteeAmount = init.guaranteeAmount;
        payoutToken     = IERC20(init.payoutToken);
        termsHash       = init.termsHash;
        termsCID        = init.termsCID;
        // status defaults to Draft

        emit SupportSlotInitialized(init.parentShow, init.partyB, init.guaranteeAmount);
    }

    // ─── SIGNING ──────────────────────────────────────────────────────────

    /// @notice Both parties sign while the parent show is still on.
    function sign() external onlyParty {
        if (status != Status.Draft) revert NotDraft();
        if (hasSigned[msg.sender]) revert AlreadySigned();
        _requireParentOpen();

        hasSigned[msg.sender] = true;
        emit Signed(msg.sender);

        if (hasSigned[partyA] && hasSigned[partyB]) {
            status = Status.Signed;
        }
    }

    // ─── FUNDING ──────────────────────────────────────────────────────────

    /// @notice The parent escrow earmarked `amount` for this slot. Only the
    ///         escrow can call this, and only after every party of the show
    ///         has approved it there.
    function onReserved(uint256 amount) external override {
        if (msg.sender != parentEscrow) revert NotParentEscrow();
        _requireFundable(amount);

        fundedFromParent += amount;
        emit FundedFromParent(amount);
        _activateIfFunded();
    }

    /// @notice The organizer pays toward the guarantee directly, for example
    ///         when the parent escrow cannot cover it or the slot was added late.
    function fundDirect(uint256 amount) external nonReentrant {
        if (msg.sender != partyA) revert NotOrganizer();
        _requireFundable(amount);

        fundedDirect += amount;
        payoutToken.safeTransferFrom(msg.sender, address(this), amount);
        emit FundedDirect(amount);
        _activateIfFunded();
    }

    // ─── DISPUTE (interim: settled by the parties) ────────────────────────

    /// @notice Freeze payout of this slot. The parent show carries on.
    function raiseDispute() external onlyParty {
        if (status != Status.Signed && status != Status.Active) revert NotSignedOrActive();

        _statusBeforeDispute = status;
        status = Status.InDispute;
        bytes32 caseId = keccak256(abi.encodePacked(address(this), ++disputeNonce));
        activeCaseId = caseId;
        emit DisputeOpened(caseId);
    }

    /// @notice Each party votes for a ruling; it is final when both vote alike.
    ///         NoBreach and BreachByOrganizer both mean the guarantee is paid.
    ///         BreachBySupport means it is not, and the money goes back.
    function resolveDispute(Ruling vote) external onlyParty nonReentrant {
        bytes32 caseId = activeCaseId;
        if (status != Status.InDispute) revert NotInDispute();
        if (vote == Ruling.None) revert InvalidRuling();

        rulingVote[caseId][msg.sender] = vote;
        emit DisputeVoted(caseId, msg.sender, vote);

        if (rulingVote[caseId][partyA] != rulingVote[caseId][partyB]) return;

        activeCaseId = bytes32(0);
        status = _statusBeforeDispute;
        ruling = vote;

        address breaching = vote == Ruling.BreachBySupport
            ? partyB
            : (vote == Ruling.BreachByOrganizer ? partyA : address(0));
        emit DisputeResolved(caseId, vote != Ruling.NoBreach, breaching);

        if (vote == Ruling.BreachBySupport) _cancelAndRelease();
    }

    // ─── PAYOUT ───────────────────────────────────────────────────────────

    /// @notice Pay the guarantee to the band. Anyone may call once the slot is
    ///         fully funded and either the parent show has completed or a
    ///         ruling says it is owed. The parent escrow's earmarked money is
    ///         used first, the organizer's direct money for the rest.
    function executePayout() external nonReentrant {
        if (status != Status.Active) revert NotActive();

        uint8 showStatus = IShowInstanceLike(parentShow).status();
        if (showStatus == SHOW_CANCELLED || showStatus == SHOW_EXPIRED) revert ParentShowCancelled();
        bool owed = ruling == Ruling.NoBreach || ruling == Ruling.BreachByOrganizer;
        if (showStatus != SHOW_COMPLETED && !owed) revert NotYetPayable();

        status = Status.Completed;
        uint256 fromParent = fundedFromParent;
        uint256 direct     = fundedDirect;
        fundedFromParent = 0;
        fundedDirect     = 0;

        if (fromParent > 0) IEventEscrowLike(parentEscrow).settleSubordinate(partyB, fromParent);
        _pay(partyB, direct);
        emit PayoutExecuted(fromParent + direct);
    }

    // ─── CANCELLATION ─────────────────────────────────────────────────────

    /// @notice Either party can walk away before the slot is signed.
    function cancel() external onlyParty {
        if (status != Status.Draft) revert NotDraft();
        status = Status.Cancelled;
        emit Cancelled();
    }

    /// @notice After signing, the slot is cancelled when both parties agree.
    ///         Anything funded goes back to where it came from.
    function agreeToCancel() external onlyParty nonReentrant {
        if (status != Status.Signed && status != Status.Active) revert NotSignedOrActive();
        if (agreedToCancel[msg.sender]) revert AlreadyAgreedToCancel();

        agreedToCancel[msg.sender] = true;
        emit CancelAgreed(msg.sender);

        if (agreedToCancel[partyA] && agreedToCancel[partyB]) _cancelAndRelease();
    }

    /// @notice Anyone can cancel a slot whose parent show was cancelled or
    ///         expired, and send the funding back.
    function cancelIfParentEnded() external nonReentrant {
        if (status == Status.Completed || status == Status.Cancelled) revert NotSignedOrActive();
        uint8 showStatus = IShowInstanceLike(parentShow).status();
        if (showStatus != SHOW_CANCELLED && showStatus != SHOW_EXPIRED) revert ParentShowNotEnded();

        activeCaseId = bytes32(0);
        _cancelAndRelease();
    }

    // ─── CLAIM ────────────────────────────────────────────────────────────

    /// @notice Collect a payment the token refused when it was first sent.
    function claim() external nonReentrant {
        uint256 amount = unclaimed[msg.sender];
        if (amount == 0) revert NothingToClaim();

        unclaimed[msg.sender] = 0;
        if (!_tryTransfer(msg.sender, amount)) revert TransferFailed();
        emit Claimed(msg.sender, amount);
    }

    // ─── VIEWS ────────────────────────────────────────────────────────────

    function totalFunded() public view returns (uint256) {
        return fundedFromParent + fundedDirect;
    }

    function isFunded() public view returns (bool) {
        return totalFunded() >= guaranteeAmount;
    }

    // ─── INTERNAL ─────────────────────────────────────────────────────────

    function _requireParentOpen() internal view {
        if (IShowInstanceLike(parentShow).status() >= SHOW_COMPLETED) revert ParentShowEnded();
    }

    function _requireFundable(uint256 amount) internal view {
        if (status != Status.Signed && status != Status.Active) revert NotSignedOrActive();
        if (amount == 0) revert ZeroAmount();
        if (totalFunded() + amount > guaranteeAmount) revert OverFunded();
        _requireParentOpen();
    }

    function _activateIfFunded() internal {
        if (status == Status.Signed && isFunded()) {
            status = Status.Active;
            emit Activated();
        }
    }

    /// @dev Ends the slot and sends funding back: the earmark to the parent
    ///      escrow (which uses it again), direct money to the organizer.
    function _cancelAndRelease() internal {
        status = Status.Cancelled;
        uint256 fromParent = fundedFromParent;
        uint256 direct     = fundedDirect;
        fundedFromParent = 0;
        fundedDirect     = 0;

        if (fromParent > 0) IEventEscrowLike(parentEscrow).releaseReservation(fromParent);
        _pay(partyA, direct);
        emit Cancelled();
    }

    /// @dev Sends `amount`, or holds it for the recipient if the token refuses.
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (!_tryTransfer(to, amount)) {
            unclaimed[to] += amount;
            emit PaymentHeld(to, amount);
        }
    }

    function _tryTransfer(address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory data) = address(payoutToken).call(
            abi.encodeCall(IERC20.transfer, (to, amount))
        );
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }
}
