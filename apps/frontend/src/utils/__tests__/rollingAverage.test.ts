// @vitest-environment node
import { describe, expect, it } from "vitest";
import { computeRollingAverage } from "@/utils/rollingAverage";

describe("computeRollingAverage", () => {
  it("returns a copy of the series unchanged when window <= 1", () => {
    expect(computeRollingAverage([1, 2, 3], 1)).toEqual([1, 2, 3]);
    expect(computeRollingAverage([4, 5], 0)).toEqual([4, 5]);
  });

  it("nulls the first (window - 1) entries then averages the window", () => {
    const result = computeRollingAverage([2, 4, 6, 8], 2);
    expect(result).toEqual([null, 3, 5, 7]);
  });

  it("computes a 3-period moving average", () => {
    const result = computeRollingAverage([3, 6, 9, 12, 15], 3);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).toBeCloseTo(6, 5);
    expect(result[3]).toBeCloseTo(9, 5);
    expect(result[4]).toBeCloseTo(12, 5);
  });

  it("returns all nulls when the window exceeds the series length", () => {
    expect(computeRollingAverage([1, 2], 5)).toEqual([null, null]);
  });

  it("returns an empty array for an empty series", () => {
    expect(computeRollingAverage([], 3)).toEqual([]);
  });
});
