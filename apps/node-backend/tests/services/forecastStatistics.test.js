import { describe, expect, it } from 'vitest';
import { quantile } from '../../src/services/calculations/forecast/_statistics.js';

describe('forecast quantile', () => {
  it('returns zero for an empty sample', () => {
    expect(quantile([], 50)).toBe(0);
  });

  it('returns the exact indexed value', () => {
    expect(quantile([1, 2, 3], 50)).toBe(2);
  });

  it('interpolates between adjacent values', () => {
    expect(quantile([0, 10, 20, 30], 25)).toBe(7.5);
  });
});
