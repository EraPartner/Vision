/**
 * GET /api/planned-transactions/totals against real PostgreSQL: the planned
 * totals the Home hero and the planned page show are computed on the server,
 * every recurring occurrence counted and every amount converted at the latest
 * stored rate.
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
import {
  addDaysYmd,
  differenceInCalendarDaysYmd,
  firstOfMonthYmd,
  todayAppDateString,
} from "../src/lib/timezone.ts";
import { routeAgent } from "./helpers/routeApp.ts";
import { bodyAt } from "./helpers/responseBody.ts";
import plannedRouter from "../src/routes/plannedTransactions.ts";

const describeDb = hasTestDatabase() ? describe : describe.skip;

interface PlannedSeed {
  date: string;
  amount: string;
  currency?: string;
  pattern?: string;
  endDate?: string;
  maxOccurrences?: number;
  isActive?: boolean;
  isExecuted?: boolean;
}

async function insertPlanned(row: PlannedSeed) {
  await getTestPool()!.query(
    `INSERT INTO planned_transactions
       (planned_date, amount, currency, is_recurring, recurrence_pattern,
        recurrence_end_date, max_occurrences, is_active, is_executed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      row.date,
      row.amount,
      row.currency ?? "EUR",
      row.pattern !== undefined,
      row.pattern ?? null,
      row.endDate ?? null,
      row.maxOccurrences ?? null,
      row.isActive ?? true,
      row.isExecuted ?? false,
    ],
  );
}

async function setRate(code: string, rateToEur: string, rateDate: string) {
  await getTestPool()!.query(
    `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest)
     VALUES ($1, $2, $3, true)`,
    [code, rateToEur, rateDate],
  );
}

describeDb("GET /api/planned-transactions/totals (real DB)", () => {
  const api = routeAgent(plannedRouter, {
    mountPath: "/api/planned-transactions",
  });
  const today = todayAppDateString();
  const monthEnd = addDaysYmd(firstOfMonthYmd(today, 1), -1);
  // Weekly occurrences from today through month end, inclusive.
  const weeklyThisMonth =
    Math.floor(differenceInCalendarDaysYmd(today, monthEnd) / 7) + 1;

  beforeAll(async () => {
    await acquireDbSuiteLock();
  });

  beforeEach(async () => {
    const pool = getTestPool()!;
    await pool.query("DELETE FROM planned_transaction_executions");
    await pool.query("DELETE FROM planned_transactions");
    await pool.query("DELETE FROM exchange_rates");
  });

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it("counts every recurring occurrence left this month and converts each currency", async () => {
    await setRate("USD", "0.9", today);
    await insertPlanned({ date: today, amount: "-10", pattern: "weekly" });
    await insertPlanned({ date: today, amount: "-100", pattern: "monthly" });
    await insertPlanned({
      date: today,
      amount: "100",
      currency: "USD",
      pattern: "monthly",
    });
    // Ends today: one occurrence this month, whatever its cadence.
    await insertPlanned({
      date: today,
      amount: "-5",
      pattern: "daily",
      endDate: today,
    });
    // No stored GBP rate: left out and counted, never added 1:1.
    await insertPlanned({ date: today, amount: "-7", currency: "GBP" });
    await insertPlanned({ date: today, amount: "-1000", isActive: false });
    await insertPlanned({ date: today, amount: "-2000", isExecuted: true });
    await insertPlanned({
      date: addDaysYmd(monthEnd, 1),
      amount: "-3000",
    });

    const res = await api.get("/api/planned-transactions/totals?currency=EUR");

    expect(res.status).toBe(200);
    expect(bodyAt(res, "data", "currency")).toBe("EUR");
    expect(bodyAt(res, "data", "month_end")).toBe(monthEnd);
    expect(bodyAt(res, "data", "rest_of_month")).toEqual({
      incoming: 90,
      outgoing: -(10 * weeklyThisMonth + 100 + 5),
      unconverted_count: 1,
    });
  });

  it("returns the net monthly equivalent of active recurring rows", async () => {
    await setRate("USD", "0.9", today);
    await insertPlanned({ date: today, amount: "-100", pattern: "monthly" });
    await insertPlanned({ date: today, amount: "-70", pattern: "weekly" });
    await insertPlanned({ date: today, amount: "-300", pattern: "quarterly" });
    await insertPlanned({
      date: today,
      amount: "100",
      currency: "USD",
      pattern: "monthly",
    });
    await insertPlanned({
      date: today,
      amount: "-50",
      currency: "GBP",
      pattern: "monthly",
    });
    // One-off, paused and finished rows are not monthly commitments.
    await insertPlanned({ date: today, amount: "-999" });
    await insertPlanned({
      date: today,
      amount: "-999",
      pattern: "monthly",
      isActive: false,
    });
    await insertPlanned({
      date: today,
      amount: "-999",
      pattern: "monthly",
      isExecuted: true,
    });

    const res = await api.get("/api/planned-transactions/totals?currency=EUR");

    expect(res.status).toBe(200);
    // -100 - 70 × 30.4375/7 - 300/3 + 100 × 0.9 = -414.375
    expect(bodyAt(res, "data", "monthly_equivalent")).toEqual({
      total: -414.38,
      unconverted_count: 1,
    });
  });

  it("converts into a non-EUR display currency through EUR", async () => {
    await setRate("USD", "0.8", today);
    await insertPlanned({ date: today, amount: "-40", pattern: "monthly" });

    const res = await api.get("/api/planned-transactions/totals?currency=usd");

    expect(res.status).toBe(200);
    expect(bodyAt(res, "data", "currency")).toBe("USD");
    expect(bodyAt(res, "data", "monthly_equivalent", "total")).toBe(-50);
  });

  it("rejects a malformed currency", async () => {
    const res = await api.get("/api/planned-transactions/totals?currency=euro");
    expect(res.status).toBe(400);
  });
});
