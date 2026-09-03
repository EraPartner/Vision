import { describe, expect, it, vi } from "vitest";
import currencyConversionService from "../../src/services/currency/currencyConversionService.js";

import {
  mockCurrencyConversion,
  mockRowsAlreadyInTargetCurrency,
} from "./mockCurrencyConversion.js";

describe("mockCurrencyConversion", () => {
  it("exposes the complete named surface with matching default-export spies", async () => {
    const fake = mockCurrencyConversion();
    const rows = [{ amount: "12.50", currency: "EUR" }];

    await expect(fake.convertRowsToEur(rows)).resolves.toBe(rows);
    expect(Object.keys(fake.default).sort()).toEqual(
      Object.keys(currencyConversionService).sort(),
    );
    expect(fake.default.convertRowsToEur).toBe(fake.convertRowsToEur);
    expect(fake.default.convertToCurrency).toBe(fake.convertToCurrency);
    expect(fake.default.loadCurrentRates).toBe(fake.loadCurrentRates);
    expect(fake.default.warmCache).toBe(fake.warmCache);
    expect(fake.default.listLatestStoredRates).toBe(fake.listLatestStoredRates);
    expect(fake.default.FALLBACK_RATES).toBe(fake.FALLBACK_RATES);
    expect(fake.clearHistoricalIndexCache).toEqual(expect.any(Function));
    expect(fake.getHistoricalRateIndex).toEqual(expect.any(Function));
    expect(fake.listLatestStoredRates).toEqual(expect.any(Function));
  });

  it("applies explicit overrides without inventing conversion arithmetic", async () => {
    const convertRowsToEur = vi.fn(async () => [{ amount_eur: 9 }]);
    const fake = mockCurrencyConversion({ convertRowsToEur });

    await expect(fake.convertRowsToEur([])).resolves.toEqual([
      { amount_eur: 9 },
    ]);
    expect(fake.default.convertRowsToEur).toBe(convertRowsToEur);
  });

  it("offers one canonical already-in-target-currency row fake", async () => {
    const convertRowsToEur = mockRowsAlreadyInTargetCurrency();
    await expect(
      convertRowsToEur([{ amount: "12.50", currency: "EUR" }]),
    ).resolves.toEqual([
      { amount: "12.50", currency: "EUR", amount_eur: 12.5 },
    ]);
  });
});
