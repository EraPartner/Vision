/**
 * Property test: split.amount == sum(payments) + outstanding (Phase 8).
 *
 * Invariant from plan: `split.amount == sum(payments) + outstanding` within
 * cent tolerance. computeSplitRemaining + amount_paid defines the outstanding
 * side; validatePaymentAmount prevents overpayment.
 */

import { describe, it, expect } from "vitest";
import {
  __computeSplitRemaining as computeSplitRemaining,
  computeOwedSummary,
  validatePaymentAmount,
  roundToCents,
} from "../../src/lib/calculations/splits.js";

const CENT = 0.01;

function seeded(seed) {
  let t = seed >>> 0;
  return function next() {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSplitWithPayments(rng) {
  const amount = roundToCents(10 + rng() * 990);
  const paymentCount = Math.floor(rng() * 6);
  const payments = [];
  let remaining = amount;
  for (let i = 0; i < paymentCount && remaining > 0.01; i++) {
    const pay = roundToCents(Math.min(remaining, rng() * remaining));
    if (pay <= 0) break;
    payments.push(pay);
    remaining = roundToCents(remaining - pay);
  }
  const amount_paid = roundToCents(payments.reduce((a, b) => a + b, 0));
  return { amount, amount_paid, payments };
}

describe("property: split conservation law", () => {
  it("split.amount == sum(payments) + remaining across 500 random splits", () => {
    const rng = seeded(0xc0de600d);
    for (let i = 0; i < 500; i++) {
      const split = buildSplitWithPayments(rng);
      const remaining = computeSplitRemaining(split);
      const sumPayments = split.payments.reduce((a, b) => a + b, 0);
      const reconstructed = roundToCents(sumPayments + remaining);
      expect(Math.abs(reconstructed - split.amount)).toBeLessThanOrEqual(CENT);
    }
  });

  it("validatePaymentAmount blocks any payment that would exceed split", () => {
    const rng = seeded(0xbeefcafe);
    for (let i = 0; i < 200; i++) {
      const splitAmount = roundToCents(10 + rng() * 990);
      const alreadyPaid = roundToCents(rng() * splitAmount);
      const headroom = roundToCents(splitAmount - alreadyPaid);
      const overpay = roundToCents(headroom + 1 + rng() * 50);
      const result = validatePaymentAmount({
        paymentAmount: overpay,
        splitAmount,
        alreadyPaid,
      });
      expect(result.ok).toBe(false);
    }
  });

  it("validatePaymentAmount permits payment up to exact headroom", () => {
    const rng = seeded(0x1badb002);
    for (let i = 0; i < 200; i++) {
      const splitAmount = roundToCents(10 + rng() * 990);
      const alreadyPaid = roundToCents(rng() * splitAmount);
      const headroom = roundToCents(splitAmount - alreadyPaid);
      if (headroom <= 0) continue;
      const payment = roundToCents(headroom * rng());
      if (payment <= 0) continue;
      const result = validatePaymentAmount({
        paymentAmount: payment,
        splitAmount,
        alreadyPaid,
      });
      expect(result.ok).toBe(true);
    }
  });

  it("computeOwedSummary: total_owed - total_paid == remaining for every row", () => {
    const rows = [
      {
        recipient_id: 1,
        recipient_name: "A",
        total_owed: "100.00",
        total_paid: "25.50",
        split_count: "3",
      },
      {
        recipient_id: 2,
        recipient_name: "B",
        total_owed: "500.00",
        total_paid: "500.00",
        split_count: "5",
      },
      {
        recipient_id: 3,
        recipient_name: "C",
        total_owed: "42.42",
        total_paid: "0.00",
        split_count: "1",
      },
    ];
    const summary = computeOwedSummary(rows);
    for (const row of summary) {
      expect(row.remaining).toBe(roundToCents(row.total_owed - row.total_paid));
    }
    // Fully settled row (B) dropped
    expect(summary.find((r) => r.recipient_id === 2)).toBeUndefined();
  });
});
