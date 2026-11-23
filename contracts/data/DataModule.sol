// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IShowBundle.sol";
import "../interfaces/IDiscountCoordinator.sol";
import "../interfaces/IMiniOrg.sol";
import "../libraries/XaoRoles.sol";

/// @title DataModule — the on-chain side of a show's data discount (Phase 2F, Data & Discount v0.3)
/// @notice One module per show. The contracts never hold fan data: this module only
///         keeps who may receive a report, when it may be released, the proof that it
///         was released, and the money that backs early releases.
///
///         Each data funder (a party that pays for fans' data through the show's data
///         discount program) chooses how it receives data:
///           - POST_SHOW: after the show is completed. Nothing is owed if the show is
///             cancelled, because nothing was delivered.
///           - EARLY: aggregate reports while tickets are still selling. The funder puts a
///             reserve in first, as large as the most it can ever be charged in the data
///             program. If the show is then cancelled, every buyer whose data was released
///             to that funder is paid, out of that reserve, the discount the funder gave
///             on that buyer's claim (the buyer's refund only returns what they paid).
///         The coordinator gives data discounts only for funders this module calls backed,
///         so an EARLY funder that has not put its reserve in by the deadline is simply
///         left out. A funder can move from POST_SHOW to EARLY, never back, because the
///         reserve is already held.
///
///         Release. Three independent nodes (named when the module is made) confirm that
///         a report went to a funder; two confirmations of the same report record it.
///         The contract does not check the report itself, only that two nodes say it
///         was sent and that the funder was entitled to it.
/// @dev A minimal-proxy clone made by DataModuleFactory.
contract DataModule is IDataGuard {
    using SafeERC20 for IERC20;

    error AlreadyInitialized();
    error ZeroAddress();
    error BadNodes();
    error BadDeadline();
    error NoDataProgram();
    error NotFunderSigner();
    error NotANode();
    error WrongMode();
    error ModeLocked();
    error ReserveMissing();
    error DeadlinePassed();
    error ShowStarted();
    error ZeroAmount();
    error NotAllowedNow();
    error NothingToRelease();
    error NotReleased();
    error AlreadyPaid();
    error TooManyWallets();
    error NoShare();
    error NotFinished();

    enum Mode { None, PostShow, Early }

    uint256 public constant MAX_REPORT_WALLETS = 100;

    // ─── STATE ────────────────────────────────────────────────────────────
    bool public initialized;
    IShowInstanceLike public show;
    IDataSource public coordinator;
    IERC20 public token;
    uint64 public reserveDeadline;                          // an EARLY funder has to have its reserve in by this time
    address[3] public nodes;

    mapping(address => Mode) public modeOf;                 // funder => how it receives data
    mapping(address => uint256) public reserveOf;           // funder => reserve held
    mapping(address => uint256) public owedOf;              // funder => buyers' compensation not yet paid (reports released, show not called off yet counts as potential)
    mapping(address => mapping(address => bool)) public released;     // funder => buyer wallet => report released
    mapping(address => mapping(address => bool)) public compensated;  // funder => buyer wallet => paid

    mapping(bytes32 => mapping(address => bool)) internal _confirmedBy;
    mapping(bytes32 => uint8) public confirmations;
    mapping(bytes32 => bool) public reportRecorded;

    // ─── EVENTS ───────────────────────────────────────────────────────────
    event ModeSet(address indexed funder, Mode mode);
    event ReserveDeposited(address indexed funder, uint256 amount, uint256 total);
    event ReserveWithdrawn(address indexed funder, uint256 amount);
    event ReleaseConfirmed(bytes32 indexed reportHash, address indexed node, uint8 count);
    event ReportReleased(bytes32 indexed reportId, address indexed funder, address indexed wallet);
    event Compensated(address indexed funder, address indexed wallet, uint256 amount);

    constructor() {
        initialized = true;
    }

    function initialize(address _show, address _coordinator, address[3] calldata _nodes, uint64 _reserveDeadline) external {
        if (initialized) revert AlreadyInitialized();
        if (_show == address(0) || _coordinator == address(0)) revert ZeroAddress();
        for (uint256 i = 0; i < 3; i++) {
            if (_nodes[i] == address(0)) revert BadNodes();
            for (uint256 j = 0; j < i; j++) if (_nodes[i] == _nodes[j]) revert BadNodes();
        }
        if (_reserveDeadline <= block.timestamp) revert BadDeadline();
        initialized     = true;
        show            = IShowInstanceLike(_show);
        coordinator     = IDataSource(_coordinator);
        token           = IERC20(IAgreementEscrowLike(IShowInstanceLike(_show).escrow()).payoutToken());
        reserveDeadline = _reserveDeadline;
        nodes           = _nodes;
    }

    // ─── FUNDER: HOW IT RECEIVES DATA, AND ITS RESERVE ────────────────────

    /// @notice Choose POST_SHOW or EARLY. A first choice can be either; after that only
    ///         POST_SHOW -> EARLY, and only with the reserve already in and before the show starts.
    function setMode(Mode mode) external {
        if (mode == Mode.None) revert WrongMode();
        address funder = _funderFor(msg.sender);
        Mode current = modeOf[funder];
        if (current == mode) revert WrongMode();
        if (current == Mode.Early) revert ModeLocked();
        if (current == Mode.PostShow) {
            if (block.timestamp >= show.showStartTime()) revert ShowStarted();
            if (reserveOf[funder] < _required(funder)) revert ReserveMissing();
        }
        modeOf[funder] = mode;
        emit ModeSet(funder, mode);
    }

    /// @notice Put reserve in, paid by the caller. Only until the deadline: a funder that
    ///         has not covered its cap by then cannot receive data discounts early.
    function depositReserve(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        address funder = _funderFor(msg.sender);
        if (block.timestamp > reserveDeadline) revert DeadlinePassed();
        reserveOf[funder] += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit ReserveDeposited(funder, amount, reserveOf[funder]);
    }

    /// @notice Take the reserve back once the show is over. After a cancelled show, what
    ///         is still owed to buyers stays until they have been paid.
    function withdrawReserve() external {
        address funder = _funderFor(msg.sender);
        uint8 s = show.status();
        uint256 held = reserveOf[funder];
        uint256 amount;
        if (s == 4) {
            amount = held;
        } else if (s == 5 || s == 6) {
            uint256 owed = owedOf[funder];
            amount = held > owed ? held - owed : 0;
        } else {
            revert NotFinished();
        }
        if (amount == 0) revert ZeroAmount();
        reserveOf[funder] = held - amount;
        token.safeTransfer(funder, amount);
        emit ReserveWithdrawn(funder, amount);
    }

    // ─── NODES: RECORDING THAT A REPORT WENT OUT ──────────────────────────

    /// @notice A node says report `reportId` went to `funder` and covers `wallets`' claims.
    ///         The second node to say the same thing records it.
    function confirmRelease(address funder, bytes32 reportId, address[] calldata wallets) external {
        if (msg.sender != nodes[0] && msg.sender != nodes[1] && msg.sender != nodes[2]) revert NotANode();
        if (wallets.length == 0) revert NothingToRelease();
        if (wallets.length > MAX_REPORT_WALLETS) revert TooManyWallets();

        bytes32 h = keccak256(abi.encode(funder, reportId, wallets));
        if (reportRecorded[h] || _confirmedBy[h][msg.sender]) return;
        _confirmedBy[h][msg.sender] = true;
        uint8 count = ++confirmations[h];
        emit ReleaseConfirmed(h, msg.sender, count);
        if (count < 2) return;

        reportRecorded[h] = true;
        for (uint256 i = 0; i < wallets.length; i++) {
            address w = wallets[i];
            if (released[funder][w]) continue;
            if (!_mayRelease(funder, w)) revert NotAllowedNow();
            released[funder][w] = true;
            owedOf[funder] += coordinator.dataShare(w, funder);
            emit ReportReleased(reportId, funder, w);
        }
    }

    // ─── CANCELLED SHOW: PAYING THE BUYER ─────────────────────────────────

    /// @notice After a cancelled show, pay a buyer the discount `funder` gave on that
    ///         buyer's claim, from the funder's reserve. Anyone can call this.
    function compensate(address funder, address wallet) external {
        uint8 s = show.status();
        if (s != 5 && s != 6) revert NotFinished();
        if (!released[funder][wallet]) revert NotReleased();
        if (compensated[funder][wallet]) revert AlreadyPaid();

        uint256 amount = coordinator.dataShare(wallet, funder);
        compensated[funder][wallet] = true;
        owedOf[funder]   -= amount;
        reserveOf[funder] -= amount;
        token.safeTransfer(wallet, amount);
        emit Compensated(funder, wallet, amount);
    }

    // ─── VIEWS ────────────────────────────────────────────────────────────

    /// @notice The coordinator gives a funder data discounts only while this is true:
    ///         POST_SHOW needs nothing, EARLY needs the reserve to cover its cap.
    function funderBacked(address funder) public view override returns (bool) {
        Mode m = modeOf[funder];
        if (m == Mode.PostShow) return true;
        if (m == Mode.Early) return reserveOf[funder] >= _required(funder);
        return false;
    }

    /// @notice What the funder has to hold in reserve to receive data early.
    function requiredReserve(address funder) external view returns (uint256) {
        return _required(funder);
    }

    /// @notice Whether a report for `wallet`'s claim may go to `funder` now. The nodes check this.
    function canRelease(address funder, address wallet) external view returns (bool) {
        return !released[funder][wallet] && _mayRelease(funder, wallet);
    }

    // ─── INTERNAL ─────────────────────────────────────────────────────────

    function _mayRelease(address funder, address wallet) internal view returns (bool) {
        if (coordinator.dataShare(wallet, funder) == 0) return false;
        uint8 s = show.status();
        if (s == 5 || s == 6) return false;
        Mode m = modeOf[funder];
        if (s == 4) return m != Mode.None;                  // completed: every funder that was charged gets its report, reserve or not
        return m == Mode.Early && funderBacked(funder);     // before that, only EARLY funders, and only while backed
    }

    function _required(address funder) internal view returns (uint256) {
        uint256 id = coordinator.dataProgramId();
        if (id == 0) return 0;
        return coordinator.getFunderAuth(id, funder).maxDebit;
    }

    /// @dev The data-program roster entry the caller speaks for: itself, or the org wallet it is an owner or admin of.
    function _funderFor(address caller) internal view returns (address) {
        uint256 id = coordinator.dataProgramId();
        if (id == 0) revert NoDataProgram();
        if (coordinator.getFunderAuth(id, caller).proposed) return caller;
        address[] memory list = coordinator.getFunders(id);
        for (uint256 i = 0; i < list.length; i++) {
            address f = list[i];
            if (f.code.length != 0 && (_hasRole(f, caller, XaoRoles.ROLE_OWNER) || _hasRole(f, caller, XaoRoles.ROLE_ADMIN))) return f;
        }
        revert NotFunderSigner();
    }

    function _hasRole(address org, address who, bytes32 role) internal view returns (bool) {
        (bool ok, bytes memory data) = org.staticcall(abi.encodeCall(IMiniOrgWallet.hasRole, (who, role)));
        return ok && data.length >= 32 && uint256(bytes32(data)) != 0;
    }
}
