import { describe, it, expect } from 'vitest';
import { downsampleLTTB } from '../src/utils/downsample.js';

describe('downsampleLTTB', () => {
  it('returns original data when length <= threshold', () => {
    const data = [1, 2, 3];
    const result = downsampleLTTB(data, 5, (_item, i) => i, (item) => item);
    expect(result).toBe(data);
  });

  it('returns original data when threshold < 3', () => {
    const data = [1, 2, 3, 4, 5];
    const result = downsampleLTTB(data, 2, (_item, i) => i, (item) => item);
    expect(result).toBe(data);
  });

  it('always keeps first and last points', () => {
    const data = Array.from({ length: 100 }, (_, i) => ({ x: i, y: Math.sin(i / 10) }));
    const result = downsampleLTTB(data, 10, (item) => item.x, (item) => item.y);

    expect(result[0]).toBe(data[0]);
    expect(result[result.length - 1]).toBe(data[data.length - 1]);
  });

  it('returns exactly threshold number of points', () => {
    const data = Array.from({ length: 200 }, (_, i) => ({ x: i, y: i * 2 }));
    const result = downsampleLTTB(data, 20, (item) => item.x, (item) => item.y);

    expect(result).toHaveLength(20);
  });

  it('preserves visual shape — keeps peak and trough', () => {
    // Flat data with one big peak and one big trough
    const data = Array.from({ length: 50 }, (_, i) => {
      let y = 0;
      if (i === 15) y = 100;   // peak
      if (i === 35) y = -100;  // trough
      return { x: i, y };
    });

    const result = downsampleLTTB(data, 10, (item) => item.x, (item) => item.y);

    const ys = result.map(p => p.y);
    expect(ys).toContain(100);
    expect(ys).toContain(-100);
  });
});
