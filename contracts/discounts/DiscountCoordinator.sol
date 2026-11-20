// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IShowBundle.sol";
import "../interfaces/IFanMembership.sol";
import "../interfaces/IMiniOrg.sol";
import "../interfaces/IDiscountCoordinator.sol";
import "../interfaces/IDebtSettlement.sol";
import "../libraries/DiscountMath.sol";
import "../libraries/XaoRoles.sol";

/// @title DiscountCoordinator — who offers which ticket discount, and who pays for it (Phase 2F)
/// @notice One coordinator per show. It holds the show's discount programs, the
///         funders' signed authorizations, the limits and the record of what each
///         funder owes. It does not move money and does not mint tickets: the
///         ticket contract asks it to price an order and, when the sale goes
///         through, to commit it. Settlement of what funders owe is done by the
///         escrow that pays them.
///
///         Two kinds of discount (Data & Discount Integration v0.3):
///           - one DATA program: a buyer who shares data gets a discount, split into
///             a cell per (funder, category); each funder pays only for the cells
///             the buyer allowed it to receive.
///           - MEMBERSHIP programs: a buyer who holds a membership NFT of the
///             program gets a benefit, once per wallet per show, paid equally by
///             the program's funders.
///
///         Who pays. A show's parties (or their operators) propose a program and
///         list the funders; nobody is charged until each funder authorizes it
///         itself, with a cap on what it may be charged. A tour organizer cannot
///         authorize on behalf of a band. A funder can withdraw at any time: that
///         stops future sales only, and what it already owes stays.
///
///         Everything is locked when the show is signed: programs, rosters and
///         authorizations are set before that, and only stopping or withdrawing is
///         possible afterwards. The coordinator recomputes every price itself, so a
///         quote from an app is never trusted: `commit` refuses a sale whose quote
///         is no longer what the contract would give.
///
///         Not here yet: the data program's privacy proofs, early-access reserve
///         and report release (data module), and checking that a funder's payout
///         can actually bear its debts (escrow settlement).
/// @dev Deployed as a minimal-proxy clone by DiscountCoordinatorFactory.
contract DiscountCoordinator is IDiscountCoordinator {

    error AlreadyInitialized();
    error ZeroAddress();
    error NotShowSide();
    error NotFunderSigner();
    error FunderNotPaidByShow();
    error CapAboveGuarantee();
    error NotTicketContract();
    error ShowAlreadySigned();
    error ShowNotSigned();
    error UnknownProgram();
    error DataProgramExists();
    error NoDataProgram();
    error TooManyPrograms();
    error TooManyFunders();
    error DuplicatePriority();
    error InvalidProgram();
    error InvalidWindow();
    error NotOnRoster();
    error AlreadyOnRoster();
    error NotAuthorized();
    error ZeroCap();
    error ConsentMismatch();
    error QuoteChanged();
    error LengthMismatch();

    enum Kind { Data, Membership }

    struct DataConfig {
        uint256 maxDiscount;        // the most a buyer can save, if everything is shared
        uint8   categoryCount;
        uint256 allowedTypeMask;
        uint256 budget;             // total the program may give; 0 = no limit
        uint256 redemptionCap;      // how many buyers may take it; 0 = no limit
        uint64  effectiveFrom;
        uint64  effectiveTo;        // 0 = until the show
    }

    struct MemberConfig {
        address membership;         // the membership program a buyer must hold
        uint32  minTierPriority;
        bool    isPercent;          // amount is a share of the ticket's list price, in basis points
        uint256 amount;             // minor units, or basis points
        uint32  priority;           // headliner first; unique among the show's membership programs
        uint256 allowedTypeMask;
        uint256 budget;
        uint256 redemptionCap;
        uint64  effectiveFrom;
        uint64  effectiveTo;
    }

    struct Program {
        Kind    kind;
        bool    stopped;
        bool    isPercent;
        uint32  priority;
        uint8   categoryCount;
        uint32  minTierPriority;
        address membership;
        uint256 amount;             // DATA: the maximum discount
        uint256 allowedTypeMask;
        uint256 budget;
        uint256 budgetUsed;
        uint256 redemptionCap;
        uint256 redemptions;
        uint64  effectiveFrom;
        uint64  effectiveTo;
    }

    struct FunderAuth {
        bool    proposed;           // listed on the roster by the show side
        bool    authorized;         // the funder itself said yes
        bool    withdrawn;
        uint32  categoryMask;       // DATA: the categories this funder may receive
        uint256 maxDebit;           // the most it may be charged in this program
        uint256 debited;            // what it has been charged
    }

    uint256 public constant MAX_PROGRAMS = 17;          // one data program and sixteen membership programs
    uint256 public constant MAX_FUNDERS  = 16;

    // ─── STATE ────────────────────────────────────────────────────────────
    IShowInstanceLike public show;
    address public ticketContract;
    bool public initialized;

    uint256 public programCount;
    mapping(uint256 => Program) internal _programs;
    mapping(uint256 => address[]) internal _funders;
    mapping(uint256 => mapping(address => FunderAuth)) internal _auth;
    uint256 public dataProgramId;                       // 0 if the show has none
    uint256[] internal _memberOrder;                    // membership program ids, by rising priority

    mapping(uint256 => mapping(address => bool)) public redeemed;     // membership program => wallet
    mapping(address => bool) public dataClaimed;                      // wallet
    mapping(address => bytes32) public dataCommitment;                // wallet => its consent commitment
    mapping(address => uint256) public funderDebit;                   // everything a funder owes, over all programs
    mapping(address => uint256) public authorizedTotal;               // the caps a funder has authorized, over all programs
    uint256 public totalDebit;

    // ─── EVENTS ───────────────────────────────────────────────────────────
    event DataProgramConfigured(uint256 indexed programId, uint256 maxDiscount, uint8 categoryCount, uint256 allowedTypeMask);
    event MembershipProgramConfigured(uint256 indexed programId, address indexed membership, uint32 priority, uint256 amount, bool isPercent, uint256 allowedTypeMask);
    event FunderProposed(uint256 indexed programId, address indexed funder, uint32 categoryMask);
    event FundingAuthorized(uint256 indexed programId, address indexed funder, uint256 maxDebit);
    event FundingWithdrawn(uint256 indexed programId, address indexed funder);
    event ProgramStopped(uint256 indexed programId, address indexed by);
    event DiscountGranted(address indexed wallet, uint256 indexed programId, uint256 itemIndex, uint256 amount);
    event FunderDebited(uint256 indexed programId, address indexed funder, address indexed wallet, uint256 amount);
    event DataClaimed(address indexed wallet, bytes32 commitment);
    event MemberBenefitRedeemed(address indexed wallet, uint256 indexed programId);

    /// @dev Locks the implementation; only clones can be initialized.
    constructor() {
        initialized = true;
    }

    function initialize(address _show, address _ticketContract) external {
        if (initialized) revert AlreadyInitialized();
        if (_show == address(0) || _ticketContract == address(0)) revert ZeroAddress();
        initialized    = true;
        show           = IShowInstanceLike(_show);
        ticketContract = _ticketContract;
    }

    // ─── SETTING PROGRAMS UP (show side, before the show is signed) ───────

    function configureDataProgram(DataConfig calldata c) external returns (uint256 programId) {
        _requireShowSide();
        _requireOpen();
        if (dataProgramId != 0) revert DataProgramExists();
        if (c.maxDiscount == 0 || c.categoryCount == 0 || c.categoryCount > DiscountMath.MAX_CATEGORIES || c.allowedTypeMask == 0) revert InvalidProgram();
        _checkWindow(c.effectiveFrom, c.effectiveTo);
        if (programCount >= MAX_PROGRAMS) revert TooManyPrograms();

        programId = ++programCount;
        dataProgramId = programId;
        Program storage p = _programs[programId];
        p.kind            = Kind.Data;
        p.amount          = c.maxDiscount;
        p.categoryCount   = c.categoryCount;
        p.allowedTypeMask = c.allowedTypeMask;
        p.budget          = c.budget;
        p.redemptionCap   = c.redemptionCap;
        p.effectiveFrom   = c.effectiveFrom;
        p.effectiveTo     = c.effectiveTo;
        emit DataProgramConfigured(programId, c.maxDiscount, c.categoryCount, c.allowedTypeMask);
    }

    function configureMembershipProgram(MemberConfig calldata c) external returns (uint256 programId) {
        _requireShowSide();
        _requireOpen();
        if (c.membership.code.length == 0 || c.amount == 0 || c.allowedTypeMask == 0) revert InvalidProgram();
        if (c.isPercent && c.amount > DiscountMath.BPS) revert InvalidProgram();
        _checkWindow(c.effectiveFrom, c.effectiveTo);
        if (_memberOrder.length >= DiscountMath.MAX_MEMBER_PROGRAMS) revert TooManyPrograms();
        if (programCount >= MAX_PROGRAMS) revert TooManyPrograms();

        // Keep the membership programs sorted by priority; no two share one.
        uint256 at = _memberOrder.length;
        for (uint256 i = 0; i < _memberOrder.length; i++) {
            uint32 other = _programs[_memberOrder[i]].priority;
            if (other == c.priority) revert DuplicatePriority();
            if (other > c.priority && at == _memberOrder.length) at = i;
        }

        programId = ++programCount;
        Program storage p = _programs[programId];
        p.kind            = Kind.Membership;
        p.isPercent       = c.isPercent;
        p.priority        = c.priority;
        p.minTierPriority = c.minTierPriority;
        p.membership      = c.membership;
        p.amount          = c.amount;
        p.allowedTypeMask = c.allowedTypeMask;
        p.budget          = c.budget;
        p.redemptionCap   = c.redemptionCap;
        p.effectiveFrom   = c.effectiveFrom;
        p.effectiveTo     = c.effectiveTo;

        _memberOrder.push(programId);
        for (uint256 i = _memberOrder.length - 1; i > at; i--) _memberOrder[i] = _memberOrder[i - 1];
        _memberOrder[at] = programId;

        emit MembershipProgramConfigured(programId, c.membership, c.priority, c.amount, c.isPercent, c.allowedTypeMask);
    }

    /// @notice List a funder on a program. This only proposes: nothing is charged
    ///         until the funder authorizes it. `categoryMask` is, for the data
    ///         program, the categories that funder may receive.
    function proposeFunder(uint256 programId, address funder, uint32 categoryMask) external {
        _requireShowSide();
        _requireOpen();
        _program(programId);
        if (funder == address(0)) revert ZeroAddress();
        if (_funders[programId].length >= MAX_FUNDERS) revert TooManyFunders();
        FunderAuth storage a = _auth[programId][funder];
        if (a.proposed) revert AlreadyOnRoster();
        a.proposed     = true;
        a.categoryMask = categoryMask;
        _funders[programId].push(funder);
        emit FunderProposed(programId, funder, categoryMask);
    }

    /// @notice The funder says yes, with a cap on what it may be charged in this
    ///         program. Only the funder or an owner or admin of a funder that is
    ///         an org wallet can do this; an operator cannot make a financial promise.
    function authorizeFunding(uint256 programId, uint256 maxDebit) external {
        _requireOpen();
        _program(programId);
        if (maxDebit == 0) revert ZeroCap();
        address funder = _funderFor(programId, msg.sender);
        FunderAuth storage a = _auth[programId][funder];

        // The show has to be able to collect what a funder owes from what it pays that funder.
        uint256 total = authorizedTotal[funder] - a.maxDebit + maxDebit;
        _requireRoute(funder, total);
        authorizedTotal[funder] = total;

        a.authorized = true;
        a.maxDebit   = maxDebit;
        emit FundingAuthorized(programId, funder, maxDebit);
    }

    // ─── AFTER THE SHOW IS SIGNED: STOPPING ONLY ──────────────────────────

    /// @notice A funder leaves a program. Future sales stop using it (a membership
    ///         program needs all its funders; the data program loses only that
    ///         funder's cells); what it already owes stays.
    function withdrawFunding(uint256 programId) external {
        _program(programId);
        address funder = _funderFor(programId, msg.sender);
        _auth[programId][funder].withdrawn = true;
        emit FundingWithdrawn(programId, funder);
    }

    /// @notice The show side stops a program for future sales.
    function stopProgram(uint256 programId) external {
        _requireShowSide();
        _program(programId).stopped = true;
        emit ProgramStopped(programId, msg.sender);
    }

    // ─── PRICING AND COMMITTING A SALE ────────────────────────────────────

    /// @notice Price an order exactly as `commit` would, and give the hash that
    ///         identifies the result. Tickets pass their own tax, fee and gas.
    function quote(
        address wallet,
        uint256[] calldata typeIds,
        uint256[] calldata listPrices,
        uint256 taxBps,
        uint256 feeBps,
        uint256 gasAllotment,
        Consent calldata consent
    ) public view override returns (DiscountMath.OrderQuote memory q, bytes32 quoteHash) {
        (DiscountMath.DataOffer memory data, DiscountMath.MemberOffer[] memory members, ) = _offers(wallet, consent);
        q = DiscountMath.quoteOrder(typeIds, listPrices, taxBps, feeBps, gasAllotment, data, members);
        quoteHash = keccak256(abi.encode(wallet, typeIds, listPrices, q.discounts.itemDiscount, q.discounts.dataDebits, q.discounts.memberApplied, q.discounts.memberItem));
    }

    /// @notice Called by the ticket contract when the sale goes through. It prices
    ///         the order again, refuses it if the quote is no longer what the
    ///         contract would give, and then records everything: the buyer's
    ///         redemptions, the budgets used and what each funder owes.
    function commit(
        address wallet,
        uint256[] calldata typeIds,
        uint256[] calldata listPrices,
        uint256 taxBps,
        uint256 feeBps,
        uint256 gasAllotment,
        Consent calldata consent,
        bytes32 expectedHash
    ) external override returns (Sale memory sale) {
        if (msg.sender != ticketContract) revert NotTicketContract();
        if (!show.isFinalized()) revert ShowNotSigned();

        (DiscountMath.DataOffer memory data, DiscountMath.MemberOffer[] memory members, uint256[] memory ids) = _offers(wallet, consent);
        DiscountMath.OrderQuote memory q = DiscountMath.quoteOrder(typeIds, listPrices, taxBps, feeBps, gasAllotment, data, members);
        bytes32 h = keccak256(abi.encode(wallet, typeIds, listPrices, q.discounts.itemDiscount, q.discounts.dataDebits, q.discounts.memberApplied, q.discounts.memberItem));
        if (h != expectedHash) revert QuoteChanged();

        DiscountMath.OrderResult memory r = q.discounts;

        if (r.dataDiscount > 0) {
            _recordData(wallet, consent.commitment, r);
        }
        for (uint256 i = 0; i < ids.length; i++) {
            if (r.memberApplied[i] > 0) _recordMember(wallet, ids[i], i, r);
        }

        uint256 n = listPrices.length;
        sale.pricePaid     = q.pricePaid;
        sale.gas           = new uint256[](n);
        sale.fee           = new uint256[](n);
        sale.tax           = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            sale.gas[i] = q.parts[i].gas;
            sale.fee[i] = q.parts[i].fee;
            sale.tax[i] = q.parts[i].tax;
        }
        sale.checkoutTotal = q.checkoutTotal;
        sale.discountTotal = r.totalDiscount;
    }

    // ─── VIEWS ────────────────────────────────────────────────────────────

    function getProgram(uint256 programId) external view returns (Program memory) {
        return _program(programId);
    }

    function getFunders(uint256 programId) external view returns (address[] memory) {
        _program(programId);
        return _funders[programId];
    }

    function getFunderAuth(uint256 programId, address funder) external view returns (FunderAuth memory) {
        return _auth[programId][funder];
    }

    function getMemberOrder() external view returns (uint256[] memory) {
        return _memberOrder;
    }

    /// @notice A program is offered to buyers once the show is signed, while it is
    ///         inside its dates and not stopped, and its funders have all said yes.
    ///         The data program only needs one funder that is still in.
    function isProgramLive(uint256 programId) public view returns (bool) {
        Program storage p = _program(programId);
        if (p.stopped || !show.isFinalized()) return false;
        if (block.timestamp < p.effectiveFrom || (p.effectiveTo != 0 && block.timestamp > p.effectiveTo)) return false;

        address[] storage list = _funders[programId];
        if (list.length == 0) return false;
        if (p.kind == Kind.Data) {
            for (uint256 i = 0; i < list.length; i++) if (_funderIn(programId, list[i])) return true;
            return false;
        }
        for (uint256 i = 0; i < list.length; i++) if (!_funderIn(programId, list[i])) return false;
        return true;
    }

    // ─── INTERNAL: BUILDING THE OFFERS ────────────────────────────────────

    /// @dev Turns the stored programs and the buyer's situation into the offers DiscountMath
    ///      works on. Everything a quote depends on is read here, live.
    function _offers(address wallet, Consent calldata consent)
        internal view returns (DiscountMath.DataOffer memory data, DiscountMath.MemberOffer[] memory members, uint256[] memory ids)
    {
        data = _dataOffer(wallet, consent);

        uint256 n = _memberOrder.length;
        members = new DiscountMath.MemberOffer[](n);
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            ids[i] = _memberOrder[i];
            members[i] = _memberOffer(wallet, ids[i]);
        }
    }

    function _dataOffer(address wallet, Consent calldata consent) internal view returns (DiscountMath.DataOffer memory offer) {
        uint256 id = dataProgramId;
        offer.program.grantedMasks = new uint32[](id == 0 ? 0 : _funders[id].length);
        if (id == 0 || !isProgramLive(id) || dataClaimed[wallet] || consent.grantedMasks.length == 0) return offer;

        Program storage p = _programs[id];
        address[] storage list = _funders[id];
        if (consent.grantedMasks.length != list.length) revert ConsentMismatch();
        if (p.redemptionCap != 0 && p.redemptions >= p.redemptionCap) return offer;

        uint256 maxDiscount = p.amount;
        if (p.budget != 0) {
            uint256 room = p.budget > p.budgetUsed ? p.budget - p.budgetUsed : 0;
            if (room < maxDiscount) maxDiscount = room;
        }
        if (maxDiscount == 0) return offer;

        // The most one funder can be charged by one buyer: every one of its cells, each rounded up.
        uint256 exposure = uint256(p.categoryCount) * (maxDiscount / (list.length * p.categoryCount) + 1);
        for (uint256 i = 0; i < list.length; i++) {
            FunderAuth storage a = _auth[id][list[i]];
            bool hasRoom = a.maxDebit >= a.debited + exposure;
            offer.program.grantedMasks[i] = (_funderIn(id, list[i]) && hasRoom) ? (consent.grantedMasks[i] & a.categoryMask) : 0;
        }

        offer.program.active        = true;
        offer.program.maxDiscount   = maxDiscount;
        offer.program.categoryCount = p.categoryCount;
        offer.program.availableMask = consent.availableMask;
        offer.allowedTypeMask       = p.allowedTypeMask;
    }

    function _memberOffer(address wallet, uint256 id) internal view returns (DiscountMath.MemberOffer memory offer) {
        Program storage p = _programs[id];
        address[] storage list = _funders[id];
        offer.allowedTypeMask = p.allowedTypeMask;
        offer.program.priority        = p.priority;
        offer.program.isPercent       = p.isPercent;
        offer.program.amount          = p.amount;
        offer.program.funderCount     = uint8(list.length);
        offer.program.remainingBudget = DiscountMath.NO_BUDGET_LIMIT;

        if (!isProgramLive(id) || redeemed[id][wallet]) return offer;
        if (p.redemptionCap != 0 && p.redemptions >= p.redemptionCap) return offer;
        if (!_holdsMembership(p.membership, wallet, p.minTierPriority)) return offer;

        // The program's own budget, and the funder with the least room: an equal share of
        // `applied` can never be more than that funder may still be charged.
        uint256 room = DiscountMath.NO_BUDGET_LIMIT;
        if (p.budget != 0) room = p.budget > p.budgetUsed ? p.budget - p.budgetUsed : 0;
        uint256 minRoom = DiscountMath.NO_BUDGET_LIMIT;
        for (uint256 i = 0; i < list.length; i++) {
            FunderAuth storage a = _auth[id][list[i]];
            uint256 funderRoom = a.maxDebit > a.debited ? a.maxDebit - a.debited : 0;
            if (funderRoom < minRoom) minRoom = funderRoom;
        }
        if (minRoom != DiscountMath.NO_BUDGET_LIMIT) {
            uint256 cap = minRoom * list.length;
            if (cap < room) room = cap;
        }

        offer.program.eligible        = true;
        offer.program.remainingBudget = room;
    }

    // ─── INTERNAL: RECORDING A SALE ───────────────────────────────────────

    function _recordData(address wallet, bytes32 commitment, DiscountMath.OrderResult memory r) internal {
        uint256 id = dataProgramId;
        Program storage p = _programs[id];
        dataClaimed[wallet]    = true;
        dataCommitment[wallet] = commitment;
        p.budgetUsed += r.dataDiscount;
        p.redemptions++;
        address[] storage list = _funders[id];
        for (uint256 i = 0; i < list.length; i++) {
            if (r.dataDebits[i] > 0) _charge(id, list[i], wallet, r.dataDebits[i]);
        }
        emit DataClaimed(wallet, commitment);
        emit DiscountGranted(wallet, id, r.dataItem, r.dataDiscount);
    }

    function _recordMember(address wallet, uint256 id, uint256 index, DiscountMath.OrderResult memory r) internal {
        Program storage p = _programs[id];
        redeemed[id][wallet] = true;
        p.budgetUsed += r.memberApplied[index];
        p.redemptions++;
        address[] storage list = _funders[id];
        for (uint256 i = 0; i < list.length; i++) {
            if (r.memberDebits[index][i] > 0) _charge(id, list[i], wallet, r.memberDebits[index][i]);
        }
        emit MemberBenefitRedeemed(wallet, id);
        emit DiscountGranted(wallet, id, r.memberItem[index], r.memberApplied[index]);
    }

    function _charge(uint256 programId, address funder, address wallet, uint256 amount) internal {
        FunderAuth storage a = _auth[programId][funder];
        a.debited         += amount;
        funderDebit[funder] += amount;
        totalDebit        += amount;
        emit FunderDebited(programId, funder, wallet, amount);
    }

    // ─── INTERNAL: CHECKS ─────────────────────────────────────────────────

    function _funderIn(uint256 programId, address funder) internal view returns (bool) {
        FunderAuth storage a = _auth[programId][funder];
        return a.authorized && !a.withdrawn;
    }

    /// @dev The roster entry the caller speaks for: itself, or the org wallet it is an owner or admin of.
    function _funderFor(uint256 programId, address caller) internal view returns (address) {
        if (_auth[programId][caller].proposed) return caller;
        address[] storage list = _funders[programId];
        for (uint256 i = 0; i < list.length; i++) {
            address f = list[i];
            if (f.code.length != 0 && (_hasRole(f, caller, XaoRoles.ROLE_OWNER) || _hasRole(f, caller, XaoRoles.ROLE_ADMIN))) return f;
        }
        revert NotFunderSigner();
    }

    function _holdsMembership(address program, address wallet, uint32 minPriority) internal view returns (bool) {
        (bool ok, bytes memory data) = program.staticcall(abi.encodeCall(IFanMembership.hasActiveTier, (wallet, minPriority)));
        return ok && data.length >= 32 && uint256(bytes32(data)) != 0;
    }

    /// @dev A funder is charged by taking it from its payout. If the show only pays it fixed
    ///      amounts, its caps together cannot be more than those; if it also has a share of
    ///      the final sweep, its debts come out of that share too.
    function _requireRoute(address funder, uint256 totalCaps) internal view {
        (uint256 fixedAmount, bool hasSweepShare) = IDebtRoute(show.escrow()).debtRoute(funder);
        if (hasSweepShare) return;
        if (fixedAmount == 0) revert FunderNotPaidByShow();
        if (totalCaps > fixedAmount) revert CapAboveGuarantee();
    }

    function _requireShowSide() internal view {
        address a = show.partyA();
        address b = show.partyB();
        if (_actsFor(a, msg.sender) || (b != address(0) && _actsFor(b, msg.sender))) return;
        revert NotShowSide();
    }

    /// @dev The party itself, or an owner, admin or operator of a party that is an org wallet.
    function _actsFor(address party, address who) internal view returns (bool) {
        if (who == party) return true;
        if (party.code.length == 0) return false;
        (bool ok, bytes memory data) = party.staticcall(abi.encodeCall(IMiniOrgWallet.isGraphOperator, (who)));
        return ok && data.length >= 32 && uint256(bytes32(data)) != 0;
    }

    function _hasRole(address org, address who, bytes32 role) internal view returns (bool) {
        (bool ok, bytes memory data) = org.staticcall(abi.encodeCall(IMiniOrgWallet.hasRole, (who, role)));
        return ok && data.length >= 32 && uint256(bytes32(data)) != 0;
    }

    function _requireOpen() internal view {
        if (show.isFinalized()) revert ShowAlreadySigned();
    }

    function _checkWindow(uint64 from, uint64 to) internal pure {
        if (to != 0 && to <= from) revert InvalidWindow();
    }

    function _program(uint256 programId) internal view returns (Program storage p) {
        if (programId == 0 || programId > programCount) revert UnknownProgram();
        p = _programs[programId];
    }
}
