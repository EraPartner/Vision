import { describe, expect, test } from "vitest";
import { mergeForView } from "@/utils/forecastMerge";
import type { CashflowForecastMethodsData, ForecastMethod } from "@/lib/api/aggregations";

function baseData(methods: ForecastMethod[]): CashflowForecastMethodsData {
  return {
    month: "2026-01",
    currency: "EUR",
    days_in_month: 31,
    current_day: 2,
    actual: [
      { date: "2026-01-01", net: 10, cumulative: 10 },
      { date: "2026-01-02", net: 20, cumulative: 30 },
      { date: "2026-01-03", net: null, cumulative: null },
    ],
    methods,
    planned: [],
    diagnostics: null,
    history_months: 6,
    include_planned: false,
  };
}

const simpleMethod: ForecastMethod = {
  id: "simple_avg",
  label: "Simple Average",
  daily: [{ date: "2026-01-03", value: 15 }],
  cumulative: [{ date: "2026-01-03", value: 45 }],
  bands: null,
  error: null,
};

describe("mergeForView", () => {
  test("cumulative view fills actual cumulative and method values", () => {
    const visible = new Set(["simple_avg"]);
    const { rows, series } = mergeForView(
      baseData([simpleMethod]),
      "cumulative",
      visible,
      "Actual",
    );

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ date: "2026-01-01", dayNum: 1, actual: 10 });
    expect(rows[2].actual).toBeNull();
    expect(rows[2].simple_avg).toBe(45);

    // Series always starts with the actual line, then visible methods.
    expect(series[0].key).toBe("actual");
    expect(series.map((s) => s.key)).toContain("simple_avg");
  });

  test("daily view uses net values and daily method values", () => {
    const visible = new Set(["simple_avg"]);
    const { rows } = mergeForView(baseData([simpleMethod]), "daily", visible, "Actual");
    expect(rows[0].actual).toBe(10);
    expect(rows[1].actual).toBe(20);
    expect(rows[2].simple_avg).toBe(15);
  });

  test("hidden methods are not added to rows or series", () => {
    const { rows, series } = mergeForView(
      baseData([simpleMethod]),
      "cumulative",
      new Set<string>(),
      "Actual",
    );
    expect(rows[2].simple_avg).toBeUndefined();
    expect(series.map((s) => s.key)).toEqual(["actual"]);
  });

  test("methods with bands emit cumulative pLo/pHi keys and band series", () => {
    const banded: ForecastMethod = {
      ...simpleMethod,
      id: "ewma",
      label: "EWMA",
      bands: {
        p25: [{ date: "2026-01-03", value: 5 }],
        p75: [{ date: "2026-01-03", value: 25 }],
      },
    };
    const { rows, series } = mergeForView(
      baseData([banded]),
      "cumulative",
      new Set(["ewma"]),
      "Actual",
    );
    // Bands accumulate on top of last actual cumulative (30).
    expect(rows[2].ewma__pLo).toBe(35);
    expect(rows[2].ewma__pHi).toBe(55);
    const keys = series.map((s) => s.key);
    expect(keys).toContain("ewma__pLo");
    expect(keys).toContain("ewma__pHi");
  });
});
