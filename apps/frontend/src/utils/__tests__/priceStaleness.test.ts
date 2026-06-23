// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isPriceStale,
  countStalePrices,
  STALE_PRICE_THRESHOLD_MS,
} from "@/utils/priceStaleness";

const NOW = Date.parse("2026-06-22T12:00:00.000Z");

describe("isPriceStale", () => {
  it("treats manual-provider investments as never stale", () => {
    expect(isPriceStale({ price_provider: "manual", price_updated_at: null }, undefined, NOW)).toBe(false);
  });

  it("defaults a missing provider to manual (never stale)", () => {
    expect(isPriceStale({ price_updated_at: null }, undefined, NOW)).toBe(false);
  });

  it("is stale when a live-provider price has no update timestamp", () => {
    expect(isPriceStale({ price_provider: "yahoo", price_updated_at: null }, undefined, NOW)).toBe(true);
  });

  it("is stale when the update timestamp is unparseable", () => {
    expect(isPriceStale({ price_provider: "yahoo", price_updated_at: "not-a-date" }, undefined, NOW)).toBe(true);
  });

  it("is fresh when updated within the threshold", () => {
    const oneHourAgo = new Date(NOW - 60 * 60 * 1000).toISOString();
    expect(isPriceStale({ price_provider: "yahoo", price_updated_at: oneHourAgo }, undefined, NOW)).toBe(false);
  });

  it("is stale when updated beyond the threshold", () => {
    const twoDaysAgo = new Date(NOW - 48 * 60 * 60 * 1000).toISOString();
    expect(isPriceStale({ price_provider: "yahoo", price_updated_at: twoDaysAgo }, undefined, NOW)).toBe(true);
  });

  it("honours a custom threshold", () => {
    const ts = new Date(NOW - 30 * 60 * 1000).toISOString(); // 30 min ago
    expect(isPriceStale({ price_provider: "yahoo", price_updated_at: ts }, 10 * 60 * 1000, NOW)).toBe(true);
    expect(isPriceStale({ price_provider: "yahoo", price_updated_at: ts }, 60 * 60 * 1000, NOW)).toBe(false);
  });
});

describe("countStalePrices", () => {
  it("counts only the stale live-provider investments", () => {
    const fresh = new Date(NOW - 60 * 1000).toISOString();
    const stale = new Date(NOW - 72 * 60 * 60 * 1000).toISOString();
    const investments = [
      { price_provider: "yahoo", price_updated_at: stale },
      { price_provider: "yahoo", price_updated_at: fresh },
      { price_provider: "manual", price_updated_at: null },
      { price_provider: "coingecko", price_updated_at: null },
    ];
    expect(countStalePrices(investments, undefined, NOW)).toBe(2);
  });

  it("returns 0 for an empty list", () => {
    expect(countStalePrices([], undefined, NOW)).toBe(0);
  });
});

describe("STALE_PRICE_THRESHOLD_MS", () => {
  it("is 24 hours in milliseconds", () => {
    expect(STALE_PRICE_THRESHOLD_MS).toBe(24 * 60 * 60 * 1000);
  });
});
