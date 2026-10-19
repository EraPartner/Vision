/**
 * Real-PostgreSQL behaviour of the flat (legacy) category repository and the
 * category hierarchy mutations: input normalization, filters, pagination,
 * legacy-only writes, and the hierarchy's refusal paths. Replaces mocked-pool
 * tests that asserted SQL text and client call order.
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
import categoryRepository from "../src/repositories/categoryRepository.ts";
import {
  createCategoryNode,
  deleteCategoryNode,
  getCategoryNode,
  mergeCategoryNodes,
  updateCategoryNode,
} from "../src/repositories/categoryHierarchyRepository.ts";
import {
  asCategoryId,
  asRecipientId,
} from "@vision/types/brands";
import type { CategoryId } from "@vision/types/brands";

const SUFFIX = `CB${process.pid}`;
const created = {
  categoryIds: [] as number[],
  recipientIds: [] as number[],
  accountIds: [] as number[],
  transactionIds: [] as number[],
};

async function legacy(general: string, detail: string, description?: string) {
  const result = await categoryRepository.createOrGet({
    general,
    detail,
    description,
  });
  created.categoryIds.push(result.category!.id);
  return result.category!;
}

async function node(name: string, parentId?: CategoryId) {
  const createdNode = (await createCategoryNode({
    name,
    ...(parentId === undefined ? {} : { parentId }),
  }))!;
  created.categoryIds.push(createdNode.id);
  return createdNode;
}

async function categoryExists(id: number) {
  const { rows } = await getTestPool()!.query(
    "SELECT 1 FROM categories WHERE id = $1",
    [id],
  );
  return rows.length === 1;
}

describe.skipIf(!hasTestDatabase())("categories (real DB)", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
    await acquireDbSuiteLock();
  }, 180_000);

  afterEach(async () => {
    const db = getTestPool()!;
    await db.query("DELETE FROM transactions WHERE id = ANY($1::int[])", [
      created.transactionIds.splice(0),
    ]);
    await db.query("DELETE FROM accounts WHERE id = ANY($1::int[])", [
      created.accountIds.splice(0),
    ]);
    await db.query("DELETE FROM recipients WHERE id = ANY($1::int[])", [
      created.recipientIds.splice(0),
    ]);
    const ids = created.categoryIds.splice(0);
    await db.query(
      "DELETE FROM category_merge_aliases WHERE target_category_id = ANY($1::int[])",
      [ids],
    );
    await db.query(
      "DELETE FROM category_root_aliases WHERE target_category_id = ANY($1::int[])",
      [ids],
    );
    // Children before parents (the self-reference is restrictive).
    for (const id of ids.reverse()) {
      await db.query("DELETE FROM categories WHERE id = $1", [id]);
    }
  });

  afterAll(async () => {
    try {
      await releaseDbSuiteLock();
    } finally {
      await closeTestPool();
      await closePool();
    }
  });

  it("normalizes created and updated legacy categories and returns existing ones", async () => {
    const first = await categoryRepository.createOrGet({
      general: `  food${SUFFIX} `,
      detail: " groceries  ",
      description: "Weekly groceries",
    });
    created.categoryIds.push(first.category!.id);
    expect(first).toMatchObject({
      created: true,
      category: {
        general: `FOOD${SUFFIX}`,
        detail: "GROCERIES",
        category_name: `FOOD${SUFFIX}:GROCERIES`,
      },
    });
    const again = await categoryRepository.createOrGet({
      general: `FOOD${SUFFIX}`,
      detail: "groceries",
      description: "ignored on conflict",
    });
    expect(again).toMatchObject({
      created: false,
      category: { id: first.category!.id, description: "Weekly groceries" },
    });

    const updated = await categoryRepository.update(first.category!.id, {
      general: ` utilities${SUFFIX} `,
      detail: " water ",
      description: "Water bill",
      is_active: true,
    });
    expect(updated).toMatchObject({
      general: `UTILITIES${SUFFIX}`,
      detail: "WATER",
      category_name: `UTILITIES${SUFFIX}:WATER`,
    });
    // No patchable field: the current row comes back unchanged.
    expect(
      (await categoryRepository.update(first.category!.id, {}))?.detail,
    ).toBe("WATER");
    expect(await categoryRepository.getById(asCategoryId(-1))).toBeNull();
  });

  it("filters, counts and pages legacy categories case-insensitively", async () => {
    const general = `HOME${SUFFIX}`;
    const rent = await legacy(general, "RENT", "Monthly rent");
    const repairs = await legacy(general, "REPAIRS", "Plumber");
    const archived = await legacy(general, "ARCHIVED", "Old monthly fee");
    await categoryRepository.update(archived.id, { is_active: false });

    const ids = async (
      filters: Parameters<typeof categoryRepository.getAll>[0],
    ) => (await categoryRepository.getAll(filters)).map((row) => row.id);

    const lowerGeneral = general.toLowerCase().slice(0, -2);
    expect(await ids({ general: lowerGeneral })).toEqual([rent.id, repairs.id]);
    expect(await ids({ general: lowerGeneral, detail: "ren" })).toEqual([
      rent.id,
    ]);
    expect(await ids({ general, search: "month" })).toEqual([rent.id]);
    expect(await ids({ general, search: "month", active: false })).toEqual([
      archived.id,
      rent.id,
    ]);
    expect(await categoryRepository.getCount({ general })).toBe(2);
    expect(await categoryRepository.getCount({ general, active: false })).toBe(
      3,
    );
    expect(await ids({ general, active: false, limit: 1, offset: 1 })).toEqual([
      rent.id,
    ]);

    expect(
      (
        await categoryRepository.getActiveByIds([rent.id, rent.id, archived.id])
      ).map((row) => row.id),
    ).toEqual([rent.id]);
  });

  it("keeps hierarchy-only nodes out of the legacy update and delete paths", async () => {
    const root = await node(`ROOT${SUFFIX}`);
    expect(
      await categoryRepository.update(root.id, { general: "OTHER" }),
    ).toBeNull();
    expect(await categoryRepository.hardDelete(root.id)).toBe(false);
    expect(await categoryExists(root.id)).toBe(true);

    const removable = await legacy(`DEL${SUFFIX}`, "ONE");
    expect(await categoryRepository.hardDelete(removable.id)).toBe(true);
    expect(await categoryExists(removable.id)).toBe(false);
  });

  it("assigns a default category to recipients and reports the count", async () => {
    const category = await legacy(`ASSIGN${SUFFIX}`, "ONE");
    const db = getTestPool()!;
    const { rows } = await db.query(
      `INSERT INTO recipients (name, normalized_name)
       VALUES ($1, lower($1)), ($2, lower($2)) RETURNING id`,
      [`Assign A ${SUFFIX}`, `Assign B ${SUFFIX}`],
    );
    const recipientIds = rows.map((row) => row.id as number);
    created.recipientIds.push(...recipientIds);

    expect(
      await categoryRepository.assignToRecipients(category.id, recipientIds.map(asRecipientId)),
    ).toBe(2);
    const { rows: after } = await db.query(
      "SELECT default_category_id FROM recipients WHERE id = ANY($1::int[])",
      [recipientIds],
    );
    expect(after.map((row) => row.default_category_id)).toEqual([
      category.id,
      category.id,
    ]);
    await db.query(
      "UPDATE recipients SET default_category_id = NULL WHERE id = ANY($1::int[])",
      [recipientIds],
    );
  });

  it("creates normalized hierarchy nodes and refuses invalid structure changes", async () => {
    const root = await node(`savings${SUFFIX}`);
    expect(root).toMatchObject({
      path: [`SAVINGS${SUFFIX}`],
      pathIds: [root.id],
      depth: 1,
    });
    await expect(
      createCategoryNode({ name: "solar", parentId: asCategoryId(-1) }),
    ).rejects.toThrow("Parent category does not exist");

    const child = await node("CHILD", root.id);
    await expect(deleteCategoryNode(root.id)).rejects.toThrow(
      "Move or delete children",
    );
    expect(await categoryExists(root.id)).toBe(true);

    await expect(
      updateCategoryNode(root.id, { parentId: child.id }),
    ).rejects.toThrow("cannot be moved");
    await expect(mergeCategoryNodes(root.id, child.id)).rejects.toThrow(
      "inside the source subtree",
    );
    expect((await getCategoryNode(child.id))?.parentId).toBe(root.id);
  });

  it("merges a node by moving its children and references to the target", async () => {
    const source = await node(`SOURCE${SUFFIX}`);
    const target = await node(`TARGET${SUFFIX}`);
    const child = await node("CHILD", source.id);

    const db = getTestPool()!;
    const { rows: accountRows } = await db.query(
      `INSERT INTO accounts (name, display_name, currency)
       VALUES ($1, $1, 'EUR') RETURNING id`,
      [`Merge Account ${SUFFIX}`],
    );
    created.accountIds.push(accountRows[0].id);
    const { rows: recipientRows } = await db.query(
      `INSERT INTO recipients (name, normalized_name)
       VALUES ($1, lower($1)) RETURNING id`,
      [`Merge Recipient ${SUFFIX}`],
    );
    created.recipientIds.push(recipientRows[0].id);
    const { rows: txRows } = await db.query(
      `INSERT INTO transactions (date, amount, currency, recipient_id, category_id, account_id)
       VALUES (CURRENT_DATE, -12.34, 'EUR', $1, $2, $3) RETURNING id`,
      [recipientRows[0].id, source.id, accountRows[0].id],
    );
    created.transactionIds.push(txRows[0].id);

    const merged = await mergeCategoryNodes(source.id, target.id);
    expect(merged?.id).toBe(target.id);
    created.categoryIds.splice(created.categoryIds.indexOf(source.id), 1);

    expect(await categoryExists(source.id)).toBe(false);
    expect((await getCategoryNode(child.id))?.parentId).toBe(target.id);
    const { rows: tx } = await db.query(
      "SELECT category_id FROM transactions WHERE id = $1",
      [txRows[0].id],
    );
    expect(tx[0].category_id).toBe(target.id);
    // Children are deleted before parents in cleanup: put the moved child last.
    created.categoryIds.splice(created.categoryIds.indexOf(child.id), 1);
    created.categoryIds.push(child.id);
  });
});
