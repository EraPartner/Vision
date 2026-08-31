import { describe, expect, it } from "vitest";
import { CHART_RANGE_KEYS, makeChartRangeMap } from "@vision/types/chartRanges";

describe("chart range vocabulary", () => {
  it("builds provider maps in the canonical order", () => {
    const map = makeChartRangeMap(
      CHART_RANGE_KEYS.map((key) => `value:${key}`),
    );

    expect(Object.keys(map)).toEqual(CHART_RANGE_KEYS);
    expect(map["1mo"]).toBe("value:1mo");
    expect(map.max).toBe("value:max");
  });

  it("rejects incomplete provider maps", () => {
    expect(() => makeChartRangeMap([1, 2])).toThrow(
      `Expected ${CHART_RANGE_KEYS.length} chart-range values, received 2`,
    );
  });
});
