// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title DiscountMath — the arithmetic of ticket prices and discounts (Phase 2F)
/// @notice Pure integer maths for ticket pricing and the Discount Funding &
///         Settlement spec. It reads no state and moves no money: the contract
///         that sells the ticket checks eligibility (membership held, already
///         redeemed, budget left), passes the answers in, and acts on the result.
///
///         All amounts are in the payment token's smallest unit. There is no
///         floating point.
///
///         HOW A TICKET PRICE IS BUILT (client, 2026-11-22)
///         The organizer sets the ticket's list price, say $20. That is what the
///         buyer pays, and it holds four parts, all worked out on the LIST price:
///             sales tax 8%   $1.60
///             gas            $1.00
///             Xao fee 2%     $0.40
///             net            $17.00   (what is left for the organizer)
///         A discount comes off the NET only. Tax, gas and Xao's fee do not
///         change, so Xao is never charged for a discount. With a $2 discount the
///         buyer pays 20 - 2 = $18. If the show is cancelled the buyer gets back
///         everything but the gas: $17.
///
///         HOW DISCOUNTS ARE APPLIED (spec sections 3, 5)
///         - All discounts land on ONE ticket (`selectTicket` picks it).
///         - The data discount is applied first, then membership programs in
///           priority order (headliner first). The discounts never take more
///           than the net, so the net never goes below zero.
///         - A discount that does not fully fit is applied partially, up to what
///           is left. A program passed over because nothing is left applies
///           nothing, so it must not be charged or counted as redeemed.
///         - Data discount: the program's maximum is cut into one equal cell for
///           every (funder, category) pair. The buyer gets the cells they allowed
///           and have data for; each cell is charged to its own funder alone.
///           Nothing is moved to other funders when a cell is missing.
///         - Membership discount: the applied amount is split equally between
///           that program's funders.
///         - Rounding is deterministic: leftover units go to the first cells or
///           funders in their listed order, so the sums are always exact.
///
///         Choices the spec leaves open, made here and easy to change:
///         - The ticket picked is the highest priced one (the first on a tie).
///         - A percentage discount is a share of the ticket's list price.
///         - A program's remaining budget limits what it applies, like the net.
///         - When the data discount is bigger than the net, cells are used in
///           order until the net is spent.
///         - Tax, fee and gas are rounded down, and squeezed in that order (gas,
///           then fee, then tax) if a ticket is so cheap they would not fit.
library DiscountMath {

    error TooManyFunders();
    error TooManyCategories();
    error TooManyPrograms();
    error InvalidMask();
    error NotOrdered();
    error InvalidBps();
    error NoFunders();
    error NoTickets();

    uint256 internal constant MAX_FUNDERS         = 16;
    uint256 internal constant MAX_CATEGORIES      = 16;
    uint256 internal constant MAX_MEMBER_PROGRAMS = 16;
    uint256 internal constant BPS                 = 10_000;
    uint256 internal constant NO_BUDGET_LIMIT     = type(uint256).max;

    /// @dev The one optional data-sharing discount of a show.
    struct DataProgram {
        bool     active;            // on, and this wallet has not taken it for this show
        uint256  maxDiscount;       // the most the buyer can save, if they share everything
        uint8    categoryCount;     // how many kinds of information the offer names
        uint32   availableMask;     // bit c: the buyer has data for category c
        uint32[] grantedMasks;      // one per funder, in funder order: bit c = category c is shared with that funder
    }

    /// @dev One membership benefit. Pass them already in priority order.
    struct MemberProgram {
        bool    eligible;           // buyer holds the NFT, has not redeemed it for this show, program is live
        bool    isPercent;          // amount is a share of the list price, in basis points
        uint32  priority;           // lower is first (headliner); must strictly increase along the list
        uint256 amount;             // minor units, or basis points when isPercent
        uint256 remainingBudget;    // NO_BUDGET_LIMIT if the program has none
        uint8   funderCount;        // who pays for it, equally
    }

    /// @dev What a list price is made of.
    struct Breakdown {
        uint256 listPrice;
        uint256 gas;
        uint256 fee;                // Xao's fee
        uint256 tax;                // sales tax
        uint256 net;                // list price less gas, fee and tax: what the organizer receives before discounts
    }

    struct Result {
        uint256     listPrice;
        uint256     netBefore;      // the most that can be discounted
        uint256     dataDiscount;
        uint256     memberDiscount;
        uint256     totalDiscount;
        uint256     netAfter;       // net after discounts: what reaches the organizer's escrow
        uint256[]   dataDebits;     // per data funder
        uint256[]   memberApplied;  // per program; a program counts as redeemed only if this is above zero
        uint256[][] memberDebits;   // per program, per its funder
    }

    /// @dev Everything a ticket sale needs: the parts, the discounts, what the
    ///      buyer pays and what comes back if the show is cancelled.
    struct Quote {
        Breakdown parts;
        Result    discounts;
        uint256   checkoutTotal;    // what the buyer pays for this ticket
        uint256   refundable;       // what the buyer gets back on cancellation (everything but the gas)
    }

    /// @notice Split a list price into gas, Xao's fee, sales tax and net. Each is
    ///         worked out on the list price and rounded down; if a ticket is too
    ///         cheap to hold all of them, gas goes first, then the fee, then tax.
    function breakdown(uint256 listPrice, uint256 taxBps, uint256 feeBps, uint256 gasAllotment)
        internal pure returns (Breakdown memory b)
    {
        if (taxBps > BPS || feeBps > BPS) revert InvalidBps();
        b.listPrice = listPrice;
        uint256 left = listPrice;

        b.gas = gasAllotment < left ? gasAllotment : left;
        left -= b.gas;

        b.fee = listPrice * feeBps / BPS;
        if (b.fee > left) b.fee = left;
        left -= b.fee;

        b.tax = listPrice * taxBps / BPS;
        if (b.tax > left) b.tax = left;
        left -= b.tax;

        b.net = left;
    }

    /// @notice Price one ticket: its parts, the discounts, the checkout total
    ///         and the refundable amount.
    function quote(
        uint256 listPrice,
        uint256 taxBps,
        uint256 feeBps,
        uint256 gasAllotment,
        DataProgram memory data,
        MemberProgram[] memory members
    ) internal pure returns (Quote memory q) {
        q.parts         = breakdown(listPrice, taxBps, feeBps, gasAllotment);
        q.discounts     = compute(listPrice, q.parts.net, data, members);
        q.checkoutTotal = listPrice - q.discounts.totalDiscount;
        q.refundable    = q.checkoutTotal - q.parts.gas;
    }

    /// @notice Work out the discounts for the one designated ticket. `net` is the
    ///         most they can add up to; percentages are shares of `listPrice`.
    function compute(uint256 listPrice, uint256 net, DataProgram memory data, MemberProgram[] memory members)
        internal pure returns (Result memory r)
    {
        if (members.length > MAX_MEMBER_PROGRAMS) revert TooManyPrograms();
        r.listPrice = listPrice;
        r.netBefore = net;
        uint256 left = net;

        // 1. The data discount comes first.
        r.dataDebits = new uint256[](data.grantedMasks.length);
        if (data.active) {
            r.dataDiscount = _applyData(data, left, r.dataDebits);
            left -= r.dataDiscount;
        }

        // 2. Then each membership program, in priority order.
        r.memberApplied = new uint256[](members.length);
        r.memberDebits  = new uint256[][](members.length);
        uint32 previous;
        for (uint256 i = 0; i < members.length; i++) {
            MemberProgram memory p = members[i];
            if (i > 0 && p.priority <= previous) revert NotOrdered();
            previous = p.priority;
            if (p.funderCount > MAX_FUNDERS) revert TooManyFunders();

            uint256 applied;
            if (p.eligible && left > 0) {
                uint256 wanted = p.amount;
                if (p.isPercent) {
                    if (p.amount > BPS) revert InvalidBps();
                    wanted = listPrice * p.amount / BPS;
                }
                applied = wanted;
                if (applied > left) applied = left;
                if (applied > p.remainingBudget) applied = p.remainingBudget;
                if (applied > 0 && p.funderCount == 0) revert NoFunders();
            }
            r.memberApplied[i] = applied;
            r.memberDebits[i]  = _split(applied, p.funderCount);
            r.memberDiscount  += applied;
            left              -= applied;
        }

        r.totalDiscount = r.dataDiscount + r.memberDiscount;
        r.netAfter      = net - r.totalDiscount;
    }

    /// @notice The ticket that carries the discounts: the highest priced, and the
    ///         first one if several cost the same. No input from the buyer.
    function selectTicket(uint256[] memory prices) internal pure returns (uint256 index) {
        if (prices.length == 0) revert NoTickets();
        for (uint256 i = 1; i < prices.length; i++) {
            if (prices[i] > prices[index]) index = i;
        }
    }

    // ─── INTERNAL ─────────────────────────────────────────────────────────

    /// @dev Fills `debits` and returns the discount granted. Cell k (funder i,
    ///      category j, k = i * categoryCount + j) is worth `max / cells`, and
    ///      the first `max % cells` cells are worth one unit more.
    function _applyData(DataProgram memory data, uint256 left, uint256[] memory debits)
        private pure returns (uint256 granted)
    {
        uint256 funders    = data.grantedMasks.length;
        uint256 categories = data.categoryCount;
        if (funders > MAX_FUNDERS) revert TooManyFunders();
        if (categories > MAX_CATEGORIES) revert TooManyCategories();
        if (funders == 0 || categories == 0 || data.maxDiscount == 0 || left == 0) return 0;

        uint256 cells = funders * categories;
        uint256 base  = data.maxDiscount / cells;
        uint256 extra = data.maxDiscount % cells;

        for (uint256 i = 0; i < funders; i++) {
            uint32 shared = data.grantedMasks[i];
            if (uint256(shared) >> categories != 0) revert InvalidMask();
            shared &= data.availableMask;

            for (uint256 j = 0; j < categories; j++) {
                if ((shared >> j) & 1 == 0) continue;
                uint256 value = base + (i * categories + j < extra ? 1 : 0);
                if (value > left) value = left;
                debits[i] += value;
                granted   += value;
                left      -= value;
                if (left == 0) return granted;
            }
        }
    }

    /// @dev Equal shares; the first `amount % n` funders pay one unit more.
    function _split(uint256 amount, uint256 n) private pure returns (uint256[] memory shares) {
        shares = new uint256[](n);
        if (n == 0) return shares;
        uint256 base  = amount / n;
        uint256 extra = amount % n;
        for (uint256 i = 0; i < n; i++) shares[i] = base + (i < extra ? 1 : 0);
    }
}
