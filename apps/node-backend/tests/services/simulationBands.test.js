import { describe, expect, it } from "vitest";

import { summarizeSimulationPaths } from "../../src/services/calculations/forecast/simulationBands.js";

describe("summarizeSimulationPaths", () => {
  it("takes cumulative quantiles across whole paths instead of summing daily quantiles", () => {
    const result = summarizeSimulationPaths(
      [
        [0, 100],
        [100, 0],
      ],
      ["2026-07-01", "2026-07-02"],
      [10, 50, 90],
    );

    expect(result.bands.p10.map((point) => point.value)).toEqual([10, 10]);
    expect(result.cumulative_bands.p10.map((point) => point.value)).toEqual([
      10, 100,
    ]);
    expect(result.cumulative_bands.p50.at(-1).value).toBe(100);
    expect(result.cumulative_bands.p90.at(-1).value).toBe(100);
  });
});
