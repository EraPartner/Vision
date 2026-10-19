/**
 * Real-PostgreSQL behaviour of explicit calendar bounds in the monthly
 * financial summary and the report fetcher's custom period. Replaces mocked
 * tests that asserted the bound SQL placeholders and parameters.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { getMonthlyFinancialSummary } from "../src/repositories/infoRepositoryMonthly.ts";
import { fetchFinancialData } from "../src/services/reports/dataFetcher.ts";
import { clearMemoryCache } from "../src/services/currency/currencyConversionService.ts";
import { closePool } from "../src/database/connection.ts";

const SUFFIX = `IMB${process.pid}`;
const ids = { account: 0, recipient: 0, excludedRecipient: 0 };
const transactionIds: number[] = [];

async function insertTxn(
  date: string,
  amount: string,
  recipientId = ids.recipient,
) {
  const { rows } = await getTestPool()!.query(
    `INSERT INTO transactions (date, amount, currency, recipient_id, account_id)
     VALUES ($1, $2, 'EUR', $3, $4) RETURNING id`,
    [date, amount, recipientId, ids.account],
  );
  transactionIds.push(rows[0].id);
}

const monthKeys = (
  result: Awaited<ReturnType<typeof getMonthlyFinancialSummary>>,
) => result.months.map((m) => `${m.year}-${String(m.month).padStart(2, "0")}`);

describe.skipIf(!hasTestDatabase())(
  "monthly summary calendar bounds (real DB)",
  () => {
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
      const pool = getTestPool()!;
      const { rows: account } = await pool.query(
        `INSERT INTO accounts (name, display_name, currency) VALUES ($1, $1, 'EUR') RETURNING id`,
        [`Bounds ${SUFFIX}`],
      );
      ids.account = account[0].id;
      const { rows: recipients } = await pool.query(
        `INSERT INTO recipients (name, normalized_name)
       VALUES ($1, lower($1)), ($2, lower($2)) RETURNING id`,
        [`Bounds Payee ${SUFFIX}`, `Bounds Excluded ${SUFFIX}`],
      );
      ids.recipient = recipients[0].id;
      ids.excludedRecipient = recipients[1].id;
    }, 180_000);

    afterEach(async () => {
      await getTestPool()!.query(
        "DELETE FROM transactions WHERE id = ANY($1::int[])",
        [transactionIds.splice(0)],
      );
      clearMemoryCache();
    });

    afterAll(async () => {
      try {
        const pool = getTestPool()!;
        await pool.query("DELETE FROM recipients WHERE id = ANY($1::int[])", [
          [ids.recipient, ids.excludedRecipient],
        ]);
        await pool.query("DELETE FROM accounts WHERE id = $1", [ids.account]);
      } finally {
        await releaseDbSuiteLock();
        await closeTestPool();
        await closePool();
      }
    });

    it("limits both the month series and the transaction scan to explicit bounds", async () => {
      await insertTxn("2024-12-20", "-5.00");
      await insertTxn("2025-01-10", "-10.00");
      await insertTxn("2025-01-16", "-20.00");
      await insertTxn("2025-01-16", "100.00");
      await insertTxn("2025-01-18", "-7.00", ids.excludedRecipient);
      await insertTxn("2025-01-25", "-40.00");

      const result = await getMonthlyFinancialSummary(
        [],
        "EUR",
        [ids.excludedRecipient],
        false,
        "2025-01-15",
        "2025-01-20",
      );
      expect(monthKeys(result)).toEqual(["2025-01"]);
      expect(result.months[0]).toMatchObject({
        total_income: 100,
        total_spending: -20,
        net_amount: 80,
        transaction_count: 2,
      });
    });

    it("applies a report's custom period and keeps the no-period report all-time", async () => {
      await insertTxn("2024-12-20", "-5.00");
      await insertTxn("2025-01-16", "-20.00");
      await insertTxn("2025-01-25", "-40.00");

      const custom = await fetchFinancialData("EUR", {
        period: { kind: "custom", from: "2025-01-15", to: "2025-01-20" },
        sections: ["executiveSummary"],
      });
      const customMonths = custom.monthly!.months;
      expect(customMonths.map((m) => [m.year, m.month])).toEqual([[2025, 1]]);
      expect(customMonths[0]).toMatchObject({
        total_spending: -20,
        transaction_count: 1,
      });

      const allTime = await fetchFinancialData("EUR", {
        sections: ["executiveSummary"],
      });
      const allTimeMonths = allTime.monthly!.months;
      expect(
        allTimeMonths.find((m) => m.year === 2024 && m.month === 12),
      ).toMatchObject({ total_spending: -5, transaction_count: 1 });
      expect(
        allTimeMonths.find((m) => m.year === 2025 && m.month === 1),
      ).toMatchObject({ total_spending: -60, transaction_count: 2 });
    });
  },
);
