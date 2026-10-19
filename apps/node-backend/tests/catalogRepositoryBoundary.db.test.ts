/**
 * Real-PostgreSQL behaviour of the tag, watchlist, saved-chart and recipient
 * repositories. Replaces the mocked-pool suites (tagRepository.test.ts,
 * watchlistRepository.test.ts, savedChartsRepository.test.ts and the SQL-text
 * cases of recipientRepository.test.ts) that asserted the SQL strings sent to
 * a fake client: these tests assert the rows Postgres returns instead.
 *
 * Isolation: every fixture carries a per-process suffix and is deleted by id
 * in afterAll; other suites' rows may exist, so assertions filter to our ids.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { createCategoryNode } from "../src/repositories/categoryHierarchyRepository.ts";
import recipientRepository from "../src/repositories/recipientRepository.ts";
import savedChartsRepository from "../src/repositories/savedChartsRepository.ts";
import tagRepository from "../src/repositories/tagRepository.ts";
import watchlistRepository from "../src/repositories/watchlistRepository.ts";
import {
  asRecipientId,
  asTagId,
} from "@vision/types/brands";

const SUFFIX = `CRB${process.pid}`;
const created = {
  categoryIds: [] as number[],
  recipientIds: [] as number[],
  tagIds: [] as number[],
  chartIds: [] as number[],
  watchlistIds: [] as number[],
  transactionIds: [] as number[],
};

async function insertRecipient(
  name: string,
  defaultCategoryId: number | null = null,
): Promise<number> {
  const { rows } = await getTestPool()!.query(
    `INSERT INTO recipients (name, normalized_name, default_category_id)
     VALUES ($1, lower($1), $2) RETURNING id`,
    [name, defaultCategoryId],
  );
  created.recipientIds.push(rows[0].id);
  return rows[0].id;
}

async function insertTransaction(
  recipientId: number,
  { isActive = true, isTransfer = false } = {},
): Promise<number> {
  const { rows } = await getTestPool()!.query(
    `INSERT INTO transactions (date, amount, currency, recipient_id, memo, is_active, is_transfer)
     VALUES ('2026-02-01', '-10.0000', 'EUR', $1, $2, $3, $4) RETURNING id`,
    [recipientId, SUFFIX, isActive, isTransfer],
  );
  created.transactionIds.push(rows[0].id);
  return rows[0].id;
}

describe.skipIf(!hasTestDatabase())(
  "catalog repositories against PostgreSQL",
  () => {
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180_000);

    afterAll(async () => {
      try {
        const db = getTestPool()!;
        await db.query("DELETE FROM transactions WHERE id = ANY($1)", [
          created.transactionIds,
        ]);
        await db.query("DELETE FROM saved_charts WHERE id = ANY($1)", [
          created.chartIds,
        ]);
        await db.query("DELETE FROM saved_charts WHERE name LIKE $1", [
          `%${SUFFIX}%`,
        ]);
        await db.query("DELETE FROM watchlist WHERE id = ANY($1)", [
          created.watchlistIds,
        ]);
        await db.query("DELETE FROM tags WHERE id = ANY($1)", [created.tagIds]);
        await db.query("DELETE FROM recipients WHERE id = ANY($1)", [
          created.recipientIds,
        ]);
        await db.query("DELETE FROM recipients WHERE normalized_name LIKE $1", [
          `%${SUFFIX.toLowerCase()}%`,
        ]);
        for (const id of [...created.categoryIds].reverse()) {
          await db.query("DELETE FROM categories WHERE id = $1", [id]);
        }
      } finally {
        try {
          await releaseDbSuiteLock();
        } finally {
          try {
            await closeTestPool();
          } finally {
            await closePool();
          }
        }
      }
    });

    describe("tags", () => {
      it("filters by active state, orders by slug, and counts the same set", async () => {
        const slugs = [`b-${SUFFIX}`, `a-${SUFFIX}`, `c-${SUFFIX}`].map((s) =>
          s.toLowerCase(),
        );
        for (const slug of slugs) {
          const { tag } = await tagRepository.findOrCreateBySlug(slug);
          created.tagIds.push(tag.id);
        }
        const inactive = await tagRepository.getBySlug(slugs[2]!);
        await tagRepository.softDelete(inactive!.id);

        const ours = (rows: { id: number; slug: string }[]) =>
          rows.filter((row) => created.tagIds.includes(row.id));

        expect(
          ours(await tagRepository.getAll({ active: true })).map((t) => t.slug),
        ).toEqual([slugs[1], slugs[0]]);
        expect(
          ours(await tagRepository.getAll({ active: false })).map((t) => t.slug),
        ).toEqual([slugs[2]]);
        expect(
          ours(await tagRepository.getAll({ active: null })).map((t) => t.slug),
        ).toEqual([slugs[1], slugs[0], slugs[2]]);

        const all = await tagRepository.getCount({ active: null });
        expect(await tagRepository.getCount({ active: true })).toBe(
          all - (await tagRepository.getCount({ active: false })),
        );
      });

      it("returns no rows for an empty slug list and null for a missing tag", async () => {
        expect(await tagRepository.getManyBySlugs([])).toEqual([]);
        expect(await tagRepository.update(asTagId(2_000_000_000), { color: null })).toBe(
          null,
        );
        expect(await tagRepository.softDelete(asTagId(2_000_000_000))).toBeNull();
      });
    });

    describe("watchlist", () => {
      it("filters by asset class and ignores non-allowlisted update fields", async () => {
        const stock = await watchlistRepository.create({
          name: `Stock ${SUFFIX}`,
          asset_class: "stock",
          target_price: 5,
        });
        const crypto = await watchlistRepository.create({
          name: `Crypto ${SUFFIX}`,
          asset_class: "crypto",
          target_price: 7,
        });
        created.watchlistIds.push(stock.id, crypto.id);

        expect(stock).toMatchObject({ currency: "EUR", notes: null });
        const cryptoIds = (
          await watchlistRepository.getAll({ assetClass: "crypto", limit: 500 })
        ).map((row) => row.id);
        expect(cryptoIds).toContain(crypto.id);
        expect(cryptoIds).not.toContain(stock.id);
        const page = await watchlistRepository.getAllWithCount({
          assetClass: "crypto",
          limit: 500,
        });
        expect(page.rows.map((row) => row.id)).toContain(crypto.id);
        expect(page.total).toBe(
          await watchlistRepository.getCount({ assetClass: "crypto" }),
        );

        const updated = await watchlistRepository.update(stock.id, {
          name: `Renamed ${SUFFIX}`,
          id: crypto.id,
          forbidden: "x",
          notes: undefined,
        });
        expect(updated).toMatchObject({
          id: stock.id,
          name: `Renamed ${SUFFIX}`,
          notes: null,
        });
        expect(await watchlistRepository.getById(crypto.id)).toMatchObject({
          name: `Crypto ${SUFFIX}`,
        });
        expect(
          await watchlistRepository.update(stock.id, { forbidden: "x" }),
        ).toMatchObject({ id: stock.id, name: `Renamed ${SUFFIX}` });
        expect(
          await watchlistRepository.update(2_000_000_000, { name: "X" }),
        ).toBeNull();

        expect(await watchlistRepository.delete(crypto.id)).toBe(true);
        expect(await watchlistRepository.delete(crypto.id)).toBe(false);
      });
    });

    describe("saved charts", () => {
      it("stores deduplicated sorted memberships and patches only the sets given", async () => {
        const root = await createCategoryNode({ name: `CHART${SUFFIX}` });
        const a = await createCategoryNode({ name: "A", parentId: root!.id });
        const b = await createCategoryNode({ name: "B", parentId: root!.id });
        created.categoryIds.push(root!.id, a!.id, b!.id);
        const { tag } = await tagRepository.findOrCreateBySlug(
          `chart-${SUFFIX}`.toLowerCase(),
        );
        created.tagIds.push(tag.id);

        const chart = await savedChartsRepository.create({
          name: `Spending ${SUFFIX}`,
          chartType: "bar",
          categoryIds: [b!.id, a!.id, b!.id],
          recipientIds: [],
          tagIds: [tag.id],
          chartVariant: "default",
          timeBucket: "monthly",
        });
        created.chartIds.push(chart!.id);
        expect(chart).toMatchObject({
          category_ids: [a!.id, b!.id].sort((x, y) => x - y),
          recipient_ids: [],
          tag_ids: [tag.id],
        });

        const patched = await savedChartsRepository.update(chart!.id, {
          categoryIds: [b!.id, b!.id],
        });
        expect(patched).toMatchObject({
          name: `Spending ${SUFFIX}`,
          category_ids: [b!.id],
          tag_ids: [tag.id],
        });
        expect(await savedChartsRepository.getById(chart!.id)).toEqual(patched);
        expect(
          await savedChartsRepository.update(2_000_000_000, { name: "X" }),
        ).toBeNull();
      });

      it("leaves no chart behind when a membership insert fails", async () => {
        const name = `Invalid ${SUFFIX}`;
        await expect(
          savedChartsRepository.create({
            name,
            chartType: "line",
            categoryIds: [2_000_000_000],
            chartVariant: "default",
            timeBucket: "monthly",
          }),
        ).rejects.toMatchObject({ code: "23503" });
        const { rows } = await getTestPool()!.query(
          "SELECT id FROM saved_charts WHERE name = $1",
          [name],
        );
        expect(rows).toEqual([]);
      });
    });

    describe("recipients", () => {
      it("createOrGet upper-cases and reports whether it created the row", async () => {
        const first = await recipientRepository.createOrGet({
          name: `  shop ${SUFFIX} `,
        });
        created.recipientIds.push(first.recipient!.id);
        expect(first.created).toBe(true);
        expect(first.recipient!.name).toBe(`SHOP ${SUFFIX}`);

        const again = await recipientRepository.createOrGet({
          name: `Shop ${SUFFIX}`,
        });
        expect(again).toMatchObject({
          created: false,
          recipient: { id: first.recipient!.id },
        });
        expect(
          (await recipientRepository.getByName(`  SHOP ${SUFFIX}`))?.id,
        ).toBe(first.recipient!.id);
      });

      it("update writes the upper-cased name and keeps lookups by name working", async () => {
        const id = await insertRecipient(`Old ${SUFFIX}`);
        const updated = await recipientRepository.update(asRecipientId(id), {
          name: `new ${SUFFIX}`,
          notes: "hi",
          is_active: false,
        });
        expect(updated).toMatchObject({
          id,
          name: `NEW ${SUFFIX}`,
          notes: "hi",
          is_active: false,
        });
        expect((await recipientRepository.getByName(`New ${SUFFIX}`))?.id).toBe(
          id,
        );
        expect(await recipientRepository.update(asRecipientId(id), {})).toMatchObject({ id });
      });

      it("filters by category subtree and by the uncategorised-with-activity queue", async () => {
        const root = await createCategoryNode({ name: `RCP${SUFFIX}` });
        const child = await createCategoryNode({
          name: "CHILD",
          parentId: root!.id,
        });
        const other = await createCategoryNode({ name: `OTHER${SUFFIX}` });
        created.categoryIds.push(root!.id, child!.id, other!.id);

        const underRoot = await insertRecipient(`Root ${SUFFIX}`, root!.id);
        const underChild = await insertRecipient(`Child ${SUFFIX}`, child!.id);
        const elsewhere = await insertRecipient(`Other ${SUFFIX}`, other!.id);
        const uncategorisedActive = await insertRecipient(`Busy ${SUFFIX}`);
        const uncategorisedIdle = await insertRecipient(`Idle ${SUFFIX}`);
        const uncategorisedTransfer = await insertRecipient(
          `Transfer ${SUFFIX}`,
        );
        const categorisedActive = await insertRecipient(
          `Categorised ${SUFFIX}`,
          other!.id,
        );
        await insertTransaction(uncategorisedActive);
        await insertTransaction(uncategorisedIdle, { isActive: false });
        await insertTransaction(uncategorisedTransfer, { isTransfer: true });
        await insertTransaction(categorisedActive);

        const ids = async (filters: Record<string, unknown>) =>
          (
            await recipientRepository.getAll({
              ...filters,
              search: SUFFIX,
              limit: 500,
            })
          ).map((row) => row.id);

        expect(new Set(await ids({ defaultCategoryId: root!.id }))).toEqual(
          new Set([underRoot, underChild]),
        );
        expect(
          await recipientRepository.getCount({
            defaultCategoryId: root!.id,
            search: SUFFIX,
          }),
        ).toBe(2);
        expect(
          await ids({ uncategorized: true, defaultCategoryId: other!.id }),
        ).toEqual([uncategorisedActive]);
        expect(await ids({ defaultCategoryId: other!.id })).not.toContain(
          underRoot,
        );
        expect(await ids({ defaultCategoryId: other!.id })).toContain(
          elsewhere,
        );
      });

      it("falls back to name order for an unknown sort column", async () => {
        await insertRecipient(`Zed ${SUFFIX}`);
        await insertRecipient(`Abe ${SUFFIX}`);
        const byName = (
          await recipientRepository.getAll({ search: SUFFIX, limit: 500 })
        ).map((row) => row.id);
        expect(byName.length).toBeGreaterThanOrEqual(2);
        const unknownSort = (
          await recipientRepository.getAll({
            search: SUFFIX,
            sortBy: "evil; DROP TABLE recipients",
            sortDir: "desc",
            limit: 500,
          })
        ).map((row) => row.id);
        expect(unknownSort).toEqual(byName);
      });
    });
  },
);
