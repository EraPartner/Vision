import { sql } from "kysely";
import { withTransaction } from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import {
  categoryActiveRowSchema,
  categoryMergeNodeRowSchema,
  categoryNextIdRowSchema,
  categoryNodeRowSchema,
  categoryReferenceRowSchema,
  categoryRowSchema,
  requireRow,
} from "../database/rows/catalog.ts";
import type { CategoryNodeRow } from "../database/rows/catalog.ts";
import { ConflictError, ValidationError } from "../middleware/errorHandler.ts";
import type { CategoryId } from "@vision/types/brands";
import { errorCode } from "../lib/errors.ts";

export interface CategoryNode {
  id: CategoryId;
  name: string;
  parentId: CategoryId | null;
  pathIds: CategoryId[];
  path: string[];
  category_name: string;
  depth: number;
  description: string | null;
  is_active: boolean;
  hierarchyOnly: boolean;
  legacyCompatible: boolean;
}

export interface CategoryNodeInput {
  name: string;
  parentId?: CategoryId | null | undefined;
  description?: string | null | undefined;
}

export interface CategoryNodePatch {
  name?: string | undefined;
  parentId?: CategoryId | null | undefined;
  description?: string | null | undefined;
  is_active?: boolean | undefined;
}

/** SQLSTATE of a pg error (`undefined` for anything else). */
function pgErrorCode(error: unknown): unknown {
  return errorCode(error);
}

/** A foreign key refused the write: 23503, or 23001 for a RESTRICT action. */
function isForeignKeyViolation(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code === "23503" || code === "23001";
}

function conflict(message: string, code = "CATEGORY_HIERARCHY_CONFLICT") {
  return new ConflictError(message, { details: { reason: code } });
}

function invalid(message: string) {
  return new ValidationError(message);
}

function mapNode(row: CategoryNodeRow): CategoryNode;
function mapNode(row: CategoryNodeRow | undefined): CategoryNode | null;
function mapNode(row: CategoryNodeRow | undefined): CategoryNode | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    pathIds: row.ids,
    path: row.names,
    category_name: row.path_name,
    depth: row.depth,
    description: row.description,
    is_active: row.is_active,
    hierarchyOnly: row.hierarchy_only,
    legacyCompatible: row.legacy_compatible,
  };
}

/**
 * `categories` joined to the `category_paths` view. The view's JSON arrays
 * have no declared type; the `::json` alias hints parse them.
 */
const NODE_SELECT = sql`
  SELECT c.id, c.name, c.parent_id,
         p.ids AS "ids::json", p.names AS "names::json",
         p.path_name, p.depth,
         c.description, c.is_active, c.hierarchy_only, c.legacy_compatible
    FROM categories c
    JOIN category_paths p ON p.id = c.id`;

/**
 * PostgreSQL's text[] order in the C collation: element by element, code
 * point by code point, a shorter prefix first.
 */
function compareNamePaths(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? "";
    const y = b[i] ?? "";
    if (x === y) continue;
    const xs = Array.from(x);
    const ys = Array.from(y);
    const m = Math.min(xs.length, ys.length);
    for (let j = 0; j < m; j++) {
      const d = (xs[j]?.codePointAt(0) ?? 0) - (ys[j]?.codePointAt(0) ?? 0);
      if (d !== 0) return d;
    }
    return xs.length - ys.length;
  }
  return a.length - b.length;
}

async function readNode(id: CategoryId): Promise<CategoryNode | null> {
  const row = await checkedRow(
    categoryNodeRowSchema,
    sql`${NODE_SELECT} WHERE c.id = ${id}`,
  );
  return mapNode(row);
}

/*
 * Hierarchy writes are serialised by their transaction: withTransaction() is
 * BEGIN IMMEDIATE on the single writer (ADR-263), which replaces the
 * PostgreSQL advisory lock and the FOR UPDATE row locks. Every check below
 * runs in the same transaction as the write it guards.
 */

async function requireActiveParent(parentId: CategoryId): Promise<void> {
  const parent = await checkedRow(
    categoryActiveRowSchema,
    db
      .selectFrom("categories")
      .select(["id", "is_active"])
      .where("id", "=", parentId),
  );
  if (!parent) throw invalid("Parent category does not exist");
  if (!parent.is_active) throw invalid("An inactive category cannot be a parent");
}

async function upsertRootAlias(
  general: string,
  targetId: CategoryId,
): Promise<void> {
  await db
    .insertInto("category_root_aliases")
    .values({ general, target_category_id: targetId })
    .onConflict((oc) =>
      oc.column("general").doUpdateSet((eb) => ({
        target_category_id: eb.ref("excluded.target_category_id"),
      })),
    )
    .execute();
}

