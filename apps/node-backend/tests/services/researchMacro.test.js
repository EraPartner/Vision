/**
 * Macro vertical tests (ADR-082): pure helpers (range/period, catalog, JSON-stat)
 * and the aggregator's provider-pinned macro orchestration. All deps are injected
 * fakes — no network, no DB.
 */

import { describe, expect, it, vi } from "vitest";
import { __createResearchAggregator as createResearchAggregator } from "../../src/services/research/researchAggregator.js";
import { createResearchCache } from "../../src/services/research/researchCache.js";
import {
  trimToRange,
  periodToMs,
} from "../../src/services/research/adapters/macroRange.js";
import {
  searchCatalog,
  isValidSeriesId,
  MACRO_CATALOG,
} from "../../src/services/research/adapters/macroCatalog.js";
import { __parseJsonStat as parseJsonStat } from "../../src/services/research/adapters/eurostatAdapter.js";

const monthly = (n, lastY, lastM) => {
  // n ascending monthly points ending at lastY-lastM (1-based month).
  const pts = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    pts.push({ time: Date.UTC(lastY, lastM - 1 - i, 1), close: 100 + i });
  }
  return pts;
};

describe("macroRange", () => {
  it("periodToMs parses year / month / quarter / day forms", () => {
    expect(periodToMs("2020")).toBe(Date.UTC(2020, 0, 1));
    expect(periodToMs("2020-03")).toBe(Date.UTC(2020, 2, 1));
    expect(periodToMs("2020-Q2")).toBe(Date.UTC(2020, 3, 1));
    expect(periodToMs("2020-03-15")).toBe(Date.UTC(2020, 2, 15));
    expect(periodToMs("garbage")).toBeUndefined();
  });

  it("trimToRange anchors on the LAST point, not the wall clock", () => {
    // Series of 24 monthly points whose latest is years in the past.
    const pts = monthly(24, 2021, 12);
    const out = trimToRange(pts, "6mo");
    // 6 months back from 2021-12 is 2021-06 → keeps Jun..Dec = 7 points.
    expect(out.length).toBe(7);
    expect(out[0].time).toBe(Date.UTC(2021, 5, 1));
    expect(out.at(-1).time).toBe(Date.UTC(2021, 11, 1));
  });

  it("trimToRange keeps everything for max / empty", () => {
    const pts = monthly(5, 2021, 12);
    expect(trimToRange(pts, "max")).toHaveLength(5);
    expect(trimToRange([], "1y")).toHaveLength(0);
  });
});

describe("macroCatalog", () => {
  it("searchCatalog AND-matches terms over title/region/keywords", () => {
    expect(
      searchCatalog("eurostat", "belgium inflation").map((i) => i.region),
    ).toEqual(["BE"]);
    expect(
      searchCatalog("eurostat", "unemployment").length,
    ).toBeGreaterThanOrEqual(2);
    expect(searchCatalog("eurostat", "")).toEqual([]);
    expect(searchCatalog("fred", "inflation")).toEqual([]); // FRED has no catalog entries
  });

  it("every catalog entry carries a source label and valid id shape", () => {
    for (const e of MACRO_CATALOG) {
      expect(isValidSeriesId(e.provider, e.seriesId)).toBe(true);
    }
  });

  it("isValidSeriesId enforces per-provider shapes", () => {
    expect(isValidSeriesId("fred", "CPIAUCSL")).toBe(true);
    expect(isValidSeriesId("fred", "a/b/c")).toBe(false);
    expect(isValidSeriesId("dbnomics", "ECB/FM/M.U2.X")).toBe(true);
    expect(isValidSeriesId("dbnomics", "CPIAUCSL")).toBe(false);
    expect(
      isValidSeriesId("eurostat", "prc_hicp_midx?geo=BE&coicop=CP00&unit=I15"),
    ).toBe(true);
    expect(isValidSeriesId("eurostat", "prc_hicp_midx")).toBe(false);
    expect(isValidSeriesId("unknown", "x")).toBe(false);
  });
});

describe("eurostat parseJsonStat", () => {
  it("zips the time index with values, skips missing, and sorts ascending", () => {
    const payload = {
      dimension: {
        time: {
          category: { index: { "2020-02": 1, "2020-01": 0, "2020-03": 2 } },
        },
      },
      value: { 0: 100, 1: 101.5, 2: null }, // index 2 missing → dropped
    };
    const out = parseJsonStat(payload);
    expect(out.map((p) => p.period)).toEqual(["2020-01", "2020-02"]);
    expect(out[1].value).toBe(101.5);
    expect(out[0].time).toBeLessThan(out[1].time);
  });

  it("returns [] for a malformed payload", () => {
    expect(parseJsonStat({})).toEqual([]);
    expect(parseJsonStat(undefined)).toEqual([]);
    expect(
      parseJsonStat({
        dimension: { time: { category: { index: "junk" } } },
        value: {},
      }),
    ).toEqual([]);
    expect(
      parseJsonStat({
        dimension: { time: { category: { index: {} } } },
        value: "junk",
      }),
    ).toEqual([]);
  });

  // ZOD-12 pin: JSON-stat also allows the dense array form for `value`.
  it("supports value as a dense array", () => {
    const payload = {
      dimension: {
        time: { category: { index: { "2020-01": 0, "2020-02": 1 } } },
      },
      value: [100, "garbage"], // non-numeric entry -> dropped
    };
    const out = parseJsonStat(payload);
    expect(out).toEqual([
      { period: "2020-01", time: Date.UTC(2020, 0, 1), value: 100 },
    ]);
  });
});

