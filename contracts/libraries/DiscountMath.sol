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
///         HOW A TICKET PRICE IS BUILT (client, Nov 2026)
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
///         ORDERS WITH SEVERAL TICKETS (Data & Discount Integration v0.3, section 3)
///         `allocate` and `quoteOrder` replace the single designated ticket. Every
///         offer lists the ticket types it applies to, and goes to exactly ONE
///         eligible ticket of the order, chosen automatically (the buyer is never
///         asked). Offers are taken in order, the data offer first and then the
///         membership programs by priority. For each offer the ticket is the one
///         where the offer saves the most; on a tie: the higher face price, then the
///         lower ticket-type id, then the earlier item. A ticket cannot be discounted
///         beyond its own capacity, so an offer is trimmed, and an offer with no
///         eligible ticket left applies nothing, is not charged and is not redeemed.
///         Several tickets of one order can end up discounted when offers target
///         different types. `allocate` works offer by offer: it does not search for
///         the combination that saves the most overall.
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
    error TooManyItems();
    error TypeIdTooLarge();
    error LengthMismatch();

    uint256 internal constant MAX_FUNDERS         = 16;
    uint256 internal constant MAX_CATEGORIES      = 16;
    uint256 internal constant MAX_MEMBER_PROGRAMS = 16;
    uint256 internal constant BPS                 = 10_000;
    uint256 internal constant NO_BUDGET_LIMIT     = type(uint256).max;
    uint256 internal constant MAX_ORDER_ITEMS     = 10;           // the most tickets one wallet buys in an order
    uint256 internal constant MAX_TYPE_ID         = 255;          // ticket types are matched with a 256-bit mask
    uint256 internal constant NO_ITEM             = type(uint256).max;

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

    /// @dev One ticket of an order.
    struct OrderItem {
        uint256 typeId;             // the ticket type (tier), below 256
        uint256 listPrice;          // its face price; percentages are shares of this
        uint256 capacity;           // the most that can be discounted on this ticket (its net)
    }

    /// @dev An offer plus the ticket types it applies to (bit t set = type t).
    struct DataOffer {
        DataProgram program;
        uint256     allowedTypeMask;
    }

    struct MemberOffer {
        MemberProgram program;
        uint256       allowedTypeMask;
    }

    struct OrderResult {
        uint256[]   itemDiscount;   // per ticket of the order
        uint256     dataDiscount;
        uint256     dataItem;       // the ticket the data discount went to, or NO_ITEM
        uint256[]   dataDebits;     // per data funder
        uint256[]   memberApplied;  // per program; redeemed only if above zero
        uint256[]   memberItem;     // the ticket each program went to, or NO_ITEM
        uint256[][] memberDebits;   // per program, per its funder
        uint256     totalDiscount;
    }

    /// @dev A whole order priced: parts and price of each ticket, and what the buyer pays.
    struct OrderQuote {
        Breakdown[] parts;
        OrderResult discounts;
        uint256[]   pricePaid;      // per ticket: list price less its discounts
        uint256[]   refundable;     // per ticket on cancellation: pricePaid less its gas
        uint256     checkoutTotal;
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

    /// @notice Price a whole order: split every ticket, allocate the offers over the
    ///         tickets, and work out what each ticket and the buyer pays.
    function quoteOrder(
        uint256[] memory typeIds,
        uint256[] memory listPrices,
        uint256 taxBps,
        uint256 feeBps,
        uint256 gasAllotment,
        DataOffer memory data,
        MemberOffer[] memory members
    ) internal pure returns (OrderQuote memory q) {
        uint256 n = listPrices.length;
        if (typeIds.length != n) revert LengthMismatch();
        if (n > MAX_ORDER_ITEMS) revert TooManyItems();

        q.parts     = new Breakdown[](n);
        q.pricePaid = new uint256[](n);
        q.refundable = new uint256[](n);
        OrderItem[] memory items = new OrderItem[](n);
        for (uint256 i = 0; i < n; i++) {
            q.parts[i] = breakdown(listPrices[i], taxBps, feeBps, gasAllotment);
            items[i] = OrderItem(typeIds[i], listPrices[i], q.parts[i].net);
        }

        q.discounts = allocate(items, data, members);

        for (uint256 i = 0; i < n; i++) {
            q.pricePaid[i]  = listPrices[i] - q.discounts.itemDiscount[i];
            q.refundable[i] = q.pricePaid[i] - q.parts[i].gas;
            q.checkoutTotal += q.pricePaid[i];
        }
    }

    /// @notice Give every offer to one eligible ticket of the order. See the header.
    function allocate(OrderItem[] memory items, DataOffer memory data, MemberOffer[] memory members)
        internal pure returns (OrderResult memory r)
    {
        uint256 n = items.length;
        if (n > MAX_ORDER_ITEMS) revert TooManyItems();
        if (members.length > MAX_MEMBER_PROGRAMS) revert TooManyPrograms();

        uint256[] memory left = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            if (items[i].typeId > MAX_TYPE_ID) revert TypeIdTooLarge();
            left[i] = items[i].capacity;
        }
        r.itemDiscount = new uint256[](n);
        r.dataItem     = NO_ITEM;
        r.dataDebits   = new uint256[](data.program.grantedMasks.length);

        // 1. The data discount comes first. Its full value is worked out once, then it
        //    goes to the ticket where it saves the most.
        if (data.program.active) {
            uint256 value = _applyData(data.program, type(uint256).max, new uint256[](data.program.grantedMasks.length));
            (uint256 at, ) = _pick(items, left, data.allowedTypeMask, value, false, NO_BUDGET_LIMIT);
            if (at != NO_ITEM) {
                uint256 granted = _applyData(data.program, left[at], r.dataDebits);
                r.dataDiscount    = granted;
                r.dataItem        = at;
                r.itemDiscount[at] += granted;
                left[at]          -= granted;
            }
        }

        // 2. Then each membership program, in priority order.
        r.memberApplied = new uint256[](members.length);
        r.memberItem    = new uint256[](members.length);
        r.memberDebits  = new uint256[][](members.length);
        uint32 previous;
        for (uint256 i = 0; i < members.length; i++) {
            MemberProgram memory p = members[i].program;
            if (i > 0 && p.priority <= previous) revert NotOrdered();
            previous = p.priority;
            if (p.funderCount > MAX_FUNDERS) revert TooManyFunders();
            if (p.isPercent && p.amount > BPS) revert InvalidBps();

            r.memberItem[i] = NO_ITEM;
            uint256 applied;
            if (p.eligible) {
                (uint256 at, uint256 savings) = _pick(items, left, members[i].allowedTypeMask, p.amount, p.isPercent, p.remainingBudget);
                if (at != NO_ITEM) {
                    if (p.funderCount == 0) revert NoFunders();
                    applied            = savings;
                    r.memberItem[i]    = at;
                    r.itemDiscount[at] += applied;
                    left[at]          -= applied;
                }
            }
            r.memberApplied[i] = applied;
            r.memberDebits[i]  = _split(applied, p.funderCount);
        }
        r.totalDiscount = r.dataDiscount;
        for (uint256 i = 0; i < members.length; i++) r.totalDiscount += r.memberApplied[i];
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

    /// @dev The ticket an offer goes to: where it saves the most (its amount, or its share of the
    ///      ticket's list price, limited by what is left of the ticket and of the offer's budget).
    ///      Ties: higher face price, then lower ticket-type id, then the earlier item.
    ///      Returns NO_ITEM if no allowed ticket has room.
    function _pick(
        OrderItem[] memory items,
        uint256[] memory left,
        uint256 allowedTypeMask,
        uint256 amount,
        bool isPercent,
        uint256 budget
    ) private pure returns (uint256 best, uint256 bestSavings) {
        best = NO_ITEM;
        for (uint256 i = 0; i < items.length; i++) {
            if ((allowedTypeMask >> items[i].typeId) & 1 == 0 || left[i] == 0) continue;

            uint256 savings = isPercent ? items[i].listPrice * amount / BPS : amount;
            if (savings > left[i]) savings = left[i];
            if (savings > budget) savings = budget;
            if (savings == 0) continue;

            if (
                best == NO_ITEM
                || savings > bestSavings
                || (savings == bestSavings && (
                    items[i].listPrice > items[best].listPrice
                    || (items[i].listPrice == items[best].listPrice && items[i].typeId < items[best].typeId)
                ))
            ) {
                best = i;
                bestSavings = savings;
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
