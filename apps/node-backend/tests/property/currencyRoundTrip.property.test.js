/**
 * Property test: convert(convert(x, A, B), B, A) ≈ x (Phase 8).
 *
 * Invariant from plan: currency conversion round-trip must return the input
 * amount within rounding tolerance. Property locks the symmetric behaviour of
 * `convertToCurrency` against silent rate-map corruption or sign drift.
 *
 * We drive the conversion through the FALLBACK_RATES path (mocking the DB +
 * fetch to empty) so the test is deterministic and offline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
}));
vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const {
  convertToCurrency,
  clearMemoryCache,
  FALLBACK_RATES,
} = await import('../../src/services/currency/currencyConversionService.js');

const originalFetch = global.fetch;
const EPSILON_RATIO = 1e-9; // 1 part per billion

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

describe('property: currency round-trip identity', () => {
  beforeEach(() => {
    clearMemoryCache();
    // Force fetch failure so FALLBACK_RATES is used deterministically
    global.fetch = vi.fn().mockRejectedValue(new Error('offline-for-property-test'));
  });

  afterEach(() => {
    if (originalFetch) global.fetch = originalFetch;
    else delete global.fetch;
  });

  const CURRENCIES = Object.keys(FALLBACK_RATES).filter((c) => FALLBACK_RATES[c] > 0);

  it('convert(convert(x, A, B), B, A) ≈ x across 200 random (x, A, B) triples', async () => {
    const rng = seeded(0xFACE0FF);
    for (let i = 0; i < 200; i++) {
      const from = CURRENCIES[Math.floor(rng() * CURRENCIES.length)];
      const to = CURRENCIES[Math.floor(rng() * CURRENCIES.length)];
      const amount = 1 + rng() * 10000;
      const forward = await convertToCurrency(amount, from, to);
      const back = await convertToCurrency(forward, to, from);
      const ratio = Math.abs(back - amount) / amount;
      expect(ratio, `round-trip ${amount} ${from}→${to}→${from} got ${back}`).toBeLessThan(EPSILON_RATIO);
    }
  });

  it('EUR→EUR identity returns input unchanged for arbitrary x', async () => {
    const rng = seeded(0xFEE1DEAD);
    for (let i = 0; i < 50; i++) {
      const amount = rng() * 1e6;
      const result = await convertToCurrency(amount, 'EUR', 'EUR');
      expect(result).toBe(amount);
    }
  });

  it('cross-currency triangulation: A→B→C == A→C within ratio tolerance', async () => {
    const rng = seeded(0xDEADDEAD);
    for (let i = 0; i < 100; i++) {
      const a = CURRENCIES[Math.floor(rng() * CURRENCIES.length)];
      const b = CURRENCIES[Math.floor(rng() * CURRENCIES.length)];
      const c = CURRENCIES[Math.floor(rng() * CURRENCIES.length)];
      if (a === b || b === c) continue;
      const amount = 1 + rng() * 5000;
      const viaB = await convertToCurrency(
        await convertToCurrency(amount, a, b),
        b,
        c,
      );
      const direct = await convertToCurrency(amount, a, c);
      if (direct === 0) continue;
      const ratio = Math.abs(viaB - direct) / Math.abs(direct);
      expect(ratio).toBeLessThan(EPSILON_RATIO);
    }
  });
});
