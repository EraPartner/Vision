/**
 * Portfolio report and Belgian tax dashboard over HTTP against real PostgreSQL
 * (ADR-216): a dividend or a recorded tax whose currency has no stored
 * exchange rate is left out of the figures and flagged, never added 1:1.
 *
 * The report route returns the print-ready HTML; that document is the
 * rendered output under test.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { todayAppDateString } from "../src/lib/timezone.ts";
import { clearMemoryCache } from "../src/services/currency/currencyConversionService.ts";
import { invalidatePortfolioCaches } from "../src/services/info/cache.ts";

import { routeAgent } from "./helpers/routeApp.ts";
import { bodyAt } from "./helpers/responseBody.ts";
import reportsRouter from "../src/routes/reports.ts";
import belgianTaxRouter from "../src/routes/belgianTax.ts";
import { must } from "./helpers/must.ts";

const describeDb = hasTestDatabase() ? describe : describe.skip;
const PREFIX = "Synthetic FX fund";

async function investment(name: string, currency: string): Promise<number> {
  const { rows } = await must(getTestPool(), "test pool").query<{ id: number }>(
    `INSERT INTO investments (name, symbol, asset_class, currency, current_price, interest_rate, is_active)
     VALUES ($1, $3, 'stock', $2, 0, 0, true) RETURNING id`,
    [`${PREFIX} ${name}`, currency, `SYNFX${name}`],
  );
  return must(rows[0], "rows[0]").id;
}

async function txn(
  investmentId: number,
  type: string,
  date: string,
  amount: number,
  currency: string,
) {
  await must(getTestPool(), "test pool").query(
    `INSERT INTO portfolio_transactions (investment_id, type, date, amount, currency)
     VALUES ($1, $2, $3::date, $4, $5)`,
    [investmentId, type, date, amount, currency],
  );
}

async function setRate(code: string, rateToEur: string, rateDate: string) {
  await must(getTestPool(), "test pool").query(
    `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest)
     VALUES ($1, $2, $3, true)`,
    [code, rateToEur, rateDate],
  );
}

describeDb(
  "portfolio figures with a currency without a stored rate (real DB)",
  () => {
    const reports = routeAgent(reportsRouter, { mountPath: "/api/reports" });
    const tax = routeAgent(belgianTaxRouter, { mountPath: "/api/belgian-tax" });
    const today = todayAppDateString();
    const year = Number(today.slice(0, 4));
    let usdFund = 0;
    let xyzFund = 0;

    async function reset() {
      const pool = must(getTestPool(), "test pool");
      await pool.query("DELETE FROM portfolio_transactions");
      await pool.query("DELETE FROM investments");
      await pool.query("DELETE FROM exchange_rates");
      clearMemoryCache();
      invalidatePortfolioCaches();
    }

    beforeAll(async () => {
      await acquireDbSuiteLock();
    });

    beforeEach(async () => {
      await reset();

      await setRate("USD", "0.9", today);
      usdFund = await investment("USD", "USD");
      // No stored XYZ rate anywhere.
      xyzFund = await investment("XYZ", "XYZ");
    });

    afterAll(async () => {
      await reset();
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    });

    it("dividend report: a currency without a stored rate is flagged and not added 1:1", async () => {
      await txn(usdFund, "dividend", today, 100, "USD");
      await txn(xyzFund, "dividend", today, 50, "XYZ");

      const res = await reports.post("/api/reports/portfolio").send({
        currency: "EUR",
        period: { kind: "custom", from: `${year}-01-01`, to: today },
        sections: ["dividendIncome"],
      });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
      const html = String(bodyAt(res, "data", "html"));
      // 100 USD × 0.9; the 50 XYZ is neither added 1:1 (140) nor dropped silently.
      expect(html).toContain("Total: EUR 90.00");
      expect(html).not.toContain("EUR 140.00");
      expect(html).toContain("Incomplete:");
      expect(html).toContain("no exchange rate was available for XYZ");
      expect(html).toContain("1 dividend was left out");
    });

    it("tax dashboard: a currency without a stored rate is flagged and not added 1:1", async () => {
      await txn(usdFund, "tax", today, 10, "USD");
      await txn(xyzFund, "tax", today, 10, "XYZ");

      const res = await tax.get(
        `/api/belgian-tax/portfolio-dashboard?year=${year}&currency=EUR`,
      );

      expect(res.status).toBe(200);
      // 10 USD × 0.9; the 10 XYZ is left out, not added as 10 EUR (19).
      expect(bodyAt(res, "data", "totals", "totalRecordedTaxes")).toBe(9);
      expect(bodyAt(res, "data", "unconvertedCurrencies")).toEqual(["XYZ"]);
      expect(bodyAt(res, "data", "incompleteFigures")).toEqual(
        expect.arrayContaining(["totals", "taxBreakdown"]),
      );
    });

    it("tax dashboard: nothing is flagged when every currency has a rate", async () => {
      await txn(usdFund, "tax", today, 10, "USD");

      const res = await tax.get(
        `/api/belgian-tax/portfolio-dashboard?year=${year}&currency=EUR`,
      );

      expect(res.status).toBe(200);
      expect(bodyAt(res, "data", "totals", "totalRecordedTaxes")).toBe(9);
      expect(bodyAt(res, "data", "unconvertedCurrencies")).toEqual([]);
      expect(bodyAt(res, "data", "incompleteFigures")).toEqual([]);
    });
  },
);
