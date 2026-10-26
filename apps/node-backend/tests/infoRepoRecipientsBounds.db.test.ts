/**
 * Real-PostgreSQL checks for explicit date bounds (with a recipient exclusion)
 * on the recipient insights and recipients-by-year reads. Previously pinned
 * only by asserting SQL placeholders and bound parameters on a mocked pool.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { recipientInsightsRepository } from "../src/repositories/infoRepositoryRecipients.ts";
import { clearMvCache } from "../src/repositories/infoRepositoryHelpers.ts";
import { clearMemoryCache } from "../src/services/currency/currencyConversionService.ts";
import { closePool } from "../src/database/connection.ts";
import { must } from "./helpers/must.ts";
import type {
  AccountId,
  RecipientId,
  TransactionId,
} from "@vision/types/brands";

const SUFFIX = `IRB${process.pid}`;
const created = {
  transactionIds: [] as number[],
  recipientIds: [] as number[],
  accountIds: [] as number[],
};

async function seed() {
  const db = must(getTestPool(), "getTestPool()");
  const { rows: account } = await db.query<{ id: AccountId }>(
    `INSERT INTO accounts (name, display_name, currency) VALUES ($1, $1, 'EUR') RETURNING id`,
    [`Recipients ${SUFFIX}`],
  );
  created.accountIds.push(must(account[0], "account[0]").id);
  const { rows: recipients } = await db.query<{ id: RecipientId }>(
    `INSERT INTO recipients (name, normalized_name)
     VALUES ($1, lower($1)), ($2, lower($2)) RETURNING id`,
    [`Kept ${SUFFIX}`, `Excluded ${SUFFIX}`],
  );
  created.recipientIds.push(...recipients.map((r) => r.id as number));
  const kept = must(recipients[0], "recipients[0]").id as number;
  const excluded = must(recipients[1], "recipients[1]").id as number;
  const rows: [string, string, number][] = [
    ["2024-09-30", "-1.00", kept], // before the window
    ["2024-10-01", "-10.00", kept],
    ["2025-06-15", "-20.00", kept],
    ["2025-06-16", "-99.00", excluded],
    ["2026-09-08", "-50.00", kept], // after the window
  ];
  for (const [date, amount, recipientId] of rows) {
    const { rows: inserted } = await db.query<{ id: TransactionId }>(
      `INSERT INTO transactions (date, amount, currency, recipient_id, account_id)
       VALUES ($1, $2, 'EUR', $3, $4) RETURNING id`,
      [date, amount, recipientId, must(account[0], "account[0]").id],
    );
    created.transactionIds.push(must(inserted[0], "inserted[0]").id);
  }
  return { kept, excluded };
}

const bounds = { startDate: "2024-10-01", endDate: "2026-09-07" };

describe.skipIf(!hasTestDatabase())(
  "recipient read date bounds (real DB)",
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
      clearMvCache();
      clearMemoryCache();
    });

    afterAll(async () => {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    });

    it("limits top merchants to the inclusive bounds after the recipient exclusion", async () => {
      const fx = await seed();
      const insights = await recipientInsightsRepository.getRecipientInsights(
        "EUR",
        { excludedRecipientIds: [fx.excluded], ...bounds },
      );
      const ours = insights.topMerchants.filter((m) =>
        [fx.kept, fx.excluded].includes(m.recipientId),
      );
      expect(ours).toEqual([
        expect.objectContaining({
          recipientId: fx.kept,
          totalSpend: 30,
          transactionCount: 2,
          firstSeen: "2024-10-01",
          lastSeen: "2025-06-15",
        }),
      ]);
    });

    it("limits recipients-by-year to the inclusive bounds after the recipient exclusion", async () => {
      const fx = await seed();
      const byYear = await recipientInsightsRepository.getRecipientByYear({
        targetCurrency: "EUR",
        excludedRecipientIds: [fx.excluded],
        ...bounds,
      });
      const ours = (year: string) =>
        (byYear.recipientsByYear[year] ?? [])
          .filter((r) => [fx.kept, fx.excluded].includes(r.recipientId))
          .map((r) => [r.recipientId, r.totalSpend]);
      expect(ours("2024")).toEqual([[fx.kept, 10]]);
      expect(ours("2025")).toEqual([[fx.kept, 20]]);
      expect(ours("2026")).toEqual([]);
    });
  },
);
