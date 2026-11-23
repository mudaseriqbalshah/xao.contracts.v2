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
///         Terms. Each band has its own agreement (a TPA). Its pay terms are signed
///         here by both the band and the tour obligor, are bound to the TPA's signed
///         terms hash, and cannot change; an amendment is a new TPA. Supported pay:
///           FixedShow   a fixed amount for each show;
///           Percentage  a share of what the show paid the tour package;
///           MixedShow   the higher of that share and a per-show floor.
///         Tour-wide pay and launch coverage are not here yet.
///
///         Per show. Once the show's escrow is completed, `settleShow` fixes what each
///         applied band earned (its gross entitlement), takes the discounts it funded
///         off that, and pays it from that show's money. Gross earnings are recorded
///         unchanged; only the cash paid out is smaller. What is left is the tour side's.
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

    enum PayModel { FixedShow, FixedTour, Percentage, MixedShow, MixedTour }
    enum PayTiming { AfterShowSettlement, TourMilestone, EndOfTour }

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
        if (t.timing != PayTiming.AfterShowSettlement) revert UnsupportedModel();

        if (t.model == PayModel.FixedShow) {
            if (t.fixedAmount == 0) revert InvalidTerms();
        } else if (t.model == PayModel.Percentage) {
            if (t.percentageBps == 0 || t.percentageBps > BPS) revert InvalidTerms();
        } else if (t.model == PayModel.MixedShow) {
            if (t.percentageBps == 0 || t.percentageBps > BPS || t.guaranteedFloor == 0) revert InvalidTerms();
        } else {
            revert UnsupportedModel();                  // tour-wide pay needs the coverage engine
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
        settled[show] = true;
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

        uint256 reserved;
        address[] storage list = _applied[show];
        for (uint256 i = 0; i < list.length; i++) reserved += payableNet[show][list[i]] - paid[show][list[i]];

        uint256 free = cash[show] > reserved ? cash[show] - reserved : 0;
        uint256 owed = remainderOwed[show] - remainderPaid[show];
        amount = owed < free ? owed : free;
        if (amount == 0) revert NothingToPay();

        remainderPaid[show] += amount;
        cash[show] -= amount;
        liquid -= amount;
        token.safeTransfer(remainderReceiver, amount);
        emit RemainderReleased(show, remainderReceiver, amount);
    }

    // ─── VIEWS ────────────────────────────────────────────────────────────

    /// @notice Whether the tour can be closed as far as this contract goes: every show is settled
    ///         and all the money it received has been paid out, or the show was cancelled or expired
    ///         and sent nothing. Read by the tour shell when it closes the tour.
    function canClose() external view returns (bool) {
        for (uint256 i = 0; i < _shows.length; i++) {
            address s = _shows[i];
            if (cash[s] != 0) return false;
            if (!settled[s]) {                                  // not settled: only a cancelled or expired show is done
                uint8 st = IShowInstanceLike(s).status();
                if (st != 5 && st != 6) return false;
            }
        }
        return true;
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
            if (t.model == PayModel.FixedShow) fixedAmount += t.fixedAmount;
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
        if (settled[show]) remainderOwed[show] += credited;       // after settlement, new money is the tour side's
        emit ShowSettlementReceived(show, credited);
    }

    function _entitlement(ArtistTerms storage t, uint256 base) internal view returns (uint256) {
        if (t.model == PayModel.FixedShow) return t.fixedAmount;
        uint256 share = base * t.percentageBps / BPS;
        if (t.model == PayModel.Percentage) return share;
        return share > t.guaranteedFloor ? share : t.guaranteedFloor;      // MixedShow: the higher of the two
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