// ── Aggregator macro orchestration ──────────────────────────────────────────

const makeGovernor = (canSpend = () => true) => ({
  canSpend: vi.fn(async (p) => canSpend(p)),
  spend: vi.fn(async () => {}),
});

const build = (deps) =>
  createResearchAggregator({
    cache: createResearchCache(),
    isKeyed: () => true,
    recordSuccess: vi.fn(),
    recordError: vi.fn(),
    ...deps,
  });

const macroAdapters = (over = {}) => ({
  fred: {
    macroSearch: vi.fn(async () => ({
      items: [{ provider: "fred", seriesId: "CPIAUCSL", title: "US CPI" }],
    })),
    macroSeries: vi.fn(async () => ({
      provider: "fred",
      seriesId: "CPIAUCSL",
      points: [{ time: 1, close: 1 }],
    })),
  },
  eurostat: {
    macroSearch: vi.fn(async () => ({
      items: [{ provider: "eurostat", seriesId: "x?geo=BE", title: "BE HICP" }],
    })),
    macroSeries: vi.fn(async () => ({
      provider: "eurostat",
      seriesId: "x?geo=BE",
      points: [{ time: 2, close: 2 }],
    })),
  },
  dbnomics: {
    macroSearch: vi.fn(async () => ({ items: [] })),
    macroSeries: vi.fn(async () => ({
      provider: "dbnomics",
      seriesId: "A/B/C",
      points: [],
    })),
  },
  ...over,
});

describe("researchAggregator.searchMacro", () => {
  it("unions items across all usable macro providers", async () => {
    const adapters = macroAdapters();
    const agg = build({ adapters, governor: makeGovernor() });
    const out = await agg.searchMacro("cpi");
    expect(out.source).toBe("live");
    expect(out.items.map((i) => i.provider).sort()).toEqual([
      "eurostat",
      "fred",
    ]);
  });

  it("excludes providers without a key (e.g. no FRED key)", async () => {
    const adapters = macroAdapters();
    const agg = build({
      adapters,
      governor: makeGovernor(),
      isKeyed: (p) => p !== "fred",
    });
    const out = await agg.searchMacro("cpi");
    expect(out.items.map((i) => i.provider)).toEqual(["eurostat"]);
    expect(adapters.fred.macroSearch).not.toHaveBeenCalled();
  });

  it("serves the second identical search from cache", async () => {
    const adapters = macroAdapters();
    const agg = build({ adapters, governor: makeGovernor() });
    await agg.searchMacro("cpi");
    const second = await agg.searchMacro("cpi");
    expect(second.source).toBe("cache");
    expect(adapters.eurostat.macroSearch).toHaveBeenCalledTimes(1);
  });
});

describe("researchAggregator.fetchMacroSeries", () => {
  it("routes to exactly the named provider (no fallback) and caches", async () => {
    const adapters = macroAdapters();
    const governor = makeGovernor();
    const agg = build({ adapters, governor });
    const out = await agg.fetchMacroSeries({
      provider: "eurostat",
      seriesId: "x?geo=BE",
      range: "1y",
    });
    expect(out.source).toBe("live");
    expect(out.provider).toBe("eurostat");
    expect(out.data.points).toEqual([{ time: 2, close: 2 }]);
    expect(adapters.eurostat.macroSeries).toHaveBeenCalledWith("x?geo=BE", {
      range: "1y",
    });
    expect(adapters.fred.macroSeries).not.toHaveBeenCalled();

    const cached = await agg.fetchMacroSeries({
      provider: "eurostat",
      seriesId: "x?geo=BE",
      range: "1y",
    });
    expect(cached.source).toBe("cache");
    expect(adapters.eurostat.macroSeries).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable (no_key) when the provider is unkeyed", async () => {
    const agg = build({
      adapters: macroAdapters(),
      governor: makeGovernor(),
      isKeyed: () => false,
    });
    const out = await agg.fetchMacroSeries({
      provider: "fred",
      seriesId: "CPIAUCSL",
      range: "1y",
    });
    expect(out.source).toBe("unavailable");
    expect(out.attempted[0]).toMatchObject({
      provider: "fred",
      skipped: "no_key",
    });
  });

  it("reports unavailable (quota) when the governor blocks the spend", async () => {
    const agg = build({
      adapters: macroAdapters(),
      governor: makeGovernor(() => false),
    });
    const out = await agg.fetchMacroSeries({
      provider: "fred",
      seriesId: "CPIAUCSL",
      range: "1y",
    });
    expect(out.source).toBe("unavailable");
    expect(out.attempted[0]).toMatchObject({
      provider: "fred",
      skipped: "quota",
    });
  });

  it("reports unavailable with the error message when the adapter throws", async () => {
    const adapters = macroAdapters({
      eurostat: {
        macroSeries: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });
    const agg = build({ adapters, governor: makeGovernor() });
    const out = await agg.fetchMacroSeries({
      provider: "eurostat",
      seriesId: "x?geo=BE",
      range: "1y",
    });
    expect(out.source).toBe("unavailable");
    expect(out.attempted[0]).toMatchObject({
      provider: "eurostat",
      error: "boom",
    });
  });
});
