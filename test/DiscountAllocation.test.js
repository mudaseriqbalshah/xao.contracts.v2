// test/DiscountAllocation.test.js
// Orders with several tickets: every offer goes to one eligible ticket of the order
// (Data & Discount Integration v0.3, section 3). The scenarios are the spec's.
"use strict";

const { expect } = require("chai");
const { ethers } = require("hardhat");

const $ = (n) => ethers.parseUnits(String(n), 6);
const NO_LIMIT = ethers.MaxUint256;
const NO_ITEM = ethers.MaxUint256;
const mask = (...types) => types.reduce((m, t) => m | (1n << BigInt(t)), 0n);
const ANY = mask(...Array.from({ length: 256 }, (_, i) => i));
const GA = 2, VIP = 3;                                        // ticket types, as in the ticket contract

const item = (typeId, list, capacity = list) => ({ typeId, listPrice: list, capacity });
const noData = () => ({ program: { active: false, maxDiscount: 0n, categoryCount: 1, availableMask: 0xffff, grantedMasks: [] }, allowedTypeMask: ANY });
const dataOffer = (o = {}, allowed = ANY) => ({ program: { active: true, maxDiscount: 0n, categoryCount: 1, availableMask: 0xffff, grantedMasks: [], ...o }, allowedTypeMask: allowed });
const offer = (o = {}, allowed = ANY) => ({
  program: { eligible: true, isPercent: false, priority: 1, amount: 0n, remainingBudget: NO_LIMIT, funderCount: 1, ...o },
  allowedTypeMask: allowed,
});
const sum = (a) => a.reduce((x, y) => x + y, 0n);

// An independent re-statement of the same rules, to cross-check the contract on random orders.
function reference(items, data, members) {
  const left = items.map((i) => i.capacity);
  const itemDiscount = items.map(() => 0n);

  const dataCells = (p, cap) => {
    const debits = p.grantedMasks.map(() => 0n);
    let granted = 0n;
    const n = BigInt(p.grantedMasks.length), c = BigInt(p.categoryCount);
    if (n === 0n || c === 0n || p.maxDiscount === 0n || cap === 0n) return { granted, debits };
    const cells = n * c, base = p.maxDiscount / cells, extra = p.maxDiscount % cells;
    let remaining = cap;
    for (let i = 0; i < p.grantedMasks.length && remaining > 0n; i++) {
      const m = BigInt(p.grantedMasks[i]) & BigInt(p.availableMask);
      for (let j = 0; j < Number(c) && remaining > 0n; j++) {
        if (((m >> BigInt(j)) & 1n) === 0n) continue;
        let v = base + (BigInt(i) * c + BigInt(j) < extra ? 1n : 0n);
        if (v > remaining) v = remaining;
        debits[i] += v; granted += v; remaining -= v;
      }
    }
    return { granted, debits };
  };

  const pick = (allowed, amount, isPercent, budget) => {
    let best = -1, bestS = 0n;
    items.forEach((it, i) => {
      if (((allowed >> BigInt(it.typeId)) & 1n) === 0n || left[i] === 0n) return;
      let s = isPercent ? (it.listPrice * amount) / 10000n : amount;
      if (s > left[i]) s = left[i];
      if (s > budget) s = budget;
      if (s === 0n) return;
      const b = best >= 0 ? items[best] : null;
      if (best < 0 || s > bestS || (s === bestS && (it.listPrice > b.listPrice || (it.listPrice === b.listPrice && it.typeId < b.typeId)))) { best = i; bestS = s; }
    });
    return { best, s: bestS };
  };

  let dataDiscount = 0n, dataItem = -1, dataDebits = data.program.grantedMasks.map(() => 0n);
  if (data.program.active) {
    const value = dataCells(data.program, ethers.MaxUint256).granted;
    const { best } = pick(data.allowedTypeMask, value, false, ethers.MaxUint256);
    if (best >= 0) {
      const r = dataCells(data.program, left[best]);
      dataDiscount = r.granted; dataItem = best; dataDebits = r.debits;
      itemDiscount[best] += r.granted; left[best] -= r.granted;
    }
  }
  const applied = [], where = [], debits = [];
  for (const m of members) {
    let a = 0n, at = -1;
    if (m.program.eligible) {
      const { best, s } = pick(m.allowedTypeMask, BigInt(m.program.amount), m.program.isPercent, m.program.remainingBudget);
      if (best >= 0) { a = s; at = best; itemDiscount[best] += a; left[best] -= a; }
    }
    const f = BigInt(m.program.funderCount);
    debits.push(Array.from({ length: m.program.funderCount }, (_, i) => a / f + (BigInt(i) < a % f ? 1n : 0n)));
    applied.push(a); where.push(at);
  }
  return { itemDiscount, dataDiscount, dataItem, dataDebits, applied, where, debits, total: dataDiscount + sum(applied) };
}

