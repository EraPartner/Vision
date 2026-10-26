/**
 * Belgian portfolio-tax dashboard over HTTP against real PostgreSQL (ADR-240):
 * realized gains, the CGT estimate and the effective tax rate of a tax year
 * come from that year's sells only, recorded costs convert at the rate of
 * their transaction's date, and the TOB counts the sale as well as the buy.
 * Every expected value is hand-computed from the seeded transactions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { clearMemoryCache } from "../src/services/currency/currencyConversionService.ts";
import { invalidatePortfolioCaches } from "../src/services/info/cache.ts";
import { getTaxTable } from "@vision/shared-utils/belgian-tax/constants";

import { routeAgent } from "./helpers/routeApp.ts";
import { bodyAt } from "./helpers/responseBody.ts";
import belgianTaxRouter from "../src/routes/belgianTax.ts";
import { must } from "./helpers/must.ts";

const describeDb = hasTestDatabase() ? describe : describe.skip;

async function stock(name: string, currency = "EUR", price = 50) {
  const { rows } = await must(getTestPool(), "test pool").query<{ id: number }>(
    `INSERT INTO investments (name, symbol, asset_class, currency, current_price, interest_rate, is_active)
     VALUES ($1, $1, 'stock', $2, $3, 0, true) RETURNING id`,
    [name, currency, price],
  );
  return must(rows[0], "rows[0]").id;
}

async function txn(
  investmentId: number,
  type: string,
  date: string,
  amount: number,
  {
    units = null,
    taxes = 0,
    currency = "EUR",
    fxRateToEur = null,
  }: {
    units?: number | null;
    taxes?: number;
    currency?: string;
    fxRateToEur?: string | null;
  } = {},
) {
  await must(getTestPool(), "test pool").query(
    `INSERT INTO portfolio_transactions (investment_id, type, date, amount, units, taxes, currency, fx_rate_to_eur)
     VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)`,
    [investmentId, type, date, amount, units, taxes, currency, fxRateToEur],
  );
}

async function setRate(code: string, rateToEur: string, rateDate: string, isLatest: boolean) {
  await must(getTestPool(), "test pool").query(
    `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest)
     VALUES ($1, $2, $3, $4)`,
    [code, rateToEur, rateDate, isLatest],
  );
}

async function reset() {
  const pool = must(getTestPool(), "test pool");
  await pool.query("DELETE FROM portfolio_transactions");
  await pool.query("DELETE FROM investments");
  await pool.query("DELETE FROM exchange_rates");
  clearMemoryCache();
  invalidatePortfolioCaches();
}

describeDb("Belgian portfolio-tax dashboard per tax year (real DB)", () => {
  const tax = routeAgent(belgianTaxRouter, { mountPath: "/api/belgian-tax" });
  const dashboard = (year: number) =>
    tax.get(`/api/belgian-tax/portfolio-dashboard?year=${year}&currency=EUR`);

  beforeAll(async () => {
    await acquireDbSuiteLock();
  });
  beforeEach(reset);
  afterAll(async () => {
    await reset();
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  async function seedSells() {
    // 100 units for 1,000 (average cost 10). 2025: 50 units sold for 30,000
    // with TOB 30,000 × 0.35% = 105 recorded → gain 30,000 − 105 − 500 =
    // 29,395. 2026: 10 units sold for 700 → gain 700 − 100 = 600.
    const id = await stock("Synthetic CGT stock");
    await txn(id, "buy", "2024-03-01", 1000, { units: 100 });
    await txn(id, "sell", "2025-03-03", 30000, { units: 50, taxes: 105 });
    await txn(id, "sell", "2026-03-02", 700, { units: 10 });
  }

  it("a prior-year sell does not enter the current year's CGT estimate", async () => {
    await seedSells();
    const res = await dashboard(2026);
    expect(res.status).toBe(200);
    // Only 2026's 600, under the exemption: no CGT. With the lifetime gain
    // (30,100) the estimate was positive.
    expect(getTaxTable(2026).capitalGainsTaxRate).toBeGreaterThan(0);
    expect(bodyAt(res, "data", "totals", "totalRealizedGain")).toBe(600);
    expect(bodyAt(res, "data", "estimates", "cgtEstimate")).toBe(0);
    expect(bodyAt(res, "data", "totals", "effectiveTaxRate")).toBe(0);
  });

  it("a sell after the tax year does not appear in that year", async () => {
    await seedSells();
    const res = await dashboard(2025);
    expect(res.status).toBe(200);
    // 2025's sell only, net of its TOB as in the portfolio summary:
    // 30,000 − 105 − 500 = 29,395 (the 2026 sell's 600 stays out).
    expect(bodyAt(res, "data", "totals", "totalRealizedGain")).toBe(29395);
    expect(bodyAt(res, "data", "investmentBreakdown", 0)).toMatchObject({
      realizedGain: 29395,
    });
    // The year's taxes are the sell's TOB: 105 / 29,395 × 100.
    expect(bodyAt(res, "data", "totals", "effectiveTaxRate")).toBeCloseTo(
      (105 / 29395) * 100,
      10,
    );
    // TOB on the sale (WDRT art. 122): recorded 105, estimated 30,000 × 0.35%
    // (the buy leg is in 2024).
    expect(bodyAt(res, "data", "estimates", "tobRecorded")).toBe(105);
    expect(bodyAt(res, "data", "estimates", "tobAutoEstimate")).toBeCloseTo(
      105,
      10,
    );
    expect(bodyAt(res, "data", "taxBreakdown")).toEqual([
      { nameKey: "tax.transactionTax", value: 105 },
    ]);
  });

  it("converts a closed year's recorded costs at the transaction date's rate", async () => {
    // USD rates: 0.5 stored for 2025-01-02, 0.9 today. One buy is stamped
    // with 0.6, the other has no stamp and takes the stored 0.5.
    await setRate("USD", "0.5", "2025-01-02", false);
    await setRate("USD", "0.9", "2026-10-01", true);
    const id = await stock("Synthetic USD stock", "USD");
    await txn(id, "buy", "2025-02-03", 1000, {
      units: 10,
      taxes: 10,
      currency: "USD",
      fxRateToEur: "0.6",
    });
    await txn(id, "buy", "2025-02-04", 1000, {
      units: 10,
      taxes: 10,
      currency: "USD",
    });
    const res = await dashboard(2025);
    expect(res.status).toBe(200);
    // 10 × 0.6 + 10 × 0.5 = 11 (today's rate would give 18).
    expect(bodyAt(res, "data", "totals", "totalRecordedTaxes")).toBeCloseTo(
      11,
      10,
    );
    expect(bodyAt(res, "data", "estimates", "tobRecorded")).toBeCloseTo(11, 10);
    // (1,000 × 0.6 + 1,000 × 0.5) × 0.35% = 3.85.
    expect(bodyAt(res, "data", "estimates", "tobAutoEstimate")).toBeCloseTo(
      3.85,
      10,
    );
    expect(bodyAt(res, "data", "unconvertedCurrencies")).toEqual([]);
  });
});
