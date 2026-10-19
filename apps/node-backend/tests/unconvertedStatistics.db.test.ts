/**
 * Statistics over HTTP against real PostgreSQL (ADR-216): an amount whose
 * currency has no stored exchange rate is left out of the figures and
 * reported in `unconverted_count` / `unconverted_currencies`, never added 1:1.
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
import { todayAppDateString } from "../src/lib/timezone.ts";
import { clearMemoryCache } from "../src/services/currency/currencyConversionService.ts";
import { routeAgent } from "./helpers/routeApp.ts";
import { bodyAt } from "./helpers/responseBody.ts";
import aggregationsRouter from "../src/routes/aggregations.ts";

const describeDb = hasTestDatabase() ? describe : describe.skip;
const ACCOUNT = "Synthetic FX statistics";
const RECIPIENT = "Synthetic FX payee";

async function accountId(): Promise<number> {
  const pool = getTestPool()!;
  await pool.query(
    `INSERT INTO accounts (name, display_name) VALUES ($1, $1)
     ON CONFLICT (lower(btrim(name))) DO NOTHING`,
    [ACCOUNT],
  );
  const { rows } = await pool.query(
    "SELECT id FROM accounts WHERE lower(btrim(name)) = lower(btrim($1))",
    [ACCOUNT],
  );
  return rows[0].id;
}

async function recipientId(): Promise<number> {
  const pool = getTestPool()!;
  const found = await pool.query("SELECT id FROM recipients WHERE name = $1", [
    RECIPIENT,
  ]);
  if (found.rows[0]) return found.rows[0].id;
  const { rows } = await pool.query(
    "INSERT INTO recipients (name, normalized_name) VALUES ($1, $2) RETURNING id",
    [RECIPIENT, RECIPIENT.toLowerCase()],
  );
  return rows[0].id;
}

async function insertTxn(date: string, amount: string, currency: string) {
  await getTestPool()!.query(
    `INSERT INTO transactions (date, amount, currency, account_id, recipient_id, is_active, is_transfer)
     VALUES ($1::date, $2, $3, $4, $5, true, false)`,
    [date, amount, currency, await accountId(), await recipientId()],
  );
}

async function setRate(code: string, rateToEur: string, rateDate: string) {
  await getTestPool()!.query(
    `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest)
     VALUES ($1, $2, $3, true)`,
    [code, rateToEur, rateDate],
  );
}

describeDb("statistics with a currency without a stored rate (real DB)", () => {
  const api = routeAgent(aggregationsRouter, {
    mountPath: "/api/aggregations",
  });
  const today = todayAppDateString();
  const [year, month] = today.split("-").map(Number) as [number, number];

  async function reset() {
    const pool = getTestPool()!;
    await pool.query("DELETE FROM transactions");
    await pool.query("DELETE FROM accounts WHERE name = $1", [ACCOUNT]);
    await pool.query("DELETE FROM recipients WHERE name = $1", [RECIPIENT]);
    await pool.query("DELETE FROM exchange_rates");
    clearMemoryCache();
  }

  beforeAll(async () => {
    await acquireDbSuiteLock();
  });

  beforeEach(async () => {
    await reset();
    await setRate("USD", "0.9", today);
    await insertTxn(today, "1000", "EUR");
    await insertTxn(today, "-100", "EUR");
    await insertTxn(today, "-100", "USD");
    // No stored XYZ rate: flagged, never added 1:1.
    await insertTxn(today, "-50", "XYZ");
  });

  afterAll(async () => {
    await reset();
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it("monthly summary: a currency without a stored rate is flagged and not added 1:1", async () => {
    const res = await api.get("/api/aggregations/monthly-summary?currency=EUR");

    expect(res.status).toBe(200);
    const months = bodyAt(res, "data", "data", "months") as Array<{
      year: number;
      month: number;
      total_income: number;
      total_spending: number;
      transaction_count: number;
    }>;
    const current = months.find((m) => m.year === year && m.month === month);
    // -100 EUR and -100 USD × 0.9; the -50 XYZ is not in the total.
    expect(current).toMatchObject({
      total_income: 1000,
      total_spending: -190,
      transaction_count: 3,
    });
    expect(bodyAt(res, "data", "data", "unconverted_count")).toBe(1);
    expect(bodyAt(res, "data", "data", "unconverted_currencies")).toEqual([
      "XYZ",
    ]);
  });

  it("sankey: a currency without a stored rate is flagged and not added 1:1", async () => {
    const res = await api.get(
      `/api/aggregations/sankey?currency=EUR&year=${year}`,
    );

    expect(res.status).toBe(200);
    const nodes = bodyAt(res, "data", "data", "nodes") as Array<{
      id: string;
      value: number;
    }>;
    expect(nodes.find((n) => n.id === "__income__")?.value).toBe(1000);
    expect(nodes.find((n) => n.id === "__spending__")?.value).toBe(190);
    expect(bodyAt(res, "data", "data", "unconverted_count")).toBe(1);
    expect(bodyAt(res, "data", "data", "unconverted_currencies")).toEqual([
      "XYZ",
    ]);
  });

  it("reports no unconverted amounts when every currency has a rate", async () => {
    await getTestPool()!.query(
      "DELETE FROM transactions WHERE currency = 'XYZ'",
    );

    const res = await api.get("/api/aggregations/monthly-summary?currency=EUR");

    expect(res.status).toBe(200);
    expect(bodyAt(res, "data", "data", "unconverted_count")).toBe(0);
    expect(bodyAt(res, "data", "data", "unconverted_currencies")).toEqual([]);
  });
});
