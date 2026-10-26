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
import { asCategoryId } from "@vision/types/brands";
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

function selectNodes() {
  return db
    .selectFrom("categories as c")
    .innerJoin("category_paths as p", "p.id", "c.id")
    .select([
      "c.id",
      "c.name",
      "c.parent_id",
      "p.ids",
      "p.names",
      "p.path_name",
      "p.depth",
      "c.description",
      "c.is_active",
      "c.hierarchy_only",
      "c.legacy_compatible",
    ]);
}

async function readNode(id: CategoryId): Promise<CategoryNode | null> {
  const row = await checkedRow(
    categoryNodeRowSchema,
    selectNodes().where("c.id", "=", id),
  );
  return mapNode(row);
}

/** Serialises hierarchy writes: one transaction-scoped advisory lock. */
async function lockHierarchy(): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(1128356178, 1)`.execute(db);
}

async function requireActiveParent(parentId: CategoryId): Promise<void> {
  const parent = await checkedRow(
    categoryActiveRowSchema,
    db
      .selectFrom("categories")
      .select(["id", "is_active"])
      .where("id", "=", parentId)
      .forUpdate(),
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
  const rows = await checkedRows(
    categoryNodeRowSchema,
    selectNodes().orderBy("p.names").orderBy("c.id"),
  );
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
    await lockHierarchy();
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
    const nextId = requireRow(
      await checkedRow(
        categoryNextIdRowSchema,
        sql`SELECT nextval(pg_get_serial_sequence('categories','id')) AS id`,
      ),
      "category nextval",
    );
    // categories.id is a serial INTEGER, so the BIGINT nextval fits a number.
    const id = asCategoryId(Number(nextId.id));
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
    await lockHierarchy();
    const existing = await checkedRow(
      categoryRowSchema,
      db.selectFrom("categories").selectAll().where("id", "=", id).forUpdate(),
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
          updated_at: sql<Date>`NOW()`,
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
      .forUpdate()
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
      if (pgErrorCode(error) === "23503")
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
    await lockHierarchy();
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
        .orderBy("id")
        .forUpdate(),
    );
    if (nodes.length !== 2) return null;
    if (!nodes.find((node) => node.id === targetId)?.is_active)
      throw invalid("Merge target must be active");
    // Two locked rows, the target among them and source !== target: the other
    // row is the source.
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
      const references = await checkedRows(
        categoryReferenceRowSchema,
        sql`SELECT ns.nspname AS schema_name, rel.relname AS table_name,
                  att.attname AS column_name
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid=con.conrelid
           JOIN pg_namespace ns ON ns.oid=rel.relnamespace
           JOIN pg_attribute att ON att.attrelid=con.conrelid
                                AND att.attnum=con.conkey[1]
           WHERE con.contype='f' AND con.confrelid='categories'::regclass
             AND cardinality(con.conkey)=1
             AND con.conrelid <> 'categories'::regclass
             AND rel.relname NOT IN ('category_merge_aliases','category_root_aliases')`,
      );
      for (const ref of references) {
        if (ref.schema_name !== "public")
          throw conflict("Category reference exists outside the public schema");
        const identifier = /^[a-z_][a-z0-9_]*$/;
        if (
          !identifier.test(ref.table_name) ||
          !identifier.test(ref.column_name)
        )
          throw conflict("Unsupported category reference identifier");
        const column = sql.ref(ref.column_name);
        await sql`UPDATE ${sql.table(`public.${ref.table_name}`)}
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
