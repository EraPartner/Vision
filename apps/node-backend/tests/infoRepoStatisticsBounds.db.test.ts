/**
 * Real-PostgreSQL checks for explicit date bounds (combined with exclusions)
 * in the category breakdown and pivot. Previously pinned only by asserting the
 * bound SQL placeholders and parameters on a mocked pool.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { statisticsRepository } from "../src/repositories/infoRepositoryStatistics.ts";
import { clearMvCache } from "../src/repositories/infoRepositoryHelpers.ts";
import { clearMemoryCache } from "../src/services/currency/currencyConversionService.ts";
import { closePool } from "../src/database/connection.ts";
import { must } from "./helpers/must.ts";
import type { AccountId, CategoryId, RecipientId } from "@vision/types/brands";

const SUFFIX = `ISB${process.pid}`;
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
    [`Statistics ${SUFFIX}`],
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
    [`STATS${SUFFIX}`],
  );
  created.categoryIds.push(...categories.map((r) => r.id as number));
  return {
    accountId: must(account[0], "account[0]").id as number,
    kept: must(recipients[0], "recipients[0]").id as number,
    excludedRecipient: must(recipients[1], "recipients[1]").id as number,
    keptCategory: must(categories[0], "categories[0]").id as number,
    excludedCategory: must(categories[1], "categories[1]").id as number,
  };
}

describe.skipIf(!hasTestDatabase())("statistics date bounds (real DB)", () => {
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
    clearMvCache();
    clearMemoryCache();
  });

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it("limits the breakdown and pivot to explicit bounds after exclusions", async () => {
    const fx = await seed();
    const rows: [string, string, number, number][] = [
      ["2025-02-01", "-1.00", fx.kept, fx.keptCategory], // before the window
      ["2025-02-15", "-10.00", fx.kept, fx.keptCategory],
      ["2025-03-01", "-20.00", fx.kept, fx.keptCategory],
      ["2025-02-20", "-30.00", fx.kept, fx.excludedCategory],
      ["2025-02-21", "-40.00", fx.excludedRecipient, fx.keptCategory],
      ["2025-03-20", "-50.00", fx.kept, fx.keptCategory], // after the window
    ];
    for (const [date, amount, recipientId, categoryId] of rows) {
      const { rows: inserted } = await must(
        getTestPool(),
        "getTestPool()",
      ).query<{ id: number }>(
        `INSERT INTO transactions (date, amount, currency, recipient_id, category_id, account_id)
         VALUES ($1, $2, 'EUR', $3, $4, $5) RETURNING id`,
        [date, amount, recipientId, categoryId, fx.accountId],
      );
      created.transactionIds.push(must(inserted[0], "inserted[0]").id);
    }
    const filters = {
      startDate: "2025-02-12",
      endDate: "2025-03-08",
      excludedCategoryIds: [fx.excludedCategory],
      excludedRecipientIds: [fx.excludedRecipient],
    };

    const breakdown = await statisticsRepository.getCategoryBreakdown(
      "EUR",
      undefined,
      filters,
    );
    expect(breakdown.filter((row) => row.id === fx.keptCategory)).toEqual([
      expect.objectContaining({ count: 2, total: -30 }),
    ]);
    expect(breakdown.some((row) => row.id === fx.excludedCategory)).toBe(false);

    const { categoryPivot } =
      await statisticsRepository.getCategoryPivot(filters);
    const ours = (month: string) =>
      (categoryPivot[month] ?? [])
        .filter((cell) =>
          [fx.keptCategory, fx.excludedCategory].includes(
            must(cell.categoryId, "cell.categoryId"),
          ),
        )
        .map((cell) => [cell.categoryId, cell.total]);
    expect(ours("2025-02")).toEqual([[fx.keptCategory, -10]]);
    expect(ours("2025-03")).toEqual([[fx.keptCategory, -20]]);
  });
});
