/**
 * Unit tests for the research aggregation foundation (ADR-079):
 *   1. capabilityMap — provider preference chains + usability filtering.
 *   2. quotaGovernor — per-minute + persisted per-day token buckets, with an
 *      injected clock and fake store (no DB, no real time).
 */

import { describe, expect, it } from "vitest";
import {
  PROVIDERS,
  __providerChain as providerChain,
  resolveProviderChain,
} from "../../src/services/research/capabilityMap.js";
import {
  createQuotaGovernor,
  __dayKeyUtc as dayKeyUtc,
  __PROVIDER_LIMITS as PROVIDER_LIMITS,
} from "../../src/services/research/quotaGovernor.js";

// ─── capabilityMap ─────────────────────────────────────────────────────────────

describe("capabilityMap", () => {
  it("returns the default chain for an asset class with no override", () => {
    expect(providerChain("quote", "stock")).toEqual([
      PROVIDERS.yahoo,
      PROVIDERS.twelveData,
      PROVIDERS.finnhub,
      PROVIDERS.fmp,
      PROVIDERS.alphaVantage,
    ]);
  });

  it("uses the crypto override for crypto quotes (binance first)", () => {
    expect(providerChain("quote", "crypto")[0]).toBe(PROVIDERS.binance);
  });

  it("uses the metals override for metals charts (kinesis first)", () => {
    expect(providerChain("chart", "metals")[0]).toBe(PROVIDERS.kinesis);
  });

  it("returns an empty array for an unknown data type", () => {
    expect(providerChain("nonsense", "stock")).toEqual([]);
  });

  it("returns a fresh array each call (no shared mutable state)", () => {
    const a = providerChain("news");
    a.push("mutated");
    expect(providerChain("news")).not.toContain("mutated");
  });

  it("filters the chain by isUsable (drops unkeyed/exhausted providers)", () => {
    const usable = new Set([PROVIDERS.yahoo, PROVIDERS.finnhub]);
    expect(
      resolveProviderChain("quote", "stock", {
        isUsable: (p) => usable.has(p),
      }),
    ).toEqual([PROVIDERS.yahoo, PROVIDERS.finnhub]);
  });
});

// ─── quotaGovernor ─────────────────────────────────────────────────────────────

const makeFakeStore = () => {
  const counts = new Map();
  const key = (p, dk) => `${p}:${dk}`;
  return {
    counts,
    async getDayCount(p, dk) {
      return counts.get(key(p, dk)) ?? 0;
    },
    async addDayCount(p, dk, delta) {
      counts.set(key(p, dk), (counts.get(key(p, dk)) ?? 0) + delta);
    },
  };
};

describe("quotaGovernor", () => {
  const BASE = Date.UTC(2026, 5, 16, 12, 0, 0); // 2026-06-16T12:00:00Z

  it("treats unmetered providers (yahoo) as always spendable and does not track them", async () => {
    const gov = createQuotaGovernor({ now: () => BASE });
    for (let i = 0; i < 100; i++) {
      expect(await gov.canSpend("yahoo")).toBe(true);
      await gov.spend("yahoo");
    }
    expect(gov.snapshot().minute.yahoo).toBeUndefined();
  });

  it("blocks once the per-minute limit is hit, then recovers after the window", async () => {
    let t = BASE;
    const gov = createQuotaGovernor({ now: () => t });
    const perMinute = PROVIDER_LIMITS.twelve_data.perMinute; // 8

    for (let i = 0; i < perMinute; i++) {
      expect(await gov.canSpend("twelve_data")).toBe(true);
      await gov.spend("twelve_data");
    }
    expect(await gov.canSpend("twelve_data")).toBe(false); // bucket full

    t += 60_001; // advance past the minute window
    expect(await gov.canSpend("twelve_data")).toBe(true); // recovered
  });

  it("enforces and persists the per-day limit through the store", async () => {
    let t = BASE;
    const store = makeFakeStore();
    const gov = createQuotaGovernor({ now: () => t, store });
    const perDay = PROVIDER_LIMITS.alpha_vantage.perDay; // 25

    for (let i = 0; i < perDay; i++) {
      // stay under the 5/min cap by stepping a minute between bursts
      if (i % 5 === 0) t += 60_001;
      expect(await gov.canSpend("alpha_vantage")).toBe(true);
      await gov.spend("alpha_vantage");
    }
    expect(await gov.canSpend("alpha_vantage")).toBe(false); // daily cap reached
    expect(store.counts.get(`alpha_vantage:${dayKeyUtc(BASE)}`)).toBe(perDay);
  });

  it("seeds the day counter from the store (survives a restart)", async () => {
    const store = makeFakeStore();
    await store.addDayCount("fmp", dayKeyUtc(BASE), PROVIDER_LIMITS.fmp.perDay); // pre-exhausted
    const gov = createQuotaGovernor({ now: () => BASE, store });
    expect(await gov.canSpend("fmp")).toBe(false); // reads persisted count, not fresh memory
  });

  it("resets the per-day budget after a UTC day rollover", async () => {
    let t = BASE;
    const store = makeFakeStore();
    const gov = createQuotaGovernor({ now: () => t, store });
    for (let i = 0; i < PROVIDER_LIMITS.fmp.perDay; i++) await gov.spend("fmp");
    expect(await gov.canSpend("fmp")).toBe(false);

    t += 24 * 60 * 60 * 1000; // next UTC day
    expect(await gov.canSpend("fmp")).toBe(true);
  });
});