describe("DiscountMath: orders with several tickets", function () {
  let m;
  const run = (items, data = noData(), members = []) => m.allocate(items, data, members);

  before(async function () {
    m = await (await ethers.getContractFactory("MockDiscountMathOrder")).deploy();
  });

  // ─── THE SPEC'S EXAMPLES ────────────────────────────────────────────────
  describe("the spec's examples", function () {
    it("$50 VIP + $20 GA; Band A $5 on VIP, Band B $2 on GA: VIP pays $45, GA pays $18", async function () {
      const r = await m.quoteOrder([VIP, GA], [$(50), $(20)], 800, 200, $(1), noData(), [
        offer({ priority: 1, amount: $(5) }, mask(VIP)),         // Band A
        offer({ priority: 2, amount: $(2) }, mask(GA)),          // Band B
      ]);
      expect([...r.pricePaid]).to.deep.equal([$(45), $(18)]);
      expect([...r.discounts.memberItem]).to.deep.equal([0n, 1n]);
      expect(r.checkoutTotal).to.equal($(63));
      expect([...r.refundable]).to.deep.equal([$(44), $(17)]);           // each less its own $1 gas
    });

    it("a $5 ticket; $1 data and five $1 memberships: data first, then four, the fifth applies nothing", async function () {
      const progs = [1, 2, 3, 4, 5].map((p) => offer({ priority: p, amount: $(1) }));
      const r = await run([item(GA, $(5))], dataOffer({ maxDiscount: $(1), grantedMasks: [1] }), progs);
      expect(r.dataDiscount).to.equal($(1));
      expect([...r.memberApplied]).to.deep.equal([$(1), $(1), $(1), $(1), 0n]);
      expect(r.memberItem[4]).to.equal(NO_ITEM);
      expect(sum([...r.memberDebits[4]])).to.equal(0);
      expect([...r.itemDiscount]).to.deep.equal([$(5)]);
    });

    it("five $20 GA tickets and $3 of discounts: one ticket carries them all, the other four stay at $20", async function () {
      const items = Array.from({ length: 5 }, () => item(GA, $(20)));
      const r = await run(items, dataOffer({ maxDiscount: $(1), grantedMasks: [1] }), [offer({ amount: $(2) })]);
      expect([...r.itemDiscount]).to.deep.equal([$(3), 0n, 0n, 0n, 0n]);
      expect(r.dataItem).to.equal(0);
      expect(r.memberItem[0]).to.equal(0);
    });

    it("only a VIP bought, and a GA-only membership: nothing applied, nothing charged, nothing redeemed", async function () {
      const r = await run([item(VIP, $(50))], noData(), [offer({ amount: $(5) }, mask(GA))]);
      expect(r.memberApplied[0]).to.equal(0);
      expect(r.memberItem[0]).to.equal(NO_ITEM);
      expect(sum([...r.memberDebits[0]])).to.equal(0);
      expect(r.totalDiscount).to.equal(0);
    });
  });

  // ─── WHICH TICKET ───────────────────────────────────────────────────────
  describe("which ticket an offer goes to", function () {
    it("where it saves the most, even if another ticket costs more", async function () {
      // The VIP has only $2 of room, the GA has $5: a $5 offer saves more on the GA.
      const r = await run([item(VIP, $(50), $(2)), item(GA, $(20), $(5))], noData(), [offer({ amount: $(5) })]);
      expect(r.memberItem[0]).to.equal(1);
      expect(r.memberApplied[0]).to.equal($(5));
    });

    it("on equal savings, the ticket with the higher face price", async function () {
      const r = await run([item(GA, $(20)), item(VIP, $(50))], noData(), [offer({ amount: $(5) })]);
      expect(r.memberItem[0]).to.equal(1);
    });

    it("on equal savings and price, the lower ticket type, then the earlier item", async function () {
      let r = await run([item(VIP, $(20)), item(GA, $(20))], noData(), [offer({ amount: $(5) })]);
      expect(r.memberItem[0]).to.equal(1);                                  // GA (type 2) before VIP (type 3)
      r = await run([item(GA, $(20)), item(GA, $(20)), item(GA, $(20))], noData(), [offer({ amount: $(5) })]);
      expect(r.memberItem[0]).to.equal(0);
    });

    it("a percentage is a share of each ticket's own price, so it picks the dearer ticket", async function () {
      const r = await run([item(GA, $(20)), item(VIP, $(50))], noData(), [offer({ isPercent: true, amount: 1_000 })]);
      expect(r.memberItem[0]).to.equal(1);
      expect(r.memberApplied[0]).to.equal($(5));                           // 10% of $50, not of $20
    });

    it("never splits one offer over two tickets: a trimmed offer stays on its ticket", async function () {
      const r = await run([item(GA, $(20), $(3)), item(GA, $(20), $(3))], noData(), [offer({ amount: $(5) })]);
      expect(r.memberApplied[0]).to.equal($(3));                           // trimmed, not moved on
      expect([...r.itemDiscount]).to.deep.equal([$(3), 0n]);
    });

    it("a later offer moves on once a ticket is used up", async function () {
      const r = await run([item(GA, $(20), $(3)), item(GA, $(20), $(3))], noData(),
        [offer({ priority: 1, amount: $(3) }), offer({ priority: 2, amount: $(3) })]);
      expect([...r.memberItem]).to.deep.equal([0n, 1n]);
      expect([...r.itemDiscount]).to.deep.equal([$(3), $(3)]);
    });

    it("offers are only given to the types they list", async function () {
      const r = await run([item(GA, $(20)), item(VIP, $(50))], noData(), [offer({ amount: $(5) }, mask(GA))]);
      expect(r.memberItem[0]).to.equal(0);
      const none = await run([item(GA, $(20))], noData(), [offer({ amount: $(5) }, 0n)]);
      expect(none.memberApplied[0]).to.equal(0);
    });

    it("the data discount lands on a ticket of a type it allows", async function () {
      const r = await run([item(GA, $(20)), item(VIP, $(50))], dataOffer({ maxDiscount: $(2), grantedMasks: [1] }, mask(GA)));
      expect(r.dataItem).to.equal(0);
      expect([...r.dataDebits]).to.deep.equal([$(2)]);
    });
  });

  // ─── TRIMMING AND ORDER ─────────────────────────────────────────────────
  describe("trimming and order", function () {
    it("the data discount goes first, so a member benefit may be trimmed by it", async function () {
      const r = await run([item(GA, $(1.5))], dataOffer({ maxDiscount: $(1), grantedMasks: [1] }), [offer({ amount: $(1) })]);
      expect(r.dataDiscount).to.equal($(1));
      expect(r.memberApplied[0]).to.equal($(0.5));
    });

    it("a last benefit that only partly fits is applied in part and counts as redeemed", async function () {
      const progs = [offer({ priority: 1, amount: $(1) }), offer({ priority: 2, amount: $(1) }), offer({ priority: 3, amount: $(1) })];
      const r = await run([item(GA, $(2.4))], dataOffer({ maxDiscount: $(1), grantedMasks: [1] }), progs);
      expect([...r.memberApplied]).to.deep.equal([$(1), $(0.4), 0n]);
    });

    it("splits an offer's cost equally between its funders, and the data cost between its cells", async function () {
      const r = await run([item(GA, $(20))], dataOffer({ maxDiscount: $(1), grantedMasks: [1, 1] }),
        [offer({ amount: 1_000_001n, funderCount: 2 })]);
      expect([...r.dataDebits]).to.deep.equal([$(0.5), $(0.5)]);
      expect([...r.memberDebits[0]]).to.deep.equal([500_001n, 500_000n]);
    });

    it("a program that is not eligible, or has no budget, is skipped without a trace", async function () {
      const r = await run([item(GA, $(20))], noData(), [
        offer({ priority: 1, amount: $(2), eligible: false }),
        offer({ priority: 2, amount: $(2), remainingBudget: 0n }),
        offer({ priority: 3, amount: $(2) }),
      ]);
      expect([...r.memberApplied]).to.deep.equal([0n, 0n, $(2)]);
      expect([...r.memberItem]).to.deep.equal([NO_ITEM, NO_ITEM, 0n]);
    });

    it("works offer by offer, and does not search for the best overall combination (a known limit)", async function () {
      // Offer 1 may use either ticket; offer 2 only the VIP. Offer 1 goes to the dearer VIP,
      // so offer 2 finds it full. Giving offer 1 to the GA would have saved $10 instead of $5.
      const r = await run([item(GA, $(20), $(5)), item(VIP, $(50), $(5))], noData(), [
        offer({ priority: 1, amount: $(5) }, mask(GA, VIP)),
        offer({ priority: 2, amount: $(5) }, mask(VIP)),
      ]);
      expect(r.totalDiscount).to.equal($(5));
      expect(r.memberItem[0]).to.equal(1);
      expect(r.memberApplied[1]).to.equal(0);
    });
  });

  // ─── PRICE OF AN ORDER ──────────────────────────────────────────────────
  describe("the price of an order", function () {
    it("a $20 ticket with a $2 member discount costs $18 and refunds $17, as in the client's example", async function () {
      const r = await m.quoteOrder([GA], [$(20)], 800, 200, $(1), noData(), [offer({ amount: $(2) })]);
      expect(r.pricePaid[0]).to.equal($(18));
      expect(r.refundable[0]).to.equal($(17));
      expect(r.checkoutTotal).to.equal($(18));
      expect(r.parts[0].net).to.equal($(17));
    });

    it("discounts never take more than a ticket's net: it still pays tax, gas and Xao's fee", async function () {
      const r = await m.quoteOrder([GA], [$(20)], 800, 200, $(1), noData(), [offer({ amount: $(20) })]);
      expect(r.discounts.itemDiscount[0]).to.equal($(17));
      expect(r.pricePaid[0]).to.equal($(3));
    });

    it("tickets without a discount keep their full price, and the order adds up", async function () {
      const r = await m.quoteOrder([GA, GA, GA], [$(20), $(20), $(20)], 800, 200, $(1), noData(), [offer({ amount: $(3) })]);
      expect([...r.pricePaid]).to.deep.equal([$(17), $(20), $(20)]);
      expect(r.checkoutTotal).to.equal($(57));
    });

    it("rejects orders that make no sense", async function () {
      const big = Array.from({ length: 11 }, () => item(GA, $(20)));
      await expect(run(big)).to.be.revertedWithCustomError(m, "TooManyItems");
      await expect(run([item(256, $(20))])).to.be.revertedWithCustomError(m, "TypeIdTooLarge");
      await expect(m.quoteOrder([GA], [$(20), $(20)], 800, 200, $(1), noData(), [])).to.be.revertedWithCustomError(m, "LengthMismatch");
      await expect(run([item(GA, $(20))], noData(), [offer({ priority: 2, amount: 1n }), offer({ priority: 1, amount: 1n })]))
        .to.be.revertedWithCustomError(m, "NotOrdered");
      await expect(run([item(GA, $(20))], noData(), [offer({ isPercent: true, amount: 10_001 })])).to.be.revertedWithCustomError(m, "InvalidBps");
      await expect(run([item(GA, $(20))], noData(), [offer({ amount: $(1), funderCount: 0 })])).to.be.revertedWithCustomError(m, "NoFunders");
      // An offer with nobody to pay for it is only an error if it would have applied.
      await run([item(VIP, $(20))], noData(), [offer({ amount: $(1), funderCount: 0 }, mask(GA))]);
    });
  });

  // ─── RANDOM ORDERS ──────────────────────────────────────────────────────
  describe("random orders", function () {
    let seed = 20261120;
    const rnd = (n) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; };

    function randomOrder() {
      const n = 1 + rnd(6);
      const items = Array.from({ length: n }, () => {
        const list = BigInt(1_000_000 + rnd(60_000_000));
        return item(rnd(5), list, BigInt(rnd(Number(list) + 1)));
      });
      const categories = 1 + rnd(4);
      const data = dataOffer({
        active: rnd(4) !== 0, maxDiscount: BigInt(rnd(5_000_000)), categoryCount: categories,
        availableMask: rnd(1 << categories), grantedMasks: Array.from({ length: rnd(5) }, () => rnd(1 << categories)),
      }, BigInt(rnd(32)));
      const members = Array.from({ length: rnd(6) }, (_, i) => {
        const percent = rnd(3) === 0;
        return offer({
          eligible: rnd(5) !== 0, isPercent: percent, priority: (i + 1) * 2,
          amount: BigInt(percent ? rnd(10_001) : rnd(4_000_000)),
          remainingBudget: rnd(3) === 0 ? BigInt(rnd(2_000_000)) : NO_LIMIT, funderCount: 1 + rnd(4),
        }, BigInt(rnd(32)));
      });
      return { items, data, members };
    }

    it("matches an independent reference and keeps every promise, over 400 random orders", async function () {
      for (let k = 0; k < 400; k++) {
        const { items, data, members } = randomOrder();
        const r = await run(items, data, members);
        const ref = reference(items, data, members);

        expect([...r.itemDiscount], `case ${k}`).to.deep.equal(ref.itemDiscount);
        expect(r.dataDiscount, `case ${k}`).to.equal(ref.dataDiscount);
        expect([...r.dataDebits], `case ${k}`).to.deep.equal(ref.dataDebits);
        expect([...r.memberApplied], `case ${k}`).to.deep.equal(ref.applied);
        expect(r.memberDebits.map((x) => [...x]), `case ${k}`).to.deep.equal(ref.debits);
        expect(r.totalDiscount, `case ${k}`).to.equal(ref.total);

        // The promises that matter, stated on their own.
        items.forEach((it, i) => expect(r.itemDiscount[i], `case ${k} ticket ${i}`).to.be.lte(it.capacity));
        expect(sum([...r.itemDiscount]), `case ${k}`).to.equal(r.totalDiscount);
        expect(sum([...r.dataDebits]), `case ${k}`).to.equal(r.dataDiscount);
        r.memberApplied.forEach((a, i) => {
          expect(sum([...r.memberDebits[i]]), `case ${k} offer ${i}`).to.equal(a);
          if (a > 0n) {
            const at = Number(r.memberItem[i]);
            expect((members[i].allowedTypeMask >> BigInt(items[at].typeId)) & 1n, `case ${k} offer ${i} type`).to.equal(1n);
            expect(members[i].program.eligible, `case ${k} offer ${i}`).to.equal(true);
          } else {
            expect(r.memberItem[i], `case ${k} offer ${i}`).to.equal(NO_ITEM);
          }
        });
        if (r.dataDiscount > 0n) {
          expect((data.allowedTypeMask >> BigInt(items[Number(r.dataItem)].typeId)) & 1n, `case ${k} data type`).to.equal(1n);
        }
      }
    });
  });
});
