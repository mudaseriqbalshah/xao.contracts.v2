// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IGraphRegistry.sol";
import "../interfaces/IShowBundle.sol";
import "../interfaces/IDebtSettlement.sol";
import "../interfaces/IMiniOrg.sol";
import "../libraries/XaoRoles.sol";

interface ITourShellView {
    function owner() external view returns (address);
    function isOperator(address) external view returns (bool);
    function isTPA(address) external view returns (bool);
    function graphRegistry() external view returns (address);
    /// @dev 0 Booking, 1 Touring, 2 Settling, 3 Closed.
    function state() external view returns (uint8);
    function tourCoverage() external view returns (address);
}

interface ITourGuaranteeView {
    /// @notice The amount of a TPA's tour-wide guarantee once everyone has signed it, else 0.
    function signedGuaranteeAmount(address tpa) external view returns (uint256);
}

interface ITPAView {
    function partyA() external view returns (address);
    function partyB() external view returns (address);
    function tourShell() external view returns (address);
    function termsHash() external view returns (bytes32);
    function status() external view returns (uint8);        // 0 Draft, 1 Active, 2 Terminated, 3 Superseded
}

/// @dev The parts of a show's EventEscrow this module reads. The escrow keeps its own record of
///      everything it has paid each recipient, which is what makes the receipts here trustworthy.
interface IShowEscrowView {
    function show() external view returns (address);
    function status() external view returns (uint8);        // 2 = Completed
    function earnedBy(address recipient, uint8 stream) external view returns (uint256);
    function unclaimed(address recipient) external view returns (uint256);
    function claim() external;
    function debtApplied(address funder) external view returns (uint256);
    function discountLedger() external view returns (address);
}

