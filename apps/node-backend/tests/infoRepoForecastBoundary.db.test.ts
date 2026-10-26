/**
 * Real-PostgreSQL checks for the cash-flow forecast reads that were previously
 * pinned only through SQL substrings and bound parameters on a mocked pool:
 * default transfer exclusion on getCashflowForecastData, and category plus
 * recipient exclusions on the by-category forecast.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import {
  getCashflowForecastData,
  getCashflowForecastDataByCategory,
} from "../src/repositories/infoRepositoryForecast.ts";
import { clearMemoryCache } from "../src/services/currency/currencyConversionService.ts";
import { closePool } from "../src/database/connection.ts";
import { todayAppDateString } from "../src/lib/timezone.ts";
import { must } from "./helpers/must.ts";
import type {
  AccountId,
  CategoryId,
  RecipientId,
  TransactionId,
} from "@vision/types/brands";

const SUFFIX = `IFB${process.pid}`;
const created = {
  transactionIds: [] as number[],
  recipientIds: [] as number[],
  categoryIds: [] as number[],
  accountIds: [] as number[],
};

async function seed() {
  const db = must(getTestPool(), "getTestPool()");
  const { rows: account } = await db.query<{ id: AccountId }>(
    `INSERT INTO accounts (name, display_name, currency) VALUES ($1, $1, 'EUR') RETURNING id`,
    [`Forecast ${SUFFIX}`],
  );
  created.accountIds.push(must(account[0], "account[0]").id);
  const { rows: recipients } = await db.query<{ id: RecipientId }>(
    `INSERT INTO recipients (name, normalized_name)
     VALUES ($1, lower($1)), ($2, lower($2)) RETURNING id`,
    [`Kept ${SUFFIX}`, `Excluded ${SUFFIX}`],
  );
  created.recipientIds.push(...recipients.map((r) => r.id as number));
  const { rows: categories } = await db.query<{ id: CategoryId }>(
    `INSERT INTO categories (general, detail)
     VALUES ($1, 'KEPT'), ($1, 'EXCLUDED') RETURNING id`,
    [`FORECAST${SUFFIX}`],
  );
  created.categoryIds.push(...categories.map((r) => r.id as number));
  return {
    accountId: must(account[0], "account[0]").id as number,
    keptRecipient: must(recipients[0], "recipients[0]").id as number,
    excludedRecipient: must(recipients[1], "recipients[1]").id as number,
    keptCategory: must(categories[0], "categories[0]").id as number,
    excludedCategory: must(categories[1], "categories[1]").id as number,
  };
}

async function insertTxn(
  fx: Awaited<ReturnType<typeof seed>>,
  amount: string,
  {
    recipientId = fx.keptRecipient,
    categoryId = fx.keptCategory,
    isTransfer = false,
  } = {},
) {
  const { rows } = await must(getTestPool(), "getTestPool()").query<{
    id: TransactionId;
  }>(
    `INSERT INTO transactions (date, amount, currency, recipient_id, category_id, account_id, is_transfer)
     VALUES ($1::date, $2, 'EUR', $3, $4, $5, $6) RETURNING id`,
    [
      todayAppDateString(),
      amount,
      recipientId,
      categoryId,
      fx.accountId,
      isTransfer,
    ],
  );
  created.transactionIds.push(must(rows[0], "rows[0]").id);
}

describe.skipIf(!hasTestDatabase())(
  "cash-flow forecast reads (real DB)",
  () => {
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180_000);

    afterEach(async () => {
      const db = must(getTestPool(), "getTestPool()");
      await db.query("DELETE FROM transactions WHERE id = ANY($1::int[])", [
        created.transactionIds.splice(0),
      ]);
      await db.query("DELETE FROM accounts WHERE id = ANY($1::int[])", [
        created.accountIds.splice(0),
      ]);
      await db.query("DELETE FROM recipients WHERE id = ANY($1::int[])", [
        created.recipientIds.splice(0),
      ]);
      await db.query("DELETE FROM categories WHERE id = ANY($1::int[])", [
        created.categoryIds.splice(0),
      ]);
      await db.query(
        "DELETE FROM user_settings WHERE key = 'includeTransfers'",
      );
      clearMemoryCache();
    });

    afterAll(async () => {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    });

    it("leaves transfer legs out of the forecast's actual-to-date by default", async () => {
      const fx = await seed();
      await insertTxn(fx, "-100.00");
      await insertTxn(fx, "-900.00", { isTransfer: true });

      const forecast = await getCashflowForecastData(3, [], [], "EUR");
      expect(forecast.currentActual).toEqual([
        { date: todayAppDateString(), net: -100 },
      ]);
    });

    it("applies category and recipient exclusions to the by-category forecast", async () => {
      const fx = await seed();
      await insertTxn(fx, "-100.00");
      await insertTxn(fx, "-30.00", { categoryId: fx.excludedCategory });
      await insertTxn(fx, "-7.00", { recipientId: fx.excludedRecipient });

      const byCat = await getCashflowForecastDataByCategory(
        3,
        [fx.excludedCategory],
        [fx.excludedRecipient],
        "EUR",
      );
      expect(
        byCat.currentActualByCategory.map((row) => [row.category_id, row.net]),
      ).toEqual([[fx.keptCategory, -100]]);
    });
  },
);