export async function listCategoryNodes(): Promise<CategoryNode[]> {
  const rows = await checkedRows(categoryNodeRowSchema, NODE_SELECT);
  // ORDER BY p.names, c.id: the names arrive as JSON text, whose order is not
  // PostgreSQL's array order, so the rows are sorted here.
  rows.sort((a, b) => {
    const byPath = compareNamePaths(a.names, b.names);
    return byPath !== 0 ? byPath : a.id - b.id;
  });
  return rows.map((row) => mapNode(row));
}

export async function getCategoryNode(
  id: CategoryId,
): Promise<CategoryNode | null> {
  return readNode(id);
}

export async function createCategoryNode({
  name,
  parentId = null,
  description = null,
}: CategoryNodeInput): Promise<CategoryNode | null> {
  const normalized = name.trim().toUpperCase();
  if (!normalized || normalized.length > 100)
    throw invalid("Category name must contain 1 to 100 characters");
  return withTransaction(async () => {
    if (parentId !== null) {
      await requireActiveParent(parentId);
    } else {
      const reserved = await db
        .selectFrom("category_root_aliases")
        .select(sql<number>`1`.as("reserved"))
        .where("general", "=", normalized)
        .limit(1)
        .executeTakeFirst();
      if (reserved)
        throw conflict(
          "This root name is reserved by a legacy category redirect",
        );
    }
    // The row's `general` embeds its own id, so the id is drawn before the
    // INSERT, as nextval() drew it: the next AUTOINCREMENT value. This
    // transaction holds the write lock, so no other insert can take it, and
    // the explicit id advances sqlite_sequence like any insert.
    const nextId = requireRow(
      await checkedRow(
        categoryNextIdRowSchema,
        sql`SELECT max(
                 COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'categories'), 0),
                 COALESCE((SELECT max(id) FROM categories), 0)
               ) + 1 AS id`,
      ),
      "category next id",
    );
    const id = nextId.id;
    try {
      await db
        .insertInto("categories")
        .values({
          id,
          general: `__HIERARCHY_${id}`,
          detail: normalized,
          name: normalized,
          parent_id: parentId,
          description,
          hierarchy_only: false,
          legacy_compatible: false,
        })
        .execute();
    } catch (error) {
      if (pgErrorCode(error) === "23505")
        throw conflict(
          "A category with this name already exists under the parent",
        );
      throw error;
    }
    return readNode(id);
  });
}

export async function updateCategoryNode(
  id: CategoryId,
  { name, parentId, description, is_active: isActive }: CategoryNodePatch,
): Promise<CategoryNode | null> {
  return withTransaction(async () => {
    const existing = await checkedRow(
      categoryRowSchema,
      db.selectFrom("categories").selectAll().where("id", "=", id),
    );
    if (!existing) return null;
    if (name !== undefined && (!name.trim() || name.trim().length > 100))
      throw invalid("Category name must contain 1 to 100 characters");
    const nextParent = parentId === undefined ? existing.parent_id : parentId;
    const nextName =
      name === undefined ? existing.name : name.trim().toUpperCase();
    if (nextParent !== null) await requireActiveParent(nextParent);
    if (isActive === false) {
      const activeChild = await db
        .selectFrom("categories")
        .select("id")
        .where("parent_id", "=", id)
        .where("is_active", "=", true)
        .limit(1)
        .executeTakeFirst();
      if (activeChild)
        throw conflict(
          "Deactivate or move active children before deactivating a parent",
        );
    }
    try {
      await db
        .updateTable("categories")
        .set({
          name: nextName,
          parent_id: nextParent,
          description:
            description === undefined ? existing.description : description,
          is_active: isActive ?? existing.is_active,
          updated_at: sql<Date>`now()`,
        })
        .where("id", "=", id)
        .execute();
    } catch (error) {
      if (pgErrorCode(error) === "23505")
        throw conflict(
          "A category with this name already exists under the parent",
        );
      if (pgErrorCode(error) === "23514")
        throw conflict(
          "A category cannot be moved below itself or a descendant",
        );
      throw error;
    }
    if (existing.hierarchy_only) {
      if (
        existing.parent_id === null &&
        (nextName !== existing.name || nextParent !== null)
      ) {
        await upsertRootAlias(existing.name, id);
      }
      if (nextParent === null && nextName === existing.general) {
        await db
          .deleteFrom("category_root_aliases")
          .where("general", "=", existing.general)
          .where("target_category_id", "=", id)
          .execute();
      } else {
        await upsertRootAlias(existing.general, id);
      }
    }
    return readNode(id);
  });
}

