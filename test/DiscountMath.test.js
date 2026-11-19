// test/DiscountMath.test.js
// The arithmetic of ticket discounts, checked against the numbers in the
// Discount Funding & Settlement spec (scenario ids T01...T34 are the spec's).
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");

const $ = (n) => ethers.parseUnits(String(n), 6);        // dollars -> minor units (6 decimals)
const NO_LIMIT = ethers.MaxUint256;
const ALL = (c) => (1 << c) - 1;                           // every category shared

function data(o = {}) {
  return { active: true, maxDiscount: 0n, categoryCount: 1, availableMask: 0xffff, grantedMasks: [], ...o };
}
function member(o = {}) {
  return { eligible: true, isPercent: false, priority: 1, amount: 0n, remainingBudget: NO_LIMIT, funderCount: 1, ...o };
}
const sum = (a) => a.reduce((x, y) => x + y, 0n);

// An independent re-statement of the rules, used to cross-check the contract on random input.
function reference(list, net, d, members) {
  let left = net;
  const dataDebits = d.grantedMasks.map(() => 0n);
  let dataDiscount = 0n;
  if (d.active) {
    const n = BigInt(d.grantedMasks.length), c = BigInt(d.categoryCount);
    if (n > 0n && c > 0n && d.maxDiscount > 0n && left > 0n) {
      const cells = n * c, base = d.maxDiscount / cells, extra = d.maxDiscount % cells;
      outer:
      for (let i = 0; i < d.grantedMasks.length; i++) {
        const mask = BigInt(d.grantedMasks[i]) & BigInt(d.availableMask);
        for (let j = 0; j < Number(c); j++) {
          if (((mask >> BigInt(j)) & 1n) === 0n) continue;
          let v = base + (BigInt(i) * c + BigInt(j) < extra ? 1n : 0n);
          if (v > left) v = left;
          dataDebits[i] += v; dataDiscount += v; left -= v;
          if (left === 0n) break outer;
        }
      }
    }
  }
  const applied = [], debits = [];
  let memberDiscount = 0n;
  for (const p of members) {
    let a = 0n;
    if (p.eligible && left > 0n) {
      a = p.isPercent ? (list * BigInt(p.amount)) / 10000n : BigInt(p.amount);
      if (a > left) a = left;
      if (a > p.remainingBudget) a = p.remainingBudget;
    }
    const f = BigInt(p.funderCount);
    debits.push(Array.from({ length: p.funderCount }, (_, i) => a / f + (BigInt(i) < a % f ? 1n : 0n)));
    applied.push(a); memberDiscount += a; left -= a;
  }
  return { dataDiscount, memberDiscount, totalDiscount: dataDiscount + memberDiscount, netAfter: net - dataDiscount - memberDiscount, dataDebits, applied, debits };
}

