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
import "./TourSettlementEscrow.sol";

interface ICoverageShell {
    function tourSettlementEscrow() external view returns (address);
}

interface ICoverageEscrow {
    function partyDeposited() external view returns (uint256);
    function requiredFunding() external view returns (uint256);
}

interface ISettlementRoutes {
    function isShow(address show) external view returns (bool);
}

/// @title TourCoverage — is a tour-wide guarantee really covered before the tour begins? (Phase 2F)
/// @notice A tour-wide guarantee is a promise to a band that does not depend on one show. Before
///         the tour starts it has to be covered by money that is really there, and every dollar
///         of cover may be counted for one guarantee only. This contract keeps that ledger.
///         It does not pay the band: paying tour-wide guarantees comes with the tour-wide pay
///         terms. It only answers one question: is each guarantee covered, and by how much?
///
///         What counts as cover, tracked in three separate tiers:
///           - cash: money deposited here for that guarantee, really held by this contract;
///           - secured: a show's guaranteed payment to this tour's settlement escrow when the
///             parties' own deposits in that show's escrow cover everything the show has promised
///             to pay out;
///           - contracted: the same kind of payment from a signed, confirmed show whose parties
///             have not funded it yet. The funding deadline of a show has no power to cancel
///             anything, so it is not looked at: a signed show counts.
///           In every case the show has to be signed, not cancelled, expired, frozen or in
///           dispute, its escrow active, and the payment not already released. Ticket sales and
///           backend count as nothing, because a cancelled show refunds its buyers.
///         What does not count: a show that is not signed, projected sales, and a dollar that is
///         already cover for another guarantee. When a guarantee has more cover than it needs,
///         the surplus is taken from the least real tier first (contracted, then secured).
///
///         A guarantee can name a guarantor, typically the booking agent who promises the band's
///         payment. The guarantor signs it too. If it falls short, the contract tries to take
///         the shortfall from the guarantor (up to what the guarantor has approved and holds);
///         whatever it cannot take is only recorded as owed.
///
///         A show can lose its cover (it is cancelled, or its deposits are refunded). Then
///         `reconcileCoverage` takes that cover away from the guarantees that reserved it,
///         later reservations first, and the gap shows in `coverageGap`. The guarantee itself is
///         not reduced: it stays what was signed. Nothing is invented to fill the gap.
///
///         The launch is cleared once, while every guarantee's coverage deadline is still ahead:
///         when every signed guarantee is fully covered.
/// @dev Deployed as a minimal-proxy clone by TourCoverageFactory.
contract TourCoverage is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error AlreadyInitialized();
    error ZeroAddress();
    error NotTourSide();
    error NotAuthorized();
    error UnknownTPA();
    error TPANotActive();
    error InvalidGuarantee();
    error UnknownGuarantee();
    error GuaranteeExists();
    error NotSigned();
    error AlreadyCleared();
    error NoSettlementModule();
    error ShowNotEligible();
    error WrongLink();
    error ShowNotRegistered();
    error AlreadyReserved();
    error NothingReserved();
    error ExceedsShowCover();
    error ExceedsGuarantee();
    error TooMany();
    error ZeroAmount();
    error CoverageLocked();
    error ExceedsDeposit();
    error NotShell();
    error Sealed();
    error NoGuarantor();
    error NoShortfall();

    struct Guarantee {
        address tpa;
        address beneficiary;            // the band's org wallet (the TPA's party B)
        address obligor;                // who promises it (the TPA's party A)
        uint256 amount;
        uint64  coverageDeadline;       // the launch has to be cleared by then
        bool    signedByBeneficiary;
        bool    signedByObligor;
        uint256 deposited;
        uint256 reserved;
        uint256 covered;                // as of the last reconcile: cash + secured + contracted
        address guarantor;              // who stands behind the payment, e.g. the booking agent (0 = nobody)
        bool    signedByGuarantor;
        uint256 coveredCash;
        uint256 coveredSecured;
        uint256 coveredContracted;
        uint256 guarantorOwed;          // a shortfall the guarantor was asked to cover and has not
    }

    struct Reservation {
        address show;
        uint256 amount;
    }

    uint256 public constant MAX_GUARANTEES = 16;

    // ─── STATE ────────────────────────────────────────────────────────────
    ITourShellView public tourShell;
    IERC20  public token;
    address public showFactory;
    address public registry;
    bool public initialized;

    uint256 public guaranteeCount;
    mapping(uint256 => Guarantee) internal _g;
    mapping(address => uint256) public guaranteeOf;                         // tpa => id
    mapping(uint256 => Reservation[]) internal _res;
    mapping(uint256 => mapping(address => uint256)) public depositedBy;     // id => depositor => amount

    address[] internal _shows;
    mapping(address => bool) internal _inList;
    mapping(address => uint256) public reservedByShow;                      // show => reserved over all guarantees
    mapping(uint256 => mapping(address => uint256)) public invalidated;     // id => show => cover last found missing

    bool public launchCleared;
    bool public isSealed;                 // the tour has started: no new guarantee, signature or reservation
    uint256 public requiredCoverage;
    uint256 public eligibleCoverage;
    uint256 public cashCoverage;                        // of the eligible: money held here
    uint256 public securedCoverage;                     // of the eligible: shows funded by their parties
    uint256 public contractedCoverage;                  // of the eligible: signed shows not funded yet

    // ─── EVENTS ───────────────────────────────────────────────────────────
    event GuaranteeRegistered(uint256 indexed id, address indexed tpa, address indexed beneficiary, uint256 amount, uint64 coverageDeadline);
    event GuaranteeSigned(uint256 indexed id, address indexed by, bool beneficiary);
    event CoverageDeposited(uint256 indexed id, address indexed from, uint256 amount);
    event CoverageWithdrawn(uint256 indexed id, address indexed to, uint256 amount);
    event ShowReserved(uint256 indexed id, address indexed show, uint256 amount);
    event ShowReleased(uint256 indexed id, address indexed show, uint256 amount);
    event TourCoverageUpdated(uint256 required, uint256 eligible);
    event ShowCoverageInvalidated(uint256 indexed id, address indexed show, uint256 removed);
    event LaunchCleared(uint256 required);
    event CoverageSealed();
    event GuarantorNamed(uint256 indexed id, address indexed guarantor);
    event GuarantorSigned(uint256 indexed id, address indexed by);
    event GuarantorShortfall(uint256 indexed id, uint256 pulled, uint256 stillOwed);

    /// @dev Locks the implementation; only clones can be initialized.
    constructor() {
        initialized = true;
    }

    function initialize(address _tourShell, address _token, address _showFactory) external {
        if (initialized) revert AlreadyInitialized();
        if (_tourShell == address(0) || _token == address(0) || _showFactory == address(0)) revert ZeroAddress();
        initialized = true;
        tourShell   = ITourShellView(_tourShell);
        token       = IERC20(_token);
        showFactory = _showFactory;
        registry    = tourShell.graphRegistry();
    }

    // ─── GUARANTEES ───────────────────────────────────────────────────────

    /// @notice Record a band's tour-wide guarantee. It only counts once the band, the tour
    ///         obligor and the guarantor (if one is named) have signed it here, and it cannot be changed: an amendment is a new TPA.
    function registerGuarantee(address tpa, uint256 amount, uint64 coverageDeadline, address guarantor) external returns (uint256 id) {
        _requireTourSide();
        if (launchCleared) revert AlreadyCleared();
        if (isSealed) revert Sealed();
        if (!tourShell.isTPA(tpa)) revert UnknownTPA();
        if (guaranteeOf[tpa] != 0) revert GuaranteeExists();
        if (guaranteeCount >= MAX_GUARANTEES) revert TooMany();
        if (amount == 0 || coverageDeadline <= block.timestamp) revert InvalidGuarantee();

        ITPAView p = ITPAView(tpa);
        if (p.status() != 1) revert TPANotActive();

        id = ++guaranteeCount;
        Guarantee storage g = _g[id];
        g.tpa              = tpa;
        g.beneficiary      = p.partyB();
        g.obligor          = p.partyA();
        g.amount           = amount;
        g.coverageDeadline = coverageDeadline;
        guaranteeOf[tpa]   = id;
        emit GuaranteeRegistered(id, tpa, g.beneficiary, amount, coverageDeadline);
        if (guarantor != address(0)) {
            g.guarantor = guarantor;
            emit GuarantorNamed(id, guarantor);
        }
    }

    /// @notice The band, the tour obligor or the guarantor accepts the guarantee. Only the party
    ///         itself or an owner or admin of its org wallet can: an agent cannot bind any of them.
    function signGuarantee(uint256 id) external {
        Guarantee storage g = _guarantee(id);
        if (isSealed) revert Sealed();
        bool asBand      = _speaksFor(g.beneficiary, msg.sender);
        bool asObligor   = _speaksFor(g.obligor, msg.sender);
        bool asGuarantor = _speaksFor(g.guarantor, msg.sender);          // false when there is none: nobody is address(0)
        if (!asBand && !asObligor && !asGuarantor) revert NotAuthorized();
        if (asBand) { g.signedByBeneficiary = true; emit GuaranteeSigned(id, msg.sender, true); }
        if (asObligor) { g.signedByObligor = true; emit GuaranteeSigned(id, msg.sender, false); }
        if (asGuarantor) { g.signedByGuarantor = true; emit GuarantorSigned(id, msg.sender); }
    }

    // ─── COVER: MONEY DEPOSITED HERE ──────────────────────────────────────

    /// @notice Anyone may deposit cover for a signed guarantee, up to what it still lacks. The
    ///         depositor can take it back until the launch is cleared; after that it stays as cover.
    function depositCoverage(uint256 id, uint256 amount) external nonReentrant {
        Guarantee storage g = _guarantee(id);
        if (!_signed(g)) revert NotSigned();
        if (amount == 0) revert ZeroAmount();
        if (g.deposited + amount > g.amount) revert ExceedsGuarantee();

        g.deposited += amount;
        depositedBy[id][msg.sender] += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit CoverageDeposited(id, msg.sender, amount);
    }

    function withdrawCoverage(uint256 id, uint256 amount) external nonReentrant {
        Guarantee storage g = _guarantee(id);
        if (launchCleared && tourShell.state() != 3) revert CoverageLocked();
        if (amount == 0) revert ZeroAmount();
        if (amount > depositedBy[id][msg.sender]) revert ExceedsDeposit();

        depositedBy[id][msg.sender] -= amount;
        g.deposited -= amount;
        token.safeTransfer(msg.sender, amount);
        emit CoverageWithdrawn(id, msg.sender, amount);
    }

    // ─── COVER: A SHOW'S GUARANTEED PAYMENT ───────────────────────────────

    /// @notice Count part of a show's guaranteed payment to this tour as cover for a guarantee.
    ///         The show has to be eligible now and linked to the guarantee's TPA in the graph, and
    ///         the same dollar cannot be counted twice, for this guarantee or any other.
    function reserveShow(uint256 id, address show, bytes32 linkEdgeId, uint256 amount) external {
        _requireTourSide();
        Guarantee storage g = _guarantee(id);
        if (launchCleared) revert AlreadyCleared();                       // a tour with something to cover cannot start before this is true
        if (!_signed(g)) revert NotSigned();
        if (amount == 0) revert ZeroAmount();
        if (_reservationIndex(id, show) != type(uint256).max) revert AlreadyReserved();
        if (g.reserved + amount > g.amount) revert ExceedsGuarantee();

        (address from, address to, IGraphRegistry.EdgeType edgeType, , , ) = IGraphRegistry(registry).edges(linkEdgeId);
        if (from != g.tpa || to != show || edgeType != IGraphRegistry.EdgeType.PARENTS || !IGraphRegistry(registry).isEdgeActive(linkEdgeId)) revert WrongLink();

        uint256 cover = showCover(show);
        if (cover == 0) revert ShowNotEligible();
        if (reservedByShow[show] + amount > cover) revert ExceedsShowCover();

        if (!_inList[show]) {                              // at most as many as the settlement module takes (64)
            _inList[show] = true;
            _shows.push(show);
        }
        _res[id].push(Reservation(show, amount));
        g.reserved += amount;
        reservedByShow[show] += amount;
        emit ShowReserved(id, show, amount);
    }

    /// @notice Take a show's reservation back, before the launch is cleared.
    function releaseShow(uint256 id, address show) external {
        _requireTourSide();
        Guarantee storage g = _guarantee(id);
        if (launchCleared) revert AlreadyCleared();
        uint256 i = _reservationIndex(id, show);
        if (i == type(uint256).max) revert NothingReserved();

        uint256 amount = _res[id][i].amount;
        _res[id][i] = _res[id][_res[id].length - 1];
        _res[id].pop();
        g.reserved -= amount;
        reservedByShow[show] -= amount;
        emit ShowReleased(id, show, amount);
    }

    // ─── THE LEDGER ───────────────────────────────────────────────────────

    /// @notice Called by the tour shell when the tour starts. After this nothing new can become a
    ///         guarantee that has to be covered; cover can still be added and is still reconciled.
    function seal() external {
        if (msg.sender != address(tourShell)) revert NotShell();
        isSealed = true;
        emit CoverageSealed();
    }

    /// @notice Work out, from what is true now, how much of each guarantee is covered. Anyone can
    ///         call it. A show's cover is given to the guarantees that reserved it in the order
    ///         they were made, so when a show loses cover the later reservations lose it first.
    function reconcileCoverage() external returns (bool cleared) {
        return _reconcile();
    }

    /// @notice Try to take what a guarantee lacks from its guarantor, up to what the guarantor has
    ///         approved and holds. What cannot be taken is recorded as owed by the guarantor, and
    ///         nothing else happens. The tour side, the band or the guarantor can ask for it.
    function pullFromGuarantor(uint256 id) external nonReentrant returns (uint256 pulled) {
        Guarantee storage g = _guarantee(id);
        address guarantor = g.guarantor;
        if (guarantor == address(0)) revert NoGuarantor();
        if (!_signed(g)) revert NotSigned();
        if (!_isTourSide(msg.sender) && !_speaksFor(g.beneficiary, msg.sender) && !_speaksFor(guarantor, msg.sender)) revert NotAuthorized();

        _reconcile();
        uint256 shortfall = g.amount - g.covered;
        if (shortfall == 0) revert NoShortfall();

        uint256 allowance = token.allowance(guarantor, address(this));
        uint256 balance = token.balanceOf(guarantor);
        uint256 avail = allowance < balance ? allowance : balance;
        pulled = shortfall < avail ? shortfall : avail;           // never more than it lacks, so never past the guarantee
        if (pulled > 0) {
            try token.transferFrom(guarantor, address(this), pulled) returns (bool ok) {
                if (!ok) pulled = 0;
            } catch {
                pulled = 0;
            }
        }
        if (pulled > 0) {
            g.deposited += pulled;
            depositedBy[id][guarantor] += pulled;
            emit CoverageDeposited(id, guarantor, pulled);
        }
        g.guarantorOwed = shortfall - pulled;
        emit GuarantorShortfall(id, pulled, g.guarantorOwed);
        _reconcile();
    }

    function _reconcile() internal returns (bool) {
        uint256 n = _shows.length;
        uint256[] memory pool = new uint256[](n);
        bool[] memory isSecured = new bool[](n);                       // a show is secured in full or not at all
        for (uint256 s = 0; s < n; s++) {
            uint256 sec;
            (pool[s], sec) = _showAmounts(_shows[s]);
            isSecured[s] = sec != 0;
        }

        uint256 required;
        uint64 firstDeadline = type(uint64).max;
        uint256 cashTotal;
        uint256 securedTotal;
        uint256 contractedTotal;
        for (uint256 id = 1; id <= guaranteeCount; id++) {
            Guarantee storage g = _g[id];
            if (!_signed(g)) continue;
            required += g.amount;
            if (g.coverageDeadline < firstDeadline) firstDeadline = g.coverageDeadline;

            uint256 secured;
            uint256 contracted;
            Reservation[] storage list = _res[id];
            for (uint256 r = 0; r < list.length; r++) {
                uint256 s = _showIndex(list[r].show);
                uint256 take = list[r].amount < pool[s] ? list[r].amount : pool[s];
                pool[s] -= take;
                if (isSecured[s]) secured += take; else contracted += take;
                uint256 removed = list[r].amount - take;
                if (invalidated[id][list[r].show] != removed) {
                    invalidated[id][list[r].show] = removed;
                    if (removed > 0) emit ShowCoverageInvalidated(id, list[r].show, removed);
                }
            }

            // a guarantee needs no more than its amount: keep the most real cover first
            uint256 need = g.amount;
            uint256 cashC = g.deposited;                                // never more than the amount: deposits are capped
            need -= cashC;
            uint256 secC = secured < need ? secured : need;
            need -= secC;
            uint256 conC = contracted < need ? contracted : need;
            g.coveredCash       = cashC;
            g.coveredSecured    = secC;
            g.coveredContracted = conC;
            g.covered           = cashC + secC + conC;
            if (g.covered >= g.amount) g.guarantorOwed = 0;
            cashTotal       += cashC;
            securedTotal    += secC;
            contractedTotal += conC;
        }

        uint256 eligible = cashTotal + securedTotal + contractedTotal;
        requiredCoverage   = required;
        eligibleCoverage   = eligible;
        cashCoverage       = cashTotal;
        securedCoverage    = securedTotal;
        contractedCoverage = contractedTotal;
        emit TourCoverageUpdated(required, eligible);

        if (!launchCleared && required > 0 && eligible >= required && block.timestamp <= firstDeadline) {
            launchCleared = true;
            emit LaunchCleared(required);
        }
        return launchCleared;
    }

    // ─── VIEWS ────────────────────────────────────────────────────────────

    /// @notice How much of a show's guaranteed payment to this tour counts as cover right now:
    ///         secured and contracted together.
    function showCover(address show) public view returns (uint256 cover) {
        (cover, ) = _showAmounts(show);
    }

    /// @notice The part of that which is secured: the show's parties have funded everything it promised.
    function showSecured(address show) external view returns (uint256 secured) {
        (, secured) = _showAmounts(show);
    }

    /// @notice What is still missing: signed guarantees less what covers them.
    function coverageGap() external view returns (uint256) {
        return requiredCoverage > eligibleCoverage ? requiredCoverage - eligibleCoverage : 0;
    }

    /// @notice Whether the tour may start: the launch was cleared, or no guarantee has to be covered.
    function launchReady() external view returns (bool) {
        return launchCleared || requiredCoverage == 0;
    }

    /// @notice The amount of a TPA's tour-wide guarantee once everyone has signed it, else 0.
    ///         Read by the settlement escrow before it accepts whole-tour pay terms.
    function signedGuaranteeAmount(address tpa) external view returns (uint256) {
        uint256 id = guaranteeOf[tpa];
        if (id == 0 || !_signed(_g[id])) return 0;
        return _g[id].amount;
    }

    function getGuarantee(uint256 id) external view returns (Guarantee memory) {
        return _guarantee(id);
    }

    function getReservations(uint256 id) external view returns (Reservation[] memory) {
        _guarantee(id);
        return _res[id];
    }

    function getShows() external view returns (address[] memory) {
        return _shows;
    }

    // ─── INTERNAL ─────────────────────────────────────────────────────────

    function _guarantee(uint256 id) internal view returns (Guarantee storage) {
        if (id == 0 || id > guaranteeCount) revert UnknownGuarantee();
        return _g[id];
    }

    function _signed(Guarantee storage g) internal view returns (bool) {
        return g.signedByBeneficiary && g.signedByObligor && (g.guarantor == address(0) || g.signedByGuarantor);
    }

    /// @dev (cover, secured): what a show's guaranteed payment to this tour is worth as cover now,
    ///      and how much of that is secured by its parties' own deposits.
    function _showAmounts(address show) internal view returns (uint256 cover, uint256 secured) {
        address module = ICoverageShell(address(tourShell)).tourSettlementEscrow();
        if (module == address(0) || !ISettlementRoutes(module).isShow(show)) return (0, 0);

        IShowInstanceLike s = IShowInstanceLike(show);
        address esc = s.escrow();
        if (esc == address(0) || !IShowFactoryLike(showFactory).isEscrow(esc)) return (0, 0);
        uint8 st = s.status();
        if (!s.isFinalized() || s.isFrozen() || (st != 1 && st != 2)) return (0, 0);       // signed or active, nothing else
        if (IShowEscrowView(esc).status() != 0) return (0, 0);                              // the escrow is still active

        (uint256 fixedAmount, ) = IDebtRoute(esc).debtRoute(module);
        if (fixedAmount == 0) return (0, 0);

        uint256 released = IShowEscrowView(esc).earnedBy(module, 0);                        // guarantee stream: already paid out
        cover = fixedAmount > released ? fixedAmount - released : 0;
        if (ICoverageEscrow(esc).partyDeposited() >= ICoverageEscrow(esc).requiredFunding()) secured = cover;
    }

    function _isTourSide(address who) internal view returns (bool) {
        address owner_ = tourShell.owner();
        return who == owner_ || tourShell.isOperator(who) || _isGraphOperator(owner_, who);
    }

    function _reservationIndex(uint256 id, address show) internal view returns (uint256) {
        Reservation[] storage list = _res[id];
        for (uint256 i = 0; i < list.length; i++) if (list[i].show == show) return i;
        return type(uint256).max;
    }

    function _showIndex(address show) internal view returns (uint256) {
        for (uint256 i = 0; i < _shows.length; i++) if (_shows[i] == show) return i;
        revert ShowNotRegistered();                       // cannot happen: only listed shows are reserved
    }

    function _requireTourSide() internal view {
        if (!_isTourSide(msg.sender)) revert NotTourSide();
    }

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
