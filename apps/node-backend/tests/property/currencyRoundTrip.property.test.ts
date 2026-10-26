/**
 * Property test: convert(convert(x, A, B), B, A) ≈ x (Phase 8).
 *
 * Invariant from plan: currency conversion round-trip must return the input
 * amount within rounding tolerance. Property locks the symmetric behaviour of
 * `convertToCurrency` against silent rate-map corruption or sign drift.
 *
 * We drive the conversion through a fixed table of stored latest rates
 * (mocking the DB rows and failing fetch) so the test is deterministic and
 * offline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockLogger } from "../helpers/mockLogger.ts";
import { mockConnection } from "../helpers/repoMocks.ts";

// Latest stored rates (rate_to_eur per unit), as `exchange_rates` returns them.
const STORED_RATES: Record<string, string> = {
  USD: "0.9174311927",
  GBP: "1.1764705882",
  CHF: "1.0526315789",
  JPY: "0.0061349693",
  SEK: "0.0892857143",
  HUF: "0.0025316456",
  IDR: "0.0000568182",
  KWD: "2.9850746269",
  SAR: "0.2444987775",
};

vi.mock("../../src/database/connection.ts", () =>
  mockConnection({
    query: vi.fn((sql: string) =>
      Promise.resolve(/"?is_latest"? =/.test(sql)
        ? {
            rows: Object.entries(STORED_RATES).map(
              ([currency_code, rate_to_eur]) => ({
                currency_code,
                rate_to_eur,
              }),
            ),
          }
        : { rows: [] }),
    ),
  }),
);
vi.mock("../../src/config/logger.ts", () => ({
  logger: mockLogger(),
}));

const { convertToCurrency, clearMemoryCache } =
  await import("../../src/services/currency/currencyConversionService.ts");

const originalFetch = global.fetch as typeof fetch | undefined;
const EPSILON_RATIO = 1e-9; // 1 part per billion

function seeded(seed: number) {
  let t = seed >>> 0;
  return function next() {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property: currency round-trip identity", () => {
  beforeEach(() => {
    clearMemoryCache();
    // Force fetch failure so the stored rates are used deterministically
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("offline-for-property-test"));
  });

  afterEach(() => {
    if (originalFetch) global.fetch = originalFetch;
    else delete (global as { fetch?: typeof fetch }).fetch;
  });

  const CURRENCIES = ["EUR", ...Object.keys(STORED_RATES)];

  /** Every currency here has a stored rate, so conversion always succeeds. */
  async function convert(
    amount: number,
    from: string | undefined,
    to: string | undefined,
  ) {
    const value = await convertToCurrency(amount, from, to);
    if (value === undefined) throw new Error(`no rate for ${from}→${to}`);
    return value;
  }

  it("convert(convert(x, A, B), B, A) ≈ x across 200 random (x, A, B) triples", async () => {
    const rng = seeded(0xface0ff);
    for (let i = 0; i < 200; i++) {
      const from = CURRENCIES[Math.floor(rng() * CURRENCIES.length)];
      const to = CURRENCIES[Math.floor(rng() * CURRENCIES.length)];
      const amount = 1 + rng() * 10000;
      const forward = await convert(amount, from, to);
      const back = await convert(forward, to, from);
      const ratio = Math.abs(back - amount) / amount;
      expect(
        ratio,
        `round-trip ${amount} ${from}→${to}→${from} got ${back}`,
      ).toBeLessThan(EPSILON_RATIO);
    }
  });

  it("EUR→EUR identity returns input unchanged for arbitrary x", async () => {
    const rng = seeded(0xfee1dead);
    for (let i = 0; i < 50; i++) {
      const amount = rng() * 1e6;
      const result = await convertToCurrency(amount, "EUR", "EUR");
      expect(result).toBe(amount);
    }
  });

  it("cross-currency triangulation: A→B→C == A→C within ratio tolerance", async () => {
    const rng = seeded(0xdeaddead);
    for (let i = 0; i < 100; i++) {
      const a = CURRENCIES[Math.floor(rng() * CURRENCIES.length)];
      const b = CURRENCIES[Math.floor(rng() * CURRENCIES.length)];
      const c = CURRENCIES[Math.floor(rng() * CURRENCIES.length)];
      if (a === b || b === c) continue;
      const amount = 1 + rng() * 5000;
      const viaB = await convert(await convert(amount, a, b), b, c);
      const direct = await convert(amount, a, c);
      if (direct === 0) continue;
      const ratio = Math.abs(viaB - direct) / Math.abs(direct);
      expect(ratio).toBeLessThan(EPSILON_RATIO);
    }
  });
});