describe("DiscountMath", function () {
  let m;
  // `net` is the most that can be discounted; by default the whole price, so the data and
  // membership examples below can be read on their own.
  const run = (list, d, members = [], net = list) => m.compute(list, net, d, members);

  before(async function () {
    m = await (await ethers.getContractFactory("MockDiscountMath")).deploy();
  });

  // ─── DATA DISCOUNT: WHO PAYS FOR WHAT ───────────────────────────────────
  describe("data discount", function () {
    it("T01: a $2 offer with two funders costs each $1; a party that declined pays nothing", async function () {
      const r = await run($(20), data({ maxDiscount: $(2), categoryCount: 1, grantedMasks: [1, 1] }));
      expect(r.dataDiscount).to.equal($(2));
      expect([...r.dataDebits]).to.deep.equal([$(1), $(1)]);
      expect(r.netAfter).to.equal($(18));
    });

    it("T02: the same $2 offer with five funders costs each $0.40", async function () {
      const r = await run($(20), data({ maxDiscount: $(2), categoryCount: 1, grantedMasks: [1, 1, 1, 1, 1] }));
      expect([...r.dataDebits]).to.deep.equal(Array(5).fill($(0.4)));
      expect(r.dataDiscount).to.equal($(2));
    });

    it("T03: 5 parties x 4 categories, $1, everything shared: $0.20 each", async function () {
      const r = await run($(20), data({ maxDiscount: $(1), categoryCount: 4, grantedMasks: Array(5).fill(ALL(4)) }));
      expect(r.dataDiscount).to.equal($(1));
      expect([...r.dataDebits]).to.deep.equal(Array(5).fill($(0.2)));
    });

    it("T04: blocking one party entirely saves $0.80; that party pays nothing and the rest still pay $0.20", async function () {
      const r = await run($(20), data({ maxDiscount: $(1), categoryCount: 4, grantedMasks: [ALL(4), ALL(4), 0, ALL(4), ALL(4)] }));
      expect(r.dataDiscount).to.equal($(0.8));
      expect([...r.dataDebits]).to.deep.equal([$(0.2), $(0.2), 0n, $(0.2), $(0.2)]);
    });

    it("T05: blocking one of four categories for everyone saves $0.75, $0.15 each", async function () {
      const r = await run($(20), data({ maxDiscount: $(1), categoryCount: 4, grantedMasks: Array(5).fill(0b0111) }));
      expect(r.dataDiscount).to.equal($(0.75));
      expect([...r.dataDebits]).to.deep.equal(Array(5).fill($(0.15)));
    });

    it("T06: three categories shared with four of five parties saves $0.60, $0.15 each to those four", async function () {
      const r = await run($(20), data({ maxDiscount: $(1), categoryCount: 4, grantedMasks: [0b0111, 0b0111, 0b0111, 0b0111, 0] }));
      expect(r.dataDiscount).to.equal($(0.6));
      expect([...r.dataDebits]).to.deep.equal([$(0.15), $(0.15), $(0.15), $(0.15), 0n]);
    });

    it("T07: sharing nothing earns nothing and charges nobody", async function () {
      const r = await run($(20), data({ maxDiscount: $(1), categoryCount: 4, grantedMasks: Array(5).fill(0) }));
      expect(r.dataDiscount).to.equal(0);
      expect(sum([...r.dataDebits])).to.equal(0);
      expect(r.netAfter).to.equal($(20));
    });

    it("T33: a category the buyer has no data for earns nothing, and is not charged to anyone else", async function () {
      const r = await run($(20), data({ maxDiscount: $(1), categoryCount: 4, availableMask: 0b0011, grantedMasks: Array(5).fill(ALL(4)) }));
      expect(r.dataDiscount).to.equal($(0.5));
      expect([...r.dataDebits]).to.deep.equal(Array(5).fill($(0.1)));
    });

    it("T16: an amount that does not split evenly is exact; leftover units go to the first cells", async function () {
      const r = await run($(20), data({ maxDiscount: 1_000_003n, categoryCount: 1, grantedMasks: [1, 1, 1] }));
      expect([...r.dataDebits]).to.deep.equal([333_335n, 333_334n, 333_334n]);
      expect(r.dataDiscount).to.equal(1_000_003n);
    });

    it("a cell that is not shared does not pass its leftover unit on to anyone", async function () {
      // 3 cells, 1 leftover unit belongs to cell 0. If cell 0 is not shared, that unit is simply not given.
      const r = await run($(20), data({ maxDiscount: 1_000_003n, categoryCount: 1, grantedMasks: [0, 1, 1] }));
      expect([...r.dataDebits]).to.deep.equal([0n, 333_334n, 333_334n]);
      expect(r.dataDiscount).to.equal(666_668n);
    });

    it("an inactive program (already taken by this wallet, or switched off) gives nothing", async function () {
      const r = await run($(20), data({ active: false, maxDiscount: $(1), grantedMasks: [1, 1] }));
      expect(r.dataDiscount).to.equal(0);
      expect(r.netAfter).to.equal($(20));
    });

    it("never takes the price below zero: cells are used in order until the price is spent", async function () {
      const r = await run($(0.6), data({ maxDiscount: $(1), categoryCount: 1, grantedMasks: [1, 1] }));
      expect(r.dataDiscount).to.equal($(0.6));
      expect([...r.dataDebits]).to.deep.equal([$(0.5), $(0.1)]);
      expect(r.netAfter).to.equal(0);
    });

    it("rejects input that makes no sense", async function () {
      await expect(run($(20), data({ maxDiscount: $(1), categoryCount: 2, grantedMasks: [0b100] }))).to.be.revertedWithCustomError(m, "InvalidMask");
      await expect(run($(20), data({ maxDiscount: $(1), categoryCount: 17, grantedMasks: [1] }))).to.be.revertedWithCustomError(m, "TooManyCategories");
      await expect(run($(20), data({ maxDiscount: $(1), grantedMasks: Array(17).fill(1) }))).to.be.revertedWithCustomError(m, "TooManyFunders");
    });
  });

  // ─── MEMBERSHIP DISCOUNTS ───────────────────────────────────────────────
  describe("membership discounts", function () {
    it("a single program takes its amount off", async function () {
      const r = await run($(20), data({ active: false }), [member({ amount: $(2) })]);
      expect(r.memberDiscount).to.equal($(2));
      expect(r.netAfter).to.equal($(18));
      expect([...r.memberApplied]).to.deep.equal([$(2)]);
      expect([...r.memberDebits[0]]).to.deep.equal([$(2)]);
    });

    it("a program that is not eligible applies and charges nothing (T26)", async function () {
      const r = await run($(20), data({ active: false }), [member({ eligible: false, amount: $(2) })]);
      expect(r.memberDiscount).to.equal(0);
      expect([...r.memberApplied]).to.deep.equal([0n]);
      expect(sum([...r.memberDebits[0]])).to.equal(0);
    });

    it("splits the applied amount equally between the program's funders, exactly", async function () {
      const r = await run($(20), data({ active: false }), [member({ amount: 1_000_001n, funderCount: 2 })]);
      expect([...r.memberDebits[0]]).to.deep.equal([500_001n, 500_000n]);
      const r3 = await run($(20), data({ active: false }), [member({ amount: $(1), funderCount: 3 })]);
      expect([...r3.memberDebits[0]]).to.deep.equal([333_334n, 333_333n, 333_333n]);
    });

    it("a percentage is a share of the ticket's list price", async function () {
      const r = await run($(20), data({ active: false }), [member({ isPercent: true, amount: 1_000 })]);     // 10%
      expect(r.memberDiscount).to.equal($(2));
      await expect(run($(20), data({ active: false }), [member({ isPercent: true, amount: 10_001 })])).to.be.revertedWithCustomError(m, "InvalidBps");
    });

    it("a program stops at what is left of its budget, and an empty budget applies nothing (T27, T32)", async function () {
      const part = await run($(20), data({ active: false }), [member({ amount: $(1), remainingBudget: $(0.4) })]);
      expect(part.memberApplied[0]).to.equal($(0.4));
      const none = await run($(20), data({ active: false }), [
        member({ priority: 1, amount: $(1), remainingBudget: 0n }),
        member({ priority: 2, amount: $(1) }),
      ]);
      expect([...none.memberApplied]).to.deep.equal([0n, $(1)]);          // the empty one is skipped; nobody else pays for it
    });

    it("an eligible program with nobody to pay for it is an error, not a free discount", async function () {
      await expect(run($(20), data({ active: false }), [member({ amount: $(1), funderCount: 0 })])).to.be.revertedWithCustomError(m, "NoFunders");
    });

    it("programs must come in strictly rising priority", async function () {
      await expect(run($(20), data({ active: false }), [member({ priority: 2, amount: 1n }), member({ priority: 1, amount: 1n })]))
        .to.be.revertedWithCustomError(m, "NotOrdered");
      await expect(run($(20), data({ active: false }), [member({ priority: 1, amount: 1n }), member({ priority: 1, amount: 1n })]))
        .to.be.revertedWithCustomError(m, "NotOrdered");
    });

    it("allows at most 16 programs", async function () {
      const list = Array.from({ length: 17 }, (_, i) => member({ priority: i + 1, amount: 1n }));
      await expect(run($(20), data({ active: false }), list)).to.be.revertedWithCustomError(m, "TooManyPrograms");
    });
  });

  // ─── STACKING ───────────────────────────────────────────────────────────
  describe("stacking", function () {
    it("data and membership discounts add up (the spec's $20 example): band $1.50, venue $0.50, price $18", async function () {
      const r = await run($(20),
        data({ maxDiscount: $(1), categoryCount: 1, grantedMasks: [1, 1] }),                // band and venue
        [member({ amount: $(1), funderCount: 1 })]);                                        // band's own member offer
      expect(r.dataDiscount).to.equal($(1));
      expect(r.memberDiscount).to.equal($(1));
      expect(r.netAfter).to.equal($(18));
      expect([...r.dataDebits]).to.deep.equal([$(0.5), $(0.5)]);
      expect([...r.memberDebits[0]]).to.deep.equal([$(1)]);
    });

    it("T20/T23: several programs stack with data; a $20 ticket with $3 of savings costs $17", async function () {
      const r = await run($(20),
        data({ maxDiscount: $(1), categoryCount: 1, grantedMasks: [1] }),
        [member({ priority: 1, amount: $(1) }), member({ priority: 2, amount: $(1) })]);
      expect(r.totalDiscount).to.equal($(3));
      expect(r.netAfter).to.equal($(17));
    });

    it("T21: on a $5 ticket, data first, then four $1 member benefits; the fifth is not applied or charged", async function () {
      const progs = [1, 2, 3, 4, 5].map((p) => member({ priority: p, amount: $(1) }));
      const r = await run($(5), data({ maxDiscount: $(1), categoryCount: 1, grantedMasks: [1] }), progs);
      expect(r.dataDiscount).to.equal($(1));
      expect([...r.memberApplied]).to.deep.equal([$(1), $(1), $(1), $(1), 0n]);
      expect(r.netAfter).to.equal(0);
      expect(sum([...r.memberDebits[4]])).to.equal(0);
    });

    it("T22: when $0.40 is left, the next $1 benefit applies only $0.40 and the one after nothing", async function () {
      const progs = [member({ priority: 1, amount: $(1) }), member({ priority: 2, amount: $(1) }), member({ priority: 3, amount: $(1) })];
      const r = await run($(2.4), data({ maxDiscount: $(1), categoryCount: 1, grantedMasks: [1] }), progs);
      expect([...r.memberApplied]).to.deep.equal([$(1), $(0.4), 0n]);
      expect(r.netAfter).to.equal(0);
    });

    it("T14/T29: the earlier (headliner) program uses up the price before a later one", async function () {
      const r = await run($(1.5), data({ active: false }), [member({ priority: 1, amount: $(1) }), member({ priority: 9, amount: $(1) })]);
      expect([...r.memberApplied]).to.deep.equal([$(1), $(0.5)]);
      const r2 = await run($(1), data({ active: false }), [member({ priority: 1, amount: $(1) }), member({ priority: 9, amount: $(1) })]);
      expect([...r2.memberApplied]).to.deep.equal([$(1), 0n]);
    });

    it("the data discount is applied before any membership program, even a higher priority one", async function () {
      const r = await run($(1.5), data({ maxDiscount: $(1), categoryCount: 1, grantedMasks: [1] }), [member({ priority: 1, amount: $(1) })]);
      expect(r.dataDiscount).to.equal($(1));
      expect(r.memberApplied[0]).to.equal($(0.5));
    });

    it("a free ticket stays free: nothing more is applied or charged (T24)", async function () {
      const r = await run(0, data({ maxDiscount: $(1), grantedMasks: [1] }), [member({ amount: $(1) })]);
      expect(r.totalDiscount).to.equal(0);
      expect(r.netAfter).to.equal(0);
    });
  });

  // ─── TICKET AND FEE ─────────────────────────────────────────────────────
  describe("ticket choice", function () {
    it("T08: five tickets, one carries all the savings: the highest priced, the first on a tie", async function () {
      expect(await m.selectTicket([$(20), $(20), $(20), $(20), $(20)])).to.equal(0);
      expect(await m.selectTicket([$(10), $(30), $(30), $(5)])).to.equal(1);
      await expect(m.selectTicket([])).to.be.revertedWithCustomError(m, "NoTickets");
    });
  });

  // ─── PRICE PARTS AND QUOTE ──────────────────────────────────────────────
  describe("price parts and quote", function () {
    let seed = 777;
    const rnd = (n) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; };
    const quote = (list, d, members) => m.quote(list, 800, 200, $(1), d, members);     // 8% tax, 2% Xao, $1 gas

    it("a $20 ticket holds sales tax $1.60, gas $1, Xao's 2% $0.40 and a net of $17", async function () {
      const b = await m.breakdown($(20), 800, 200, $(1));
      expect(b.tax).to.equal($(1.6));
      expect(b.gas).to.equal($(1));
      expect(b.fee).to.equal($(0.4));
      expect(b.net).to.equal($(17));
    });

    it("the client's example: a $2 member discount makes the checkout $18, and a cancelled ticket refunds $17", async function () {
      const q = await quote($(20), data({ active: false }), [member({ amount: $(2) })]);
      expect(q.discounts.netBefore).to.equal($(17));
      expect(q.discounts.netAfter).to.equal($(15));
      expect(q.checkoutTotal).to.equal($(18));          // (17 - 2) + 1.60 tax + 1 gas + 0.40 Xao
      expect(q.refundable).to.equal($(17));             // everything but the gas
    });

    it("Xao's fee, the tax and the gas do not shrink with a discount (spec v0.2 T25 said otherwise)", async function () {
      const q = await quote($(20),
        data({ maxDiscount: $(1), categoryCount: 1, grantedMasks: [1] }),
        [member({ amount: $(2) })]);
      expect(q.discounts.totalDiscount).to.equal($(3));
      expect(q.parts.fee).to.equal($(0.4));             // not 2% of the discounted price
      expect(q.parts.tax).to.equal($(1.6));
      expect(q.parts.gas).to.equal($(1));
      expect(q.checkoutTotal).to.equal($(17));
    });

    it("discounts never take more than the net, so the buyer always pays at least tax, gas and Xao's fee", async function () {
      const q = await quote($(20), data({ active: false }), [member({ amount: $(20) })]);
      expect(q.discounts.totalDiscount).to.equal($(17));
      expect(q.discounts.netAfter).to.equal(0);
      expect(q.checkoutTotal).to.equal($(3));           // 1.60 + 1 + 0.40
      expect(q.refundable).to.equal($(2));              // tax and Xao's fee come back, gas does not
    });

    it("a cheap ticket gives up gas first, then the fee, then the tax", async function () {
      let b = await m.breakdown($(0.5), 800, 200, $(1));
      expect([b.gas, b.fee, b.tax, b.net]).to.deep.equal([$(0.5), 0n, 0n, 0n]);
      b = await m.breakdown($(1.5), 800, 200, $(1));
      expect([b.gas, b.fee, b.tax, b.net]).to.deep.equal([$(1), $(0.03), $(0.12), $(0.35)]);
      b = await m.breakdown(0, 800, 200, $(1));
      expect([b.gas, b.fee, b.tax, b.net]).to.deep.equal([0n, 0n, 0n, 0n]);
    });

    it("tax and fee are rounded down, never up", async function () {
      let b = await m.breakdown(49_999n, 0, 200, 0);
      expect(b.fee).to.equal(999n);                     // 999.98
      b = await m.breakdown(1_234_567n, 800, 200, $(1));
      expect(b.tax).to.equal(98_765n);                  // 98,765.36
      expect(b.fee).to.equal(24_691n);                  // 24,691.34
    });

    it("rejects a tax or fee above 100%", async function () {
      await expect(m.breakdown($(20), 10_001, 200, $(1))).to.be.revertedWithCustomError(m, "InvalidBps");
      await expect(m.breakdown($(20), 800, 10_001, $(1))).to.be.revertedWithCustomError(m, "InvalidBps");
    });

    it("the four parts always add up to the list price, over 300 random prices", async function () {
      for (let k = 0; k < 300; k++) {
        const list = BigInt(rnd(90_000_000)), tax = rnd(2_001), fee = rnd(501), gas = BigInt(rnd(3_000_000));
        const b = await m.breakdown(list, tax, fee, gas);
        expect(b.gas + b.fee + b.tax + b.net, `case ${k}`).to.equal(list);
      }
    });

    it("random quotes: checkout is the list price less the discounts, and the refund is the checkout less the gas", async function () {
      for (let k = 0; k < 200; k++) {
        const list = BigInt(rnd(90_000_000));
        const members = Array.from({ length: rnd(4) }, (_, i) => member({ priority: i + 1, amount: BigInt(rnd(30_000_000)) }));
        const q = await quote(list, data({ maxDiscount: BigInt(rnd(5_000_000)), categoryCount: 1, grantedMasks: [1, 1] }), members);
        expect(q.checkoutTotal, `case ${k}`).to.equal(list - q.discounts.totalDiscount);
        expect(q.refundable, `case ${k}`).to.equal(q.checkoutTotal - q.parts.gas);
        expect(q.checkoutTotal, `case ${k}`).to.be.gte(q.parts.tax + q.parts.gas + q.parts.fee);
        expect(q.discounts.totalDiscount, `case ${k}`).to.be.lte(q.parts.net);
        expect(q.refundable, `case ${k}`).to.be.gte(q.parts.tax + q.parts.fee);
      }
    });
  });

  // ─── PROPERTIES ON RANDOM INPUT ─────────────────────────────────────────
  describe("random input", function () {
    // A small seeded generator, so a failure can be reproduced.
    let seed = 20261121;
    const rnd = (n) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; };

    function randomCase() {
      const list = BigInt(rnd(60_000_000));
      const net = BigInt(rnd(Number(list) + 1));
      const categories = 1 + rnd(6);
      const funders = rnd(7);
      const d = {
        active: rnd(4) !== 0,
        maxDiscount: BigInt(rnd(5_000_000)),
        categoryCount: categories,
        availableMask: rnd(1 << categories),
        grantedMasks: Array.from({ length: funders }, () => rnd(1 << categories)),
      };
      const count = rnd(7);
      const members = Array.from({ length: count }, (_, i) => {
        const percent = rnd(3) === 0;
        return member({
          eligible: rnd(5) !== 0,
          isPercent: percent,
          priority: (i + 1) * 3,
          amount: BigInt(percent ? rnd(10_001) : rnd(4_000_000)),
          remainingBudget: rnd(3) === 0 ? BigInt(rnd(2_000_000)) : NO_LIMIT,
          funderCount: 1 + rnd(4),
        });
      });
      return { list, net, d, members };
    }

    it("matches an independent reference and keeps every promise, over 400 random cases", async function () {
      for (let k = 0; k < 400; k++) {
        const { list, net, d, members } = randomCase();
        const r = await run(list, d, members, net);
        const ref = reference(list, net, d, members);

        // Same numbers as the reference model.
        expect(r.dataDiscount, `case ${k}`).to.equal(ref.dataDiscount);
        expect(r.memberDiscount, `case ${k}`).to.equal(ref.memberDiscount);
        expect(r.netAfter, `case ${k}`).to.equal(ref.netAfter);
        expect([...r.dataDebits], `case ${k}`).to.deep.equal(ref.dataDebits);
        expect([...r.memberApplied], `case ${k}`).to.deep.equal(ref.applied);
        expect(r.memberDebits.map((x) => [...x]), `case ${k}`).to.deep.equal(ref.debits);

        // The promises that matter, stated on their own.
        expect(r.totalDiscount, `case ${k}`).to.be.lte(net);                                   // never more than the net
        expect(r.netAfter + r.totalDiscount, `case ${k}`).to.equal(net);
        expect(sum([...r.dataDebits]), `case ${k}`).to.equal(r.dataDiscount);                   // data debits = data discount
        r.memberApplied.forEach((a, i) => {
          expect(sum([...r.memberDebits[i]]), `case ${k} program ${i}`).to.equal(a);            // every discount is charged in full, to its funders
          if (!members[i].eligible) expect(a, `case ${k} program ${i}`).to.equal(0);           // not eligible, nothing
        });
        // Once the ticket is free, nothing later is applied.
        if (r.netAfter === 0n) {
          let seenFree = false, running = r.dataDiscount;
          r.memberApplied.forEach((a) => {
            if (seenFree) expect(a, `case ${k}`).to.equal(0);
            running += a;
            if (running === net) seenFree = true;
          });
        }
      }
    });
  });
});
