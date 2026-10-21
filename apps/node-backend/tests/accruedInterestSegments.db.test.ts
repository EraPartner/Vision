/**
 * Accrued interest on savings against real PostgreSQL: a top-up or withdrawal
 * after the last interest date changes the principal from its own date on.
 * Both the live summary (GET /api/info/portfolio-summary) and the snapshot
 * history accrue per principal segment, so their latest values agree.
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
import { addDaysYmd, todayAppDateString } from "../src/lib/timezone.ts";
import { invalidatePortfolioCaches } from "../src/services/info/cache.ts";
import { clearMemoryCache } from "../src/services/currency/currencyConversionService.ts";
import { computeDailySnapshots } from "../src/services/portfolio/snapshotBuilder.ts";
import { routeAgent } from "./helpers/routeApp.ts";
import { bodyAt } from "./helpers/responseBody.ts";
import portfolioSummaryRouter from "../src/routes/info/portfolioSummary.ts";

const describeDb = hasTestDatabase() ? describe : describe.skip;

async function savings(rate: number) {
  const { rows } = await getTestPool()!.query<{ id: number }>(
    `INSERT INTO investments (name, symbol, asset_class, currency, current_price, interest_rate, is_active)
     VALUES ('Synthetic term deposit', 'SYNTD', 'savings', 'EUR', 0, $1, true) RETURNING id`,
    [rate],
  );
  return rows[0]!.id;
}

async function txn(id: number, type: string, date: string, amount: number) {
  await getTestPool()!.query(
    `INSERT INTO portfolio_transactions (investment_id, type, date, amount, currency)
     VALUES ($1, $2, $3::date, $4, 'EUR')`,
    [id, type, date, amount],
  );
}

async function reset() {
  const pool = getTestPool()!;
  await pool.query("DELETE FROM portfolio_transactions");
  await pool.query("DELETE FROM investments");
  await pool.query("DELETE FROM exchange_rates");
  invalidatePortfolioCaches();
  clearMemoryCache();
}

describeDb("accrued interest per principal segment (real DB)", () => {
  const api = routeAgent(portfolioSummaryRouter, { mountPath: "/api/info" });
  const today = todayAppDateString();

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

  async function accrued() {
    const res = await api.get("/api/info/portfolio-summary?currency=EUR");
    expect(res.status).toBe(200);
    const rows = bodyAt(res, "data", "summaries") as Array<
      Record<string, unknown>
    >;
    return rows[0]!;
  }

  it("accrues a top-up only from its own date, in the summary and the history", async () => {
    // 12 000 at 2.5 %, interest paid 300 days ago, 3 000 top-up 100 days ago:
    // 12 000 × 0.025 × 200/365 = 164.38 plus 15 000 × 0.025 × 100/365 = 102.74
    // → 267.12 (15 000 over all 300 days would give 308.22).
    const id = await savings(2.5);
    await txn(id, "buy", addDaysYmd(today, -500), 12000);
    await txn(id, "interest", addDaysYmd(today, -300), 180);
    await txn(id, "buy", addDaysYmd(today, -100), 3000);

    const summary = await accrued();
    expect(summary.accruedInterest).toBe(267.12);
    expect(summary.currentValue).toBe(15267.12);

    const history = await computeDailySnapshots("EUR");
    const latest = history.at(-1)!;
    expect(latest.snapshot_date).toBe(today);
    expect(latest.cash_value).toBeCloseTo(15267.12, 2);
  });

  it("accrues the larger principal until a withdrawal", async () => {
    // 10 000 at 3 % from 90 days ago, 4 000 withdrawn 30 days ago:
    // 10 000 × 0.03 × 60/365 = 49.32 plus 6 000 × 0.03 × 30/365 = 14.79
    // → 64.11 (6 000 over all 90 days would give 44.38).
    const id = await savings(3);
    await txn(id, "buy", addDaysYmd(today, -90), 10000);
    await txn(id, "sell", addDaysYmd(today, -30), 4000);

    const summary = await accrued();
    expect(summary.accruedInterest).toBe(64.11);

    const latest = (await computeDailySnapshots("EUR")).at(-1)!;
    expect(latest.cash_value).toBeCloseTo(6064.11, 2);
  });
});