export async function deleteCategoryNode(id: CategoryId): Promise<boolean> {
  return withTransaction(async () => {
    const existing = await db
      .selectFrom("categories")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    if (!existing) return false;
    const child = await db
      .selectFrom("categories")
      .select("id")
      .where("parent_id", "=", id)
      .limit(1)
      .executeTakeFirst();
    if (child)
      throw conflict("Move or delete children before deleting their parent");
    try {
      await db.deleteFrom("categories").where("id", "=", id).execute();
    } catch (error) {
      // A RESTRICT reference (a merge or root alias) raises 23001 on SQLite
      // (ADR-263); PostgreSQL raised 23503 for every foreign key.
      if (isForeignKeyViolation(error))
        throw conflict(
          "Category is still referenced or has legacy merge redirects",
        );
      throw error;
    }
    return true;
  });
}

/** Move every direct reference and child of source to target in one transaction.
 * Unique membership conflicts fail closed; callers can resolve them explicitly.
 */
export async function mergeCategoryNodes(
  sourceId: CategoryId,
  targetId: CategoryId,
): Promise<CategoryNode | null> {
  if (sourceId === targetId) throw invalid("Source and target must differ");
  return withTransaction(async () => {
    const nodes = await checkedRows(
      categoryMergeNodeRowSchema,
      db
        .selectFrom("categories")
        .select([
          "id",
          "is_active",
          "general",
          "detail",
          "legacy_compatible",
          "hierarchy_only",
        ])
        .where("id", "in", [sourceId, targetId])
        .orderBy("id"),
    );
    if (nodes.length !== 2) return null;
    if (!nodes.find((node) => node.id === targetId)?.is_active)
      throw invalid("Merge target must be active");
    // Two rows, the target among them and source !== target: the other row is
    // the source.
    const source = requireRow(
      nodes.find((node) => node.id === sourceId),
      "merge source category",
    );
    const targetBelowSource =
      (await db
        .selectFrom("category_ancestors")
        .select(sql<number>`1`.as("found"))
        .where("category_id", "=", targetId)
        .where("ancestor_id", "=", sourceId)
        .limit(1)
        .executeTakeFirst()) !== undefined;
    if (targetBelowSource)
      throw invalid("Merge target cannot be inside the source subtree");

    try {
      await db
        .updateTable("categories")
        .set({ parent_id: targetId })
        .where("parent_id", "=", sourceId)
        .execute();
      // Every single-column foreign key that references categories, from
      // the schema itself (the PostgreSQL version read pg_constraint).
      const references = await checkedRows(
        categoryReferenceRowSchema,
        sql`SELECT m.name AS table_name, fk."from" AS column_name
           FROM sqlite_schema m
           JOIN pragma_foreign_key_list(m.name) fk
           WHERE m.type = 'table'
             AND fk."table" = 'categories'
             AND m.name <> 'categories'
             AND m.name NOT IN ('category_merge_aliases', 'category_root_aliases')
             AND (SELECT count(*) FROM pragma_foreign_key_list(m.name) part
                   WHERE part.id = fk.id) = 1
           ORDER BY m.name, fk."from"`,
      );
      for (const ref of references) {
        const identifier = /^[a-z_][a-z0-9_]*$/;
        if (
          !identifier.test(ref.table_name) ||
          !identifier.test(ref.column_name)
        )
          throw conflict("Unsupported category reference identifier");
        const column = sql.ref(ref.column_name);
        await sql`UPDATE ${sql.table(ref.table_name)}
          SET ${column}=${targetId} WHERE ${column}=${sourceId}`.execute(db);
      }
      // Retain redirects through chains such as A -> B -> C. These rows also
      // have category foreign keys, but handling them explicitly documents
      // the invariant and avoids relying on the generic reference discovery.
      await db
        .updateTable("category_merge_aliases")
        .set({ target_category_id: targetId })
        .where("target_category_id", "=", sourceId)
        .execute();
      await db
        .updateTable("category_root_aliases")
        .set({ target_category_id: targetId })
        .where("target_category_id", "=", sourceId)
        .execute();
      if (source.legacy_compatible) {
        await db
          .insertInto("category_merge_aliases")
          .values({
            general: source.general,
            detail: source.detail,
            target_category_id: targetId,
          })
          .onConflict((oc) =>
            oc.columns(["general", "detail"]).doUpdateSet((eb) => ({
              target_category_id: eb.ref("excluded.target_category_id"),
            })),
          )
          .execute();
      }
      if (source.hierarchy_only) await upsertRootAlias(source.general, targetId);
      await db.deleteFrom("categories").where("id", "=", sourceId).execute();
    } catch (error) {
      if (pgErrorCode(error) === "23505")
        throw conflict(
          "Merge would duplicate a category membership or sibling name; resolve the conflict first",
        );
      throw error;
    }
    return readNode(targetId);
  });
}
