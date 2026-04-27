import { describe, it, expect } from 'vitest';
import { sanitizeKinesisIsolatedSpikes } from '../src/services/prices/priceProviderRegistry.js';

function pts(...prices) {
  return prices.map((price, i) => ({ timestampMs: i * 3_600_000, price }));
}

describe('sanitizeKinesisIsolatedSpikes', () => {
  describe('stale run removal', () => {
    it('removes a stale run of 8+ identical prices, keeping first point', () => {
      const stalePrice = 114.30;
      const before = pts(100, 101);
      const stale = Array.from({ length: 10 }, () => stalePrice);
      const after = [102, 103];
      const input = pts(...[...before.map(p => p.price), ...stale, ...after.map(p => p.price)]);

      const result = sanitizeKinesisIsolatedSpikes(input);

      const stalePrices = result.filter(p => p.price === stalePrice);
      expect(stalePrices).toHaveLength(1);
      expect(result.length).toBe(5);
    });

    it('keeps a short run of 7 identical prices (below threshold)', () => {
      const price = 100;
      const input = pts(99, price, price, price, price, price, price, price, 101);

      const result = sanitizeKinesisIsolatedSpikes(input);

      const matching = result.filter(p => p.price === price);
      expect(matching).toHaveLength(7);
    });

    it('handles two separate stale runs in one series', () => {
      const stale1 = Array(8).fill(50);
      const stale2 = Array(9).fill(75);
      const input = pts(48, ...stale1, 52, 74, ...stale2, 77);

      const result = sanitizeKinesisIsolatedSpikes(input);

      expect(result.filter(p => p.price === 50)).toHaveLength(1);
      expect(result.filter(p => p.price === 75)).toHaveLength(1);
    });
  });

  describe('edge-point sanitization', () => {
    it('replaces first-point anomaly below threshold (half-price artifact)', () => {
      // Jan 1 artifact: first point at ~50% of real price
      const input = pts(46.31, 92.60, 92.40, 92.80, 92.50, 92.70);

      const result = sanitizeKinesisIsolatedSpikes(input);

      expect(result[0].price).toBeCloseTo(92.60, 2);
    });

    it('replaces first-point anomaly above threshold (2x spike)', () => {
      const input = pts(200, 99, 100, 101, 100, 99);

      const result = sanitizeKinesisIsolatedSpikes(input);

      expect(result[0].price).toBeCloseTo(99, 2);
    });

    it('replaces last-point anomaly below threshold', () => {
      const input = pts(92.60, 92.40, 92.80, 92.50, 92.70, 46.31);

      const result = sanitizeKinesisIsolatedSpikes(input);

      expect(result[result.length - 1].price).toBeCloseTo(92.70, 2);
    });

    it('replaces last-point anomaly above threshold', () => {
      const input = pts(99, 100, 101, 100, 99, 200);

      const result = sanitizeKinesisIsolatedSpikes(input);

      expect(result[result.length - 1].price).toBeCloseTo(99, 2);
    });

    it('leaves normal first and last points untouched', () => {
      const input = pts(100, 101, 102, 101, 100);

      const result = sanitizeKinesisIsolatedSpikes(input);

      expect(result[0].price).toBeCloseTo(100, 4);
      expect(result[result.length - 1].price).toBeCloseTo(100, 4);
    });
  });

  describe('combined scenarios', () => {
    it('handles stale run + edge anomaly in same series', () => {
      const stale = Array(8).fill(114.30);
      // First point is half-price artifact, followed by stale run, then normal
      const input = pts(46.31, ...stale, 92.60, 92.40, 92.80);

      const result = sanitizeKinesisIsolatedSpikes(input);

      // Stale run of 8 is collapsed — at most 2 copies of stale price remain
      // (the kept anchor + the edge-corrected first point that snaps to it)
      expect(result.filter(p => p.price === 114.30).length).toBeLessThanOrEqual(2);
      // The artifact value must be gone entirely
      expect(result.some(p => Math.abs(p.price - 46.31) < 0.01)).toBe(false);
      // Total length is much shorter than the original 12 points
      expect(result.length).toBeLessThan(input.length - 5);
    });

    it('returns empty array for empty input', () => {
      expect(sanitizeKinesisIsolatedSpikes([])).toEqual([]);
    });

    it('returns single-point array unchanged', () => {
      const input = pts(100);
      expect(sanitizeKinesisIsolatedSpikes(input)).toEqual(input);
    });

    it('processes two-point input without crashing', () => {
      const input = pts(100, 101);
      const result = sanitizeKinesisIsolatedSpikes(input);
      expect(result).toHaveLength(2);
    });

    it('middle spike still detected after edge fixes and stale removal', () => {
      // Normal series with a spike in the middle
      const input = pts(100, 101, 1200, 102, 101, 100, 99, 100);

      const result = sanitizeKinesisIsolatedSpikes(input);

      const spikePoint = result.find(p => p.timestampMs === 2 * 3_600_000);
      expect(spikePoint?.price).toBeLessThan(200);
    });
  });

  describe('preserves immutability', () => {
    it('does not mutate the input array', () => {
      const input = pts(46.31, 92.60, 92.40, 92.80, 92.50);
      const originalFirst = input[0].price;

      sanitizeKinesisIsolatedSpikes(input);

      expect(input[0].price).toBe(originalFirst);
    });
  });
});