/// @title TourSettlementEscrow — where a tour package's money is shared between the bands (Phase 2F)
/// @notice A show's escrow pays the tour package to this contract once the show is
///         completed and every refund and dispute is behind it. This contract works
///         out what each band is owed under its own signed terms, pays it, and passes
///         what is left to the tour side. The TourShell stays non-custodial: it only
///         points here.
///
///         Money in. Nothing is trusted from a caller. The contract reads what the
///         show's escrow says it has paid this contract (`earnedBy`) and credits only
///         that, and only as far as the tokens are really here. Crediting is by
///         difference, so it happens exactly once however often it is called, and it
///         is kept per show: the money of one show is never used for another.
///
///         Whole-tour pay (FixedTour). One amount for the whole tour, paid in installments on
///         a schedule (every so often, or every so many completed shows) or at the end. It
///         needs a signed tour-wide guarantee of the same amount in the coverage ledger. It is
///         paid from the tour contract's own money (the tour side's share of settled shows,
///         which the tour side cannot take while an installment is waiting) and, for what that
///         does not cover, from the tour obligor. Discounts the band funded come off it.
///
///         Terms. Each band has its own agreement (a TPA). Its pay terms are signed
///         here by both the band and the tour obligor, are bound to the TPA's signed
///         terms hash, and cannot change; an amendment is a new TPA. Supported pay:
///           FixedShow   a fixed amount for each show;
///           Percentage  a share of what the show paid the tour package;
///           MixedShow   the higher of that share and a per-show floor;
///           FixedTour   one amount for the whole tour (see below).
///
///         Per show. Once the show's escrow is completed, `settleShow` fixes what each
///         applied band earned (its gross entitlement), takes the discounts it funded
///         off that, and pays it from that show's money. Gross earnings are recorded
///         unchanged; only the cash paid out is smaller. What is left is the tour side's.
///
///         Minimums. A fixed per-show amount (FixedShow) and a per-show floor (MixedShow)
///         are promised by the band's counterparty (the tour obligor, e.g. the booking
///         agent). When a show's money does not reach it, less the band's own discounts,
///         the difference is that counterparty's to pay, for that show only: another
///         show's money never fills it. `collectShortfall` takes it from the obligor up
///         to what it has approved and holds; what is not taken stays owed (`inBreach` says
///         so). Nothing else happens automatically.
/// @dev Deployed as a minimal-proxy clone by TourSettlementEscrowFactory.
contract TourSettlementEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error AlreadyInitialized();
    error ZeroAddress();
    error NotTourSide();
    error NotAuthorized();
    error UnknownTPA();
    error AlreadyRegistered();
    error TPANotForThisTour();
    error TermsDoNotMatchTPA();
    error UnsupportedModel();
    error InvalidTerms();
    error TermsNotSigned();
    error TPANotActive();
    error UnknownShow();
    error NotAnOfficialShow();
    error ShowNotSigned();
    error ShowDoesNotPayThisContract();
    error TooMany();
    error WrongLink();
    error AlreadyApplied();
    error ShowAlreadySettled();
    error ShowNotCompleted();
    error ShowNotSettled();
    error NothingToPay();
    error TourWindingDown();
    error NoShortfall();
    error NoTourGuarantee();
    error TourAlreadyStarted();

    enum PayModel { FixedShow, FixedTour, Percentage, MixedShow, MixedTour }
    enum PayTiming { AfterShowSettlement, TourMilestone, EndOfTour }
    enum ScheduleKind { None, Period, Shows }

    struct ArtistTerms {
        address   artistMiniOrg;        // who is paid: the band's own org wallet
        address   tourObligor;          // who promises the pay: the tour owner
        PayModel  model;
        PayTiming timing;
        uint256   fixedAmount;          // FixedShow: paid for each show
        uint16    percentageBps;        // Percentage and MixedShow: share of the package the show paid
        uint256   guaranteedFloor;      // MixedShow: the least a show pays this band
        bytes32   revenueBaseHash;      // what the signed document means by the revenue base
        bytes32   cancellationTermsHash;
        bytes32   reserveRulesHash;
        bytes32   showEligibilityHash;
        uint64    coverageDeadline;
        bytes32   termsVersionHash;     // must equal the TPA's termsHash
        uint256   installmentAmount;    // FixedTour paid on a schedule: each payment
        ScheduleKind scheduleKind;
        uint64    scheduleValue;        // seconds between payments, or completed shows per payment
        uint64    scheduleStart;        // Period: when the first payment is due
    }

    uint256 public constant MAX_TPAS  = 32;
    uint256 public constant MAX_SHOWS = 64;
    uint256 private constant BPS = 10_000;

    // ─── STATE ────────────────────────────────────────────────────────────
    ITourShellView public tourShell;
    IERC20  public token;               // the one settlement token of this tour
    address public showFactory;         // only escrows this factory made can pay in
    address public remainderReceiver;   // the tour side: gets what the bands are not owed
    address public registry;
    bool public initialized;

    address[] internal _tpas;
    mapping(address => ArtistTerms) internal _terms;
    mapping(address => bool) public termsRegistered;
    mapping(address => bool) public signedByBand;
    mapping(address => bool) public signedByObligor;

    address[] internal _shows;
    mapping(address => bool) public isShow;
    mapping(address => address[]) internal _applied;                   // show => the TPAs that apply to it
    mapping(address => mapping(address => bool)) public isApplied;

    mapping(address => uint256) public received;                       // show => credited so far
    mapping(address => uint256) public cash;                           // show => credited and not yet paid out
    uint256 public liquid;                                             // all shows together
    mapping(address => bool) public settled;
    mapping(address => uint256) public nominal;                        // show => the package as if no discount had been given

    mapping(address => mapping(address => uint256)) public earnedGross;     // show => tpa => entitlement
    mapping(address => mapping(address => uint256)) public allocated;       // show => tpa => what the package could cover
    mapping(address => mapping(address => uint256)) public discountDebt;    // show => tpa => taken off for discounts
    mapping(address => mapping(address => uint256)) public payableNet;      // show => tpa => allocated less discounts
    mapping(address => mapping(address => uint256)) public paid;            // show => tpa => paid out
    mapping(address => uint256) public remainderOwed;                       // show => the tour side's share
    mapping(address => uint256) public remainderPaid;
    mapping(address => mapping(address => uint256)) public shortfallOwed;   // show => tpa => minimum not yet made up
    mapping(address => uint256) public shortfallOutstanding;                // tpa => over all shows
    uint256 public totalShortfall;
    address[] internal _tourWide;                                           // TPAs paid one amount for the whole tour
    mapping(address => address[]) internal _tourShows;                      // such a TPA => the shows applied to it
    mapping(address => uint256) public tourDebt;                            // discounts it funded, over settled shows
    mapping(address => uint256) public tourPaid;
    mapping(address => uint256) public tourMissed;                          // what the last release could not pay
    uint256 public remainderOutstanding;                                    // the tour side's share not yet taken, all shows

    // ─── EVENTS ───────────────────────────────────────────────────────────
    event ArtistTermsRegistered(address indexed tpa, address indexed artistMiniOrg, PayModel model, bytes32 commitment);
    event ArtistTermsSigned(address indexed tpa, address indexed by, bool band);
    event ShowRegistered(address indexed show, address indexed escrow);
    event ShowAppliedToTPA(address indexed show, address indexed tpa);
    event ShowSettlementReceived(address indexed show, uint256 amount);
    event BandGrossEarned(address indexed band, address indexed show, uint256 amount);
    event BandDiscountDebited(address indexed band, address indexed show, uint256 amount);
    event BandPaymentReleased(address indexed band, address indexed show, uint256 amount);
    event RemainderReleased(address indexed show, address indexed to, uint256 amount);
    event ShowShortfall(address indexed show, uint256 amount);
    event ShortfallRecorded(address indexed tpa, address indexed show, uint256 amount);
    event ShortfallPaid(address indexed tpa, address indexed show, uint256 amount);
    event PaymentMissed(address indexed tpa, address indexed show, uint256 stillOwed);   // show 0 = a tour-wide payment
    event TourPaymentReleased(address indexed tpa, address indexed band, uint256 fromContract, uint256 fromObligor);

    /// @dev Locks the implementation; only clones can be initialized.
    constructor() {
        initialized = true;
    }

    function initialize(address _tourShell, address _token, address _showFactory, address _remainderReceiver) external {
        if (initialized) revert AlreadyInitialized();
        if (_tourShell == address(0) || _token == address(0) || _showFactory == address(0) || _remainderReceiver == address(0)) revert ZeroAddress();
        initialized       = true;
        tourShell         = ITourShellView(_tourShell);
        token             = IERC20(_token);
        showFactory       = _showFactory;
        remainderReceiver = _remainderReceiver;
        registry          = tourShell.graphRegistry();
    }

    // ─── BAND TERMS ───────────────────────────────────────────────────────

    /// @notice Record a band's pay terms against its TPA. They only take effect once
    ///         the band and the tour obligor have both signed them here.
    function registerArtistTPA(address tpa, ArtistTerms calldata t) external {
        _requireTourSide();
        _requireNotWindingDown();
        if (!tourShell.isTPA(tpa)) revert UnknownTPA();
        if (termsRegistered[tpa]) revert AlreadyRegistered();
        if (_tpas.length >= MAX_TPAS) revert TooMany();

        ITPAView p = ITPAView(tpa);
        if (p.tourShell() != address(tourShell)) revert TPANotForThisTour();
        if (t.artistMiniOrg != p.partyB() || t.tourObligor != p.partyA() || t.termsVersionHash != p.termsHash()) revert TermsDoNotMatchTPA();
        if (t.model == PayModel.FixedTour) {
            _checkTourTerms(tpa, t);
        } else if (t.timing != PayTiming.AfterShowSettlement || t.installmentAmount != 0
            || t.scheduleKind != ScheduleKind.None || t.scheduleValue != 0 || t.scheduleStart != 0) {
            revert UnsupportedModel();
        }

        if (t.model == PayModel.FixedTour) {
            _tourWide.push(tpa);
        } else if (t.model == PayModel.FixedShow) {
            if (t.fixedAmount == 0) revert InvalidTerms();
        } else if (t.model == PayModel.Percentage) {
            if (t.percentageBps == 0 || t.percentageBps > BPS) revert InvalidTerms();
        } else if (t.model == PayModel.MixedShow) {
            if (t.percentageBps == 0 || t.percentageBps > BPS || t.guaranteedFloor == 0) revert InvalidTerms();
        } else {
            revert UnsupportedModel();                  // a pooled tour-wide floor (MixedTour) is not wanted
        }

        _terms[tpa] = t;
        termsRegistered[tpa] = true;
        _tpas.push(tpa);
        emit ArtistTermsRegistered(tpa, t.artistMiniOrg, t.model, keccak256(abi.encode(t)));
    }

    /// @notice The band, or the tour obligor, accepts the registered terms. Only the party
    ///         itself or an owner or admin of its org wallet can: an agent cannot bind either side.
    function signArtistTerms(address tpa) external {
        if (!termsRegistered[tpa]) revert UnknownTPA();
        ArtistTerms storage t = _terms[tpa];
        bool asBand    = _speaksFor(t.artistMiniOrg, msg.sender);
        bool asObligor = _speaksFor(t.tourObligor, msg.sender);
        if (!asBand && !asObligor) revert NotAuthorized();
        if (asBand) { signedByBand[tpa] = true; emit ArtistTermsSigned(tpa, msg.sender, true); }
        if (asObligor) { signedByObligor[tpa] = true; emit ArtistTermsSigned(tpa, msg.sender, false); }
    }

    // ─── SHOWS ────────────────────────────────────────────────────────────

    /// @notice Name a show whose package this contract receives. The show must have been made
    ///         by the show factory, be signed, and its escrow must pay this contract.
    function registerShow(address show) external {
        _requireTourSide();
        _requireNotWindingDown();
        if (isShow[show]) revert AlreadyRegistered();
        if (_shows.length >= MAX_SHOWS) revert TooMany();

        address esc = IShowInstanceLike(show).escrow();
        if (esc == address(0) || !IShowFactoryLike(showFactory).isEscrow(esc) || IShowEscrowView(esc).show() != show) revert NotAnOfficialShow();
        if (!IShowInstanceLike(show).isFinalized()) revert ShowNotSigned();
        (uint256 fixedAmount, bool hasSweepShare) = IDebtRoute(esc).debtRoute(address(this));
        if (fixedAmount == 0 && !hasSweepShare) revert ShowDoesNotPayThisContract();

        isShow[show] = true;
        _shows.push(show);
        emit ShowRegistered(show, esc);
    }

    /// @notice Say that a band's TPA applies to a show. The link between them has to be
    ///         active in the graph (both of the show's parties confirmed it) and the band's
    ///         terms signed by both sides. The graph alone never moves money.
    function applyShow(address tpa, address show, bytes32 linkEdgeId) external {
        _requireTourSide();
        _requireNotWindingDown();
        if (!isShow[show]) revert UnknownShow();
        if (settled[show]) revert ShowAlreadySettled();
        if (!termsRegistered[tpa]) revert UnknownTPA();
        if (!signedByBand[tpa] || !signedByObligor[tpa]) revert TermsNotSigned();
        if (ITPAView(tpa).status() != 1) revert TPANotActive();
        if (isApplied[show][tpa]) revert AlreadyApplied();

        IGraphRegistry reg = IGraphRegistry(registry);
        (address from, address to, IGraphRegistry.EdgeType edgeType, , , ) = reg.edges(linkEdgeId);
        if (from != tpa || to != show || edgeType != IGraphRegistry.EdgeType.PARENTS || !reg.isEdgeActive(linkEdgeId)) revert WrongLink();

        isApplied[show][tpa] = true;
        _applied[show].push(tpa);
        if (_terms[tpa].model == PayModel.FixedTour) _tourShows[tpa].push(show);
        emit ShowAppliedToTPA(show, tpa);
    }

    // ─── MONEY IN ─────────────────────────────────────────────────────────

    /// @notice Credit what the show's escrow has paid this contract and has not been credited
    ///         yet, as far as the tokens are really here. Anyone may call it; it is safe to call
    ///         again. Money that arrives after the show is settled goes to the tour side.
    function syncShow(address show) public nonReentrant returns (uint256 credited) {
        credited = _sync(show);
    }

    /// @notice Collect a payment the show's escrow could not deliver at the time, then credit it.
    function claimShow(address show) external nonReentrant {
        if (!isShow[show]) revert UnknownShow();
        address esc = IShowInstanceLike(show).escrow();
        if (IShowEscrowView(esc).unclaimed(address(this)) > 0) IShowEscrowView(esc).claim();
        _sync(show);
    }

    // ─── SETTLING A SHOW ──────────────────────────────────────────────────

    /// @notice Once the show's escrow is completed: fix what each applied band earned, take what
    ///         it owes for discounts it funded, and what is owed to the tour side. Done once.
    function settleShow(address show) external nonReentrant {
        if (!isShow[show]) revert UnknownShow();
        if (settled[show]) revert ShowAlreadySettled();
        address esc = IShowInstanceLike(show).escrow();
        if (IShowEscrowView(esc).status() != 2) revert ShowNotCompleted();
        _sync(show);

        // What the package would have been without discounts: what arrived, plus what the show's
        // escrow took from this contract for the discounts its bands funded.
        uint256 base = received[show] + IShowEscrowView(esc).debtApplied(address(this));
        nominal[show] = base;

        address ledger = IShowEscrowView(esc).discountLedger();
        uint256 left = base;
        uint256 owedToBands;
        address[] storage list = _applied[show];
        for (uint256 i = 0; i < list.length; i++) {
            address tpa = list[i];
            if (ITPAView(tpa).status() != 1) continue;                     // a terminated or replaced agreement earns nothing more
            ArtistTerms storage t = _terms[tpa];

            uint256 earned = _entitlement(t, base);
            uint256 cover = earned < left ? earned : left;
            left -= cover;

            uint256 debt = ledger == address(0) ? 0 : IDiscountLedger(ledger).funderDebit(t.artistMiniOrg);
            if (t.model == PayModel.FixedTour) tourDebt[tpa] += debt;      // comes off its tour-wide pay
            if (debt > cover) debt = cover;

            earnedGross[show][tpa]  = earned;
            allocated[show][tpa]    = cover;
            discountDebt[show][tpa] = debt;
            payableNet[show][tpa]   = cover - debt;
            owedToBands += cover - debt;
            emit BandGrossEarned(t.artistMiniOrg, show, earned);
            if (debt > 0) emit BandDiscountDebited(t.artistMiniOrg, show, debt);
        }

        // The show's escrow may have taken more from this contract for a band's discounts than the
        // band could repay out of what it earned. The package is then smaller than the bands are owed:
        // the shortfall is taken from the bands applied last, so that nobody is paid money that is
        // not there and the bands applied first are paid in full.
        uint256 have = cash[show];
        if (owedToBands > have) {
            uint256 excess = owedToBands - have;
            for (uint256 i = list.length; i > 0 && excess > 0; i--) {
                uint256 cut = payableNet[show][list[i - 1]];
                if (cut > excess) cut = excess;
                payableNet[show][list[i - 1]] -= cut;
                excess -= cut;
            }
            emit ShowShortfall(show, owedToBands - have);
            owedToBands = have;
        }
        remainderOwed[show] += have - owedToBands;
        remainderOutstanding += have - owedToBands;
        settled[show] = true;
        _recordShortfalls(show, ledger);
    }

    /// @notice Take what a show fell short of a band's minimum from the band's counterparty
    ///         (the tour obligor), up to what it has approved and holds, and credit it to that
    ///         band for that show. What cannot be taken stays owed. Anyone may ask: the money
    ///         only ever goes to the band it is owed to.
    function collectShortfall(address show, address tpa) external nonReentrant returns (uint256 pulled) {
        uint256 owed = shortfallOwed[show][tpa];
        if (owed == 0) revert NoShortfall();

        pulled = _tryPull(_terms[tpa].tourObligor, address(this), owed);
        if (pulled > 0) {
            liquid += pulled;
            cash[show] += pulled;
            _payShortfall(show, tpa, pulled);
        }
        if (shortfallOwed[show][tpa] > 0) emit PaymentMissed(tpa, show, shortfallOwed[show][tpa]);
    }

    /// @notice Pay a band what it is owed for a settled show, from that show's money. If the
    ///         money is short it is paid what there is and the rest stays owed.
    function releaseBandPayout(address show, address tpa) external nonReentrant returns (uint256 amount) {
        if (!settled[show]) revert ShowNotSettled();
        if (!isApplied[show][tpa]) revert UnknownTPA();

        uint256 owed = payableNet[show][tpa] - paid[show][tpa];
        amount = owed < cash[show] ? owed : cash[show];
        if (amount == 0) revert NothingToPay();

        paid[show][tpa] += amount;
        cash[show] -= amount;
        liquid -= amount;
        address band = _terms[tpa].artistMiniOrg;
        token.safeTransfer(band, amount);
        emit BandPaymentReleased(band, show, amount);
    }

    /// @notice Pay the tour side what is left of a settled show, once its bands are paid.
    function releaseRemainder(address show) external nonReentrant returns (uint256 amount) {
        if (!settled[show]) revert ShowNotSettled();

        amount = _freeRemainder(show);
        uint256 waiting;
        for (uint256 i = 0; i < _tourWide.length; i++) waiting += tourOwedNow(_tourWide[i]);
        uint256 spare = remainderOutstanding > waiting ? remainderOutstanding - waiting : 0;
        if (amount > spare) amount = spare;
        if (amount == 0) revert NothingToPay();

        remainderOutstanding -= amount;
        remainderPaid[show] += amount;
        cash[show] -= amount;
        liquid -= amount;
        token.safeTransfer(remainderReceiver, amount);
        emit RemainderReleased(show, remainderReceiver, amount);
    }

    // ─── WHOLE-TOUR PAY ───────────────────────────────────────────────────

    /// @notice Pay what a whole-tour agreement is owed now: first from the tour contract's own
    ///         money (the tour side's share of settled shows), then from the tour obligor, up to
    ///         what it has approved and holds. What neither covers stays owed. Anyone may ask:
    ///         the money only ever goes to the band.
    function releaseTourPay(address tpa) external nonReentrant returns (uint256 amount) {
        uint256 owed = tourOwedNow(tpa);
        if (owed == 0) revert NothingToPay();
        ArtistTerms storage t = _terms[tpa];
        address band = t.artistMiniOrg;

        uint256 left = owed;
        for (uint256 i = 0; i < _shows.length && left > 0; i++) {
            address s = _shows[i];
            if (!settled[s]) continue;
            uint256 take = _freeRemainder(s);
            if (take > left) take = left;
            if (take == 0) continue;
            remainderOwed[s] -= take;
            remainderOutstanding -= take;
            cash[s] -= take;
            liquid -= take;
            left -= take;
        }
        uint256 fromContract = owed - left;
        uint256 fromObligor = left == 0 ? 0 : _tryPull(t.tourObligor, band, left);
        left -= fromObligor;

        amount = fromContract + fromObligor;
        tourPaid[tpa] += amount;
        tourMissed[tpa] = left;
        if (fromContract > 0) token.safeTransfer(band, fromContract);
        emit TourPaymentReleased(tpa, band, fromContract, fromObligor);
        if (left > 0) emit PaymentMissed(tpa, address(0), left);
    }

    // ─── VIEWS ────────────────────────────────────────────────────────────

    /// @notice Whether the tour can be closed as far as this contract goes: every show is settled
    ///         and all the money it received has been paid out, or the show was cancelled or expired
    ///         and sent nothing. Read by the tour shell when it closes the tour.
    function canClose() external view returns (bool) {
        if (totalShortfall != 0 || !allShowsDone()) return false;   // a minimum still to make up, or a show still open
        for (uint256 i = 0; i < _tourWide.length; i++) {
            address t = _tourWide[i];
            if (!_live(t)) continue;
            if (tourShell.state() == 0 || tourOwedNow(t) != 0) return false;   // abandoning: end the agreement first
        }
        for (uint256 i = 0; i < _shows.length; i++) if (cash[_shows[i]] != 0) return false;
        return true;
    }

    /// @notice Whether every show is settled, or was cancelled or expired.
    function allShowsDone() public view returns (bool) {
        for (uint256 i = 0; i < _shows.length; i++) {
            if (settled[_shows[i]]) continue;
            uint8 st = IShowInstanceLike(_shows[i]).status();
            if (st != 5 && st != 6) return false;
        }
        return true;
    }

    /// @notice Whether a band's counterparty still owes it part of a per-show minimum.
    function inBreach(address tpa) external view returns (bool) {
        return shortfallOutstanding[tpa] != 0 || tourMissed[tpa] != 0;
    }

    /// @notice How many of the shows applied to a whole-tour agreement have completed.
    function completedShows(address tpa) public view returns (uint256 n) {
        address[] storage list = _tourShows[tpa];
        for (uint256 i = 0; i < list.length; i++) {
            if (IShowEscrowView(IShowInstanceLike(list[i]).escrow()).status() == 2) n++;
        }
    }

    /// @notice What has fallen due so far under a whole-tour agreement, before the discounts the
    ///         band funded and what it has been paid. All of it once the tour is settling.
    function tourDue(address tpa) public view returns (uint256 due) {
        ArtistTerms storage t = _terms[tpa];
        if (t.model != PayModel.FixedTour || !_live(tpa)) return 0;
        if (tourShell.state() >= 2) return t.fixedAmount;
        if (t.timing == PayTiming.EndOfTour) return 0;
        uint256 n;
        if (t.scheduleKind == ScheduleKind.Shows) n = completedShows(tpa) / t.scheduleValue;
        else if (block.timestamp >= t.scheduleStart) n = (block.timestamp - t.scheduleStart) / t.scheduleValue + 1;
        due = n * t.installmentAmount;
        if (due > t.fixedAmount) due = t.fixedAmount;
    }

    /// @notice What a whole-tour agreement is owed right now.
    function tourOwedNow(address tpa) public view returns (uint256) {
        uint256 due = tourDue(tpa);
        uint256 gone = tourDebt[tpa] + tourPaid[tpa];
        return due > gone ? due - gone : 0;
    }

    function getArtistTerms(address tpa) external view returns (ArtistTerms memory) {
        if (!termsRegistered[tpa]) revert UnknownTPA();
        return _terms[tpa];
    }

    function getTPAs() external view returns (address[] memory) { return _tpas; }
    function getShows() external view returns (address[] memory) { return _shows; }
    function getAppliedTPAs(address show) external view returns (address[] memory) { return _applied[show]; }

    /// @notice Tokens held that no show's receipts explain. Never assigned to a band.
    function unassigned() external view returns (uint256) {
        uint256 bal = token.balanceOf(address(this));
        return bal > liquid ? bal - liquid : 0;
    }

    /// @notice What a band is sure to be paid from a show (a fixed amount), and whether it gets a
    ///         share of the package instead. Read by the discount coordinator to see whether this
    ///         contract can collect what a band owes for discounts it funds.
    function debtRoute(address band) external view returns (uint256 fixedAmount, bool hasSweepShare) {
        for (uint256 i = 0; i < _tpas.length; i++) {
            ArtistTerms storage t = _terms[_tpas[i]];
            if (t.artistMiniOrg != band || !signedByBand[_tpas[i]] || !signedByObligor[_tpas[i]]) continue;
            if (t.model == PayModel.FixedShow || t.model == PayModel.FixedTour) fixedAmount += t.fixedAmount;
            else hasSweepShare = true;
        }
    }

    // ─── INTERNAL ─────────────────────────────────────────────────────────

    function _sync(address show) internal returns (uint256 credited) {
        if (!isShow[show]) revert UnknownShow();
        address esc = IShowInstanceLike(show).escrow();

        uint256 total;
        for (uint8 s = 0; s <= 5; s++) total += IShowEscrowView(esc).earnedBy(address(this), s);
        uint256 fresh = total > received[show] ? total - received[show] : 0;
        if (fresh == 0) return 0;

        uint256 bal = token.balanceOf(address(this));
        uint256 headroom = bal > liquid ? bal - liquid : 0;
        credited = fresh < headroom ? fresh : headroom;
        if (credited == 0) return 0;

        received[show] += credited;
        cash[show]     += credited;
        liquid         += credited;
        if (settled[show]) {                                       // this show's minimums first, then the tour side
            uint256 extra = _fillShortfalls(show, credited);
            remainderOwed[show] += extra;
            remainderOutstanding += extra;
        }
        emit ShowSettlementReceived(show, credited);
    }

    /// @dev What a band was promised for this show at least, less the discounts it funded, and
    ///      did not get from it.
    function _recordShortfalls(address show, address ledger) internal {
        address[] storage list = _applied[show];
        for (uint256 i = 0; i < list.length; i++) {
            address tpa = list[i];
            if (ITPAView(tpa).status() != 1) continue;
            ArtistTerms storage t = _terms[tpa];
            uint256 minimum = t.model == PayModel.FixedShow ? t.fixedAmount
                            : t.model == PayModel.MixedShow ? t.guaranteedFloor : 0;
            uint256 debt = ledger == address(0) ? 0 : IDiscountLedger(ledger).funderDebit(t.artistMiniOrg);
            uint256 due = minimum > debt ? minimum - debt : 0;
            uint256 got = payableNet[show][tpa];
            if (due <= got) continue;
            shortfallOwed[show][tpa] = due - got;
            shortfallOutstanding[tpa] += due - got;
            totalShortfall += due - got;
            emit ShortfallRecorded(tpa, show, due - got);
        }
    }

    /// @dev Money (already counted in `cash`) goes to a band's shortfall for this show.
    function _payShortfall(address show, address tpa, uint256 amount) internal {
        shortfallOwed[show][tpa] -= amount;
        shortfallOutstanding[tpa] -= amount;
        totalShortfall -= amount;
        payableNet[show][tpa] += amount;
        emit ShortfallPaid(tpa, show, amount);
    }

    /// @dev Late money of a settled show makes up its bands' shortfalls, in the order they apply;
    ///      returns what is left over.
    function _fillShortfalls(address show, uint256 amount) internal returns (uint256 left) {
        left = amount;
        address[] storage list = _applied[show];
        for (uint256 i = 0; i < list.length && left > 0; i++) {
            uint256 owed = shortfallOwed[show][list[i]];
            uint256 part = owed < left ? owed : left;
            if (part == 0) continue;
            _payShortfall(show, list[i], part);
            left -= part;
        }
    }

    function _entitlement(ArtistTerms storage t, uint256 base) internal view returns (uint256) {
        if (t.model == PayModel.FixedShow) return t.fixedAmount;
        if (t.model == PayModel.FixedTour) return 0;                       // paid for the tour, not for a show
        uint256 share = base * t.percentageBps / BPS;
        if (t.model == PayModel.Percentage) return share;
        return share > t.guaranteedFloor ? share : t.guaranteedFloor;      // MixedShow: the higher of the two
    }

    /// @dev The tour side's share of a settled show that is not set aside for its bands.
    function _freeRemainder(address show) internal view returns (uint256) {
        uint256 reserved;
        address[] storage list = _applied[show];
        for (uint256 i = 0; i < list.length; i++) reserved += payableNet[show][list[i]] - paid[show][list[i]];
        uint256 free = cash[show] > reserved ? cash[show] - reserved : 0;
        uint256 owed = remainderOwed[show] - remainderPaid[show];
        return owed < free ? owed : free;
    }

    /// @dev Takes up to `amount` from `payer` to `to`, as far as it has approved and holds it.
    ///      A transfer the token refuses takes nothing.
    function _tryPull(address payer, address to, uint256 amount) internal returns (uint256 pulled) {
        if (tourShell.state() == 3) return 0;          // a closed tour takes nothing more: the parties settle outside
        uint256 allowance = token.allowance(payer, address(this));
        uint256 balance = token.balanceOf(payer);
        uint256 avail = allowance < balance ? allowance : balance;
        pulled = amount < avail ? amount : avail;
        if (pulled > 0) {
            try token.transferFrom(payer, to, pulled) returns (bool ok) {
                if (!ok) pulled = 0;
            } catch {
                pulled = 0;
            }
        }
    }

    /// @dev Signed by both sides, and the agreement still in force.
    function _live(address tpa) internal view returns (bool) {
        return signedByBand[tpa] && signedByObligor[tpa] && ITPAView(tpa).status() == 1;
    }

    /// @dev A tour-wide amount is agreed before the tour starts, and its schedule has to make sense.
    function _checkTourTerms(address tpa, ArtistTerms calldata t) internal view {
        if (tourShell.state() != 0) revert TourAlreadyStarted();
        if (t.fixedAmount == 0) revert InvalidTerms();
        if (t.timing == PayTiming.EndOfTour) {
            if (t.installmentAmount != 0 || t.scheduleKind != ScheduleKind.None || t.scheduleValue != 0 || t.scheduleStart != 0) revert InvalidTerms();
        } else if (t.timing == PayTiming.TourMilestone) {
            if (t.installmentAmount == 0 || t.installmentAmount > t.fixedAmount || t.scheduleValue == 0) revert InvalidTerms();
            if (t.scheduleKind == ScheduleKind.Period) { if (t.scheduleStart == 0) revert InvalidTerms(); }
            else if (t.scheduleKind != ScheduleKind.Shows || t.scheduleStart != 0) revert InvalidTerms();
        } else {
            revert UnsupportedModel();
        }
        _checkTourGuarantee(tpa, t.fixedAmount);
    }

    /// @dev The coverage ledger has to hold a signed guarantee of the same amount.
    function _checkTourGuarantee(address tpa, uint256 amount) internal view {
        address c = tourShell.tourCoverage();
        if (c == address(0) || ITourGuaranteeView(c).signedGuaranteeAmount(tpa) != amount) revert NoTourGuarantee();
    }

    function _requireNotWindingDown() internal view {
        if (tourShell.state() >= 2) revert TourWindingDown();
    }

    function _requireTourSide() internal view {
        address owner_ = tourShell.owner();
        if (msg.sender == owner_ || tourShell.isOperator(msg.sender) || _isGraphOperator(owner_, msg.sender)) return;
        revert NotTourSide();
    }

    /// @dev The party itself, or an owner or admin of it when it is an org wallet.
    function _speaksFor(address party, address who) internal view returns (bool) {
        if (who == party) return true;
        if (party.code.length == 0) return false;
        return _hasRole(party, who, XaoRoles.ROLE_OWNER) || _hasRole(party, who, XaoRoles.ROLE_ADMIN);
    }

    function _isGraphOperator(address org, address who) internal view returns (bool) {
        if (org.code.length == 0) return false;
        (bool ok, bytes memory data) = org.staticcall(abi.encodeCall(IMiniOrgWallet.isGraphOperator, (who)));
        return ok && data.length >= 32 && uint256(bytes32(data)) != 0;
    }

    function _hasRole(address org, address who, bytes32 role) internal view returns (bool) {
        (bool ok, bytes memory data) = org.staticcall(abi.encodeCall(IMiniOrgWallet.hasRole, (who, role)));
        return ok && data.length >= 32 && uint256(bytes32(data)) != 0;
    }
}
