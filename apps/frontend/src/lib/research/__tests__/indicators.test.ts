import { describe, it, expect } from "vitest";
import { sma, ema, bollinger, rsi, macd, rebase } from "@/lib/research/indicators";

describe("indicators", () => {
  it("sma nulls the warm-up then averages the window", () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out).toEqual([null, null, 2, 3, 4]);
  });

  it("ema seeds with the SMA and is null before the period", () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(2, 6); // seed = SMA(1,2,3)
    expect(out[3]).toBeCloseTo(3, 6); // 4*0.5 + 2*0.5
    expect(out[4]).toBeCloseTo(4, 6);
  });

  it("bollinger bands straddle the middle band", () => {
    const values = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i));
    const { middle, upper, lower } = bollinger(values, 20, 2);
    const i = 24;
    expect(middle[i]).not.toBeNull();
    expect(upper[i]! > middle[i]!).toBe(true);
    expect(lower[i]! < middle[i]!).toBe(true);
  });

  it("rsi is 100 for a monotonically rising series", () => {
    const out = rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14);
    expect(out[14]).toBeCloseTo(100, 6);
  });

  it("rsi stays within 0..100", () => {
    const values = Array.from({ length: 50 }, (_, i) => 50 + 10 * Math.sin(i / 2));
    for (const v of rsi(values)) {
      if (v != null) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("macd produces aligned macd/signal/histogram arrays", () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + i + 5 * Math.sin(i / 3));
    const { macd: line, signal, histogram } = macd(values);
    expect(line).toHaveLength(60);
    expect(signal).toHaveLength(60);
    const i = 59;
    expect(histogram[i]).toBeCloseTo((line[i] as number) - (signal[i] as number), 6);
  });

  it("rebase starts the first valid point at 100", () => {
    const out = rebase([50, 75, 100]);
    expect(out[0]).toBe(100);
    expect(out[1]).toBe(150);
    expect(out[2]).toBe(200);
  });
});
