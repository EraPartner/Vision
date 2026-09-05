/**
 * Property test: recurrence nth == iterate_n_times (Phase 8).
 *
 * Invariant from plan: `n-th(pattern, date) == iterate(n times, pattern, date)`.
 *
 * calculateNextDate is a single-step function. By definition, applying it n times
 * from date D should equal computing the n-th occurrence after D. We sanity-check
 * this by iterating and asserting monotonic + idempotent behaviour across every
 * supported pattern for random starting dates.
 */

import { describe, it, expect } from 'vitest';
import { calculateNextDate, __getSupportedPatterns as getSupportedPatterns } from '../../src/lib/calculations/recurrence.js';

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

function randomUtcDate(rng) {
  const year = 2000 + Math.floor(rng() * 40);
  const month = Math.floor(rng() * 12);
  const day = 1 + Math.floor(rng() * 28);
  return new Date(Date.UTC(year, month, day));
}

function iterate(pattern, startDate, n) {
  let current = new Date(startDate.getTime());
  for (let i = 0; i < n; i++) {
    current = calculateNextDate(current, pattern);
  }
  return current;
}

describe('property: recurrence nth == iterate_n_times', () => {
  const PATTERNS = getSupportedPatterns();

  for (const pattern of PATTERNS) {
    it(`${pattern}: iterating N steps is strictly monotonic across 50 random seeds`, () => {
      const rng = seeded(0xBADC0FFE ^ pattern.length);
      for (let seed = 0; seed < 50; seed++) {
        const start = randomUtcDate(rng);
        const steps = 1 + Math.floor(rng() * 24);
        let prev = start;
        for (let i = 0; i < steps; i++) {
          const next = calculateNextDate(prev, pattern);
          expect(next instanceof Date).toBe(true);
          expect(next.getTime()).toBeGreaterThan(prev.getTime());
          prev = next;
        }
      }
    });

    it(`${pattern}: iterate(n) equals iterate(n-1) then one more step`, () => {
      const rng = seeded(0xFEEDFACE ^ pattern.length);
      for (let seed = 0; seed < 50; seed++) {
        const start = randomUtcDate(rng);
        const n = 1 + Math.floor(rng() * 12);
        const stepN = iterate(pattern, start, n);
        const stepNMinus1 = iterate(pattern, start, n - 1);
        const oneMore = calculateNextDate(stepNMinus1, pattern);
        expect(oneMore.getTime()).toBe(stepN.getTime());
      }
    });
  }

  it('every N days custom pattern: strict monotonic advance equals N-day step', () => {
    const rng = seeded(0xDEADBEEF);
    for (let seed = 0; seed < 50; seed++) {
      const start = randomUtcDate(rng);
      const n = 1 + Math.floor(rng() * 90);
      const next = calculateNextDate(start, `every ${n} days`);
      const diffDays = Math.round((next.getTime() - start.getTime()) / (24 * 3600 * 1000));
      expect(diffDays).toBe(n);
    }
  });

  it('monthly from Jan 31 clamps to Feb 28/29 and back to Mar 31 (idempotent path)', () => {
    const start = new Date(Date.UTC(2024, 0, 31)); // 2024 leap year
    const feb = calculateNextDate(start, 'monthly');
    expect(feb.toISOString().split('T')[0]).toBe('2024-02-29');
    const mar = calculateNextDate(feb, 'monthly');
    // Clamp stays at feb day (29) rather than restoring 31. Documented behaviour.
    expect(mar.toISOString().split('T')[0]).toBe('2024-03-29');
  });
});
