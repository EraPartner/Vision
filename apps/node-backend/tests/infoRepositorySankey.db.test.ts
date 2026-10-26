/**
 * Real-PostgreSQL behaviour of getSankeyAggregates. Replaces the mocked-pool
 * repositories/infoRepositorySankey.test.ts, which asserted SQL fragments:
 * here the grouped totals, the three-level effective category, the category
 * subtree and recipient-cluster exclusions, and the includeTransfers setting
 * are checked against the rows Postgres returns.
 *
 * Fixtures use dates in 1903 so rows other suites leave behind never fall in
 * the queried range; afterAll deletes only what this suite created.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { createCategoryNode } from "../src/repositories/categoryHierarchyRepository.ts";
import { getSankeyAggregates } from "../src/repositories/infoRepositorySankey.ts";
import {
  asCategoryId, type RecipientId, type TransactionId } from "@vision/types/brands";
import { must } from "./helpers/must.ts";

const MARK = `sankey_${process.pid}`;
const RANGE = { yearStart: "1903-01-01", yearEnd: "1903-12-31" };
const created = {
  categoryIds: [] as number[],
  recipientIds: [] as number[],
  transactionIds: [] as number[],
};

async function recipient(
  name: string,
  defaultCategoryId: number | null = null,
  primaryId: number | null = null,
): Promise<number> {
  const { rows } = await must(getTestPool(), "getTestPool()").query<{ id: RecipientId }>(
    `INSERT INTO recipients (name, normalized_name, default_category_id, primary_recipient_id)
     VALUES ($1, $1, $2, $3) RETURNING id`,
    [`${MARK}_${name}`, defaultCategoryId, primaryId],
  );
  created.recipientIds.push(must(rows[0], "rows[0]").id);
  return must(rows[0], "rows[0]").id;
}

async function txn(
  amount: string,
  recipientId: number,
  {
    categoryId = null,
    isTransfer = false,
    isActive = true,
    date = "1903-06-01",
  }: {
    categoryId?: number | null;
    isTransfer?: boolean;
    isActive?: boolean;
    date?: string;
  } = {},
) {
  const { rows } = await must(getTestPool(), "getTestPool()").query<{ id: TransactionId }>(
    `INSERT INTO transactions (date, amount, currency, recipient_id, category_id, is_transfer, is_active, memo)
     VALUES ($1, $2, 'EUR', $3, $4, $5, $6, $7) RETURNING id`,
    [date, amount, recipientId, categoryId, isTransfer, isActive, MARK],
  );
  created.transactionIds.push(must(rows[0], "rows[0]").id);
}

/** Map rows to `${category_id ?? "none"}:${in|out}` → amount for stable compares. */
function totals(rows: Awaited<ReturnType<typeof getSankeyAggregates>>) {
  return Object.fromEntries(
    rows.map((row) => [
      `${row.category_id ?? "none"}:${row.is_income ? "in" : "out"}`,
      row.amount,
    ]),
  );
}

describe.skipIf(!hasTestDatabase())("getSankeyAggregates (real DB)", () => {
  const cat = {} as Record<"food" | "groceries" | "salary", number>;
  const rec = {} as Record<"shop" | "shopAlias" | "employer" | "misc", number>;

  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
    await acquireDbSuiteLock();
    await must(getTestPool(), "getTestPool()").query(
      "DELETE FROM user_settings WHERE key = 'includeTransfers'",
    );
    cat.food = must((await createCategoryNode({ name: `FOOD${MARK}` })), "(await createCategoryNode({ name: `FOOD${MARK}` }))").id;
    cat.groceries = must((await createCategoryNode({
      name: "GROCERIES",
      parentId: asCategoryId(cat.food),
    })), "(await createCategoryNode({ name: \"GROCERIES\", parentId: asC").id;
    cat.salary = must((await createCategoryNode({ name: `SALARY${MARK}` })), "(await createCategoryNode({ name: `SALARY${MARK}` }))").id;
    created.categoryIds.push(cat.food, cat.groceries, cat.salary);
    rec.shop = await recipient("shop", cat.groceries);
    rec.shopAlias = await recipient("shop_alias", null, rec.shop);
    rec.employer = await recipient("employer", cat.salary);
    rec.misc = await recipient("misc");

    await txn("-10.0000", rec.shop); // groceries via recipient default
    await txn("-2.5000", rec.shopAlias); // groceries via the PRIMARY's default
    await txn("-4.0000", rec.misc, { categoryId: cat.food });
    await txn("-7.0000", rec.misc); // uncategorised
    await txn("1000.0000", rec.employer); // income
    await txn("-50.0000", rec.misc, { isTransfer: true });
    await txn("-99.0000", rec.misc, { isActive: false });
    await txn("-99.0000", rec.misc, { date: "1904-01-01" });
  }, 180_000);

  afterEach(async () => {
    await must(getTestPool(), "getTestPool()").query(
      "DELETE FROM user_settings WHERE key = 'includeTransfers'",
    );
  });

  afterAll(async () => {
    try {
      const db = must(getTestPool(), "getTestPool()");
      await db.query("DELETE FROM transactions WHERE id = ANY($1)", [
        created.transactionIds,
      ]);
      await db.query(
        "UPDATE recipients SET primary_recipient_id = NULL WHERE id = ANY($1)",
        [created.recipientIds],
      );
      await db.query("DELETE FROM recipients WHERE id = ANY($1)", [
        created.recipientIds,
      ]);
      for (const id of [...created.categoryIds].reverse()) {
        await db.query("DELETE FROM categories WHERE id = $1", [id]);
      }
    } finally {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    }
  });

  it("groups active non-transfer rows by effective category and direction", async () => {
    expect(totals(await getSankeyAggregates(RANGE))).toEqual({
      [`${cat.groceries}:out`]: "12.5000",
      [`${cat.food}:out`]: "4.0000",
      "none:out": "7.0000",
      [`${cat.salary}:in`]: "1000.0000",
    });
  });

  it("excludes a category with its whole subtree and a recipient with its aliases", async () => {
    expect(
      totals(
        await getSankeyAggregates({
          ...RANGE,
          excludedCategoryIds: [cat.food],
          excludedRecipientIds: [rec.employer],
        }),
      ),
    ).toEqual({ "none:out": "7.0000" });
    expect(
      totals(
        await getSankeyAggregates({ ...RANGE, excludedRecipientIds: [rec.shop] }),
      ),
    ).toEqual({
      [`${cat.food}:out`]: "4.0000",
      "none:out": "7.0000",
      [`${cat.salary}:in`]: "1000.0000",
    });
  });

  it("counts transfers only when the includeTransfers setting is on", async () => {
    await must(getTestPool(), "getTestPool()").query(
      `INSERT INTO user_settings (key, value) VALUES ('includeTransfers', 'true'::jsonb)`,
    );
    expect(totals(await getSankeyAggregates(RANGE))["none:out"]).toBe(
      "57.0000",
    );
  });
});
