import { query, withTransaction } from "../database/connection.ts";
import { ConflictError, ValidationError } from "../middleware/errorHandler.ts";

/** A `NODE_SELECT` row: `categories` joined to the `category_paths` view. */
interface CategoryNodeRow {
  id: number;
  name: string;
  parent_id: number | null;
  ids: number[];
  names: string[];
  path_name: string;
  depth: number;
  description: string | null;
  is_active: boolean;
  hierarchy_only: boolean;
  legacy_compatible: boolean;
}

export interface CategoryNode {
  id: number;
  name: string;
  parentId: number | null;
  pathIds: number[];
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
  parentId?: number | null;
  description?: string | null;
}

export interface CategoryNodePatch {
  name?: string;
  parentId?: number | null;
  description?: string | null;
  is_active?: boolean;
}

/** The `categories` columns the update path reads from its `SELECT *`. */
interface CategoryLockRow {
  parent_id: number | null;
  name: string;
  general: string;
  description: string | null;
  is_active: boolean;
  hierarchy_only: boolean;
}

interface MergeNodeRow {
  id: number;
  is_active: boolean;
  general: string;
  detail: string;
  legacy_compatible: boolean;
  hierarchy_only: boolean;
}

interface CategoryReferenceRow {
  schema_name: string;
  table_name: string;
  column_name: string;
}

/** SQLSTATE of a pg error (`undefined` for anything else). */
function pgErrorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null | undefined)?.code;
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

const NODE_SELECT = `SELECT c.id,c.name,c.parent_id,p.ids,p.names,p.path_name,p.depth,
  c.description,c.is_active,c.hierarchy_only,c.legacy_compatible
  FROM categories c JOIN category_paths p ON p.id=c.id`;

export async function listCategoryNodes(): Promise<CategoryNode[]> {
  const result = await query<CategoryNodeRow>(
    `${NODE_SELECT} ORDER BY p.names,c.id`,
  );
  return result.rows.map((row) => mapNode(row));
}

export async function getCategoryNode(
  id: number,
): Promise<CategoryNode | null> {
  const result = await query<CategoryNodeRow>(`${NODE_SELECT} WHERE c.id=$1`, [
    id,
  ]);
  return mapNode(result.rows[0]);
}

export async function createCategoryNode({
  name,
  parentId = null,
  description = null,
}: CategoryNodeInput): Promise<CategoryNode | null> {
  const normalized = name.trim().toUpperCase();
  if (!normalized || normalized.length > 100)
    throw invalid("Category name must contain 1 to 100 characters");
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(1128356178, 1)");
    if (parentId !== null) {
      const parent = (
        await client.query(
          `SELECT id,is_active FROM categories WHERE id=$1 FOR UPDATE`,
          [parentId],
        )
      ).rows[0];
      if (!parent) throw invalid("Parent category does not exist");
      if (!parent.is_active)
        throw invalid("An inactive category cannot be a parent");
    } else {
      const reserved = (
        await client.query(
          "SELECT 1 FROM category_root_aliases WHERE general=$1 LIMIT 1",
          [normalized],
        )
      ).rows[0];
      if (reserved)
        throw conflict(
          "This root name is reserved by a legacy category redirect",
        );
    }
    const id: string = (
      await client.query(
        `SELECT nextval(pg_get_serial_sequence('categories','id')) AS id`,
      )
    ).rows[0].id;
    try {
      await client.query(
        `INSERT INTO categories
          (id,general,detail,name,parent_id,description,hierarchy_only,legacy_compatible)
         VALUES ($1,$2,$3,$4,$5,$6,false,false)`,
        [
          id,
          `__HIERARCHY_${id}`,
          normalized,
          normalized,
          parentId,
          description,
        ],
      );
    } catch (error) {
      if (pgErrorCode(error) === "23505")
        throw conflict(
          "A category with this name already exists under the parent",
        );
      throw error;
    }
    const created: CategoryNodeRow | undefined = (
      await client.query(`${NODE_SELECT} WHERE c.id=$1`, [id])
    ).rows[0];
    return mapNode(created);
  });
}

export async function updateCategoryNode(
  id: number,
  { name, parentId, description, is_active: isActive }: CategoryNodePatch,
): Promise<CategoryNode | null> {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(1128356178, 1)");
    const existing: CategoryLockRow | undefined = (
      await client.query(`SELECT * FROM categories WHERE id=$1 FOR UPDATE`, [
        id,
      ])
    ).rows[0];
    if (!existing) return null;
    if (name !== undefined && (!name.trim() || name.trim().length > 100))
      throw invalid("Category name must contain 1 to 100 characters");
    const nextParent = parentId === undefined ? existing.parent_id : parentId;
    const nextName =
      name === undefined ? existing.name : name.trim().toUpperCase();
    if (nextParent !== null) {
      const parent = (
        await client.query(
          `SELECT id,is_active FROM categories WHERE id=$1 FOR UPDATE`,
          [nextParent],
        )
      ).rows[0];
      if (!parent) throw invalid("Parent category does not exist");
      if (!parent.is_active)
        throw invalid("An inactive category cannot be a parent");
    }
    if (isActive === false) {
      const activeChild = (
        await client.query(
          `SELECT id FROM categories WHERE parent_id=$1 AND is_active=true LIMIT 1`,
          [id],
        )
      ).rows[0];
      if (activeChild)
        throw conflict(
          "Deactivate or move active children before deactivating a parent",
        );
    }
    try {
      await client.query(
        `UPDATE categories
         SET name=$2,parent_id=$3,description=$4,is_active=$5,updated_at=NOW()
         WHERE id=$1`,
        [
          id,
          nextName,
          nextParent,
          description === undefined ? existing.description : description,
          isActive === undefined ? existing.is_active : isActive,
        ],
      );
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
        await client.query(
          `INSERT INTO category_root_aliases (general,target_category_id)
           VALUES ($1,$2) ON CONFLICT (general) DO UPDATE
           SET target_category_id=EXCLUDED.target_category_id`,
          [existing.name, id],
        );
      }
      if (nextParent === null && nextName === existing.general) {
        await client.query(
          "DELETE FROM category_root_aliases WHERE general=$1 AND target_category_id=$2",
          [existing.general, id],
        );
      } else {
        await client.query(
          `INSERT INTO category_root_aliases (general,target_category_id)
           VALUES ($1,$2) ON CONFLICT (general) DO UPDATE
           SET target_category_id=EXCLUDED.target_category_id`,
          [existing.general, id],
        );
      }
    }
    const updated: CategoryNodeRow | undefined = (
      await client.query(`${NODE_SELECT} WHERE c.id=$1`, [id])
    ).rows[0];
    return mapNode(updated);
  });
}

export async function deleteCategoryNode(id: number): Promise<boolean> {
  return withTransaction(async (client) => {
    const existing = (
      await client.query(`SELECT id FROM categories WHERE id=$1 FOR UPDATE`, [
        id,
      ])
    ).rows[0];
    if (!existing) return false;
    const child = (
      await client.query(
        `SELECT id FROM categories WHERE parent_id=$1 LIMIT 1`,
        [id],
      )
    ).rows[0];
    if (child)
      throw conflict("Move or delete children before deleting their parent");
    try {
      await client.query(`DELETE FROM categories WHERE id=$1`, [id]);
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
  sourceId: number,
  targetId: number,
): Promise<CategoryNode | null> {
  if (sourceId === targetId) throw invalid("Source and target must differ");
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(1128356178, 1)");
    const nodes: MergeNodeRow[] = (
      await client.query(
        `SELECT id,is_active,general,detail,legacy_compatible,hierarchy_only
         FROM categories WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE`,
        [[sourceId, targetId]],
      )
    ).rows;
    if (nodes.length !== 2) return null;
    if (!nodes.find((node) => node.id === targetId)?.is_active)
      throw invalid("Merge target must be active");
    // Two locked rows, the target among them and source !== target: the other
    // row is the source.
    const source = nodes.find((node) => node.id === sourceId)!;
    const targetBelowSource =
      (
        await client.query(
          `SELECT 1 FROM category_ancestors
         WHERE category_id=$1 AND ancestor_id=$2 LIMIT 1`,
          [targetId, sourceId],
        )
      ).rows.length > 0;
    if (targetBelowSource)
      throw invalid("Merge target cannot be inside the source subtree");

    try {
      await client.query(
        `UPDATE categories SET parent_id=$2 WHERE parent_id=$1`,
        [sourceId, targetId],
      );
      const references: CategoryReferenceRow[] = (
        await client.query(
          `SELECT ns.nspname AS schema_name, rel.relname AS table_name,
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
        )
      ).rows;
      for (const ref of references) {
        if (ref.schema_name !== "public")
          throw conflict("Category reference exists outside the public schema");
        const identifier = /^[a-z_][a-z0-9_]*$/;
        if (
          !identifier.test(ref.table_name) ||
          !identifier.test(ref.column_name)
        )
          throw conflict("Unsupported category reference identifier");
        await client.query(
          `UPDATE public."${ref.table_name}" SET "${ref.column_name}"=$2 WHERE "${ref.column_name}"=$1`,
          [sourceId, targetId],
        );
      }
      // Retain redirects through chains such as A -> B -> C. These rows also
      // have category foreign keys, but handling them explicitly documents
      // the invariant and avoids relying on the generic reference discovery.
      await client.query(
        `UPDATE category_merge_aliases SET target_category_id=$2 WHERE target_category_id=$1`,
        [sourceId, targetId],
      );
      await client.query(
        `UPDATE category_root_aliases SET target_category_id=$2 WHERE target_category_id=$1`,
        [sourceId, targetId],
      );
      if (source.legacy_compatible) {
        await client.query(
          `INSERT INTO category_merge_aliases (general,detail,target_category_id)
           VALUES ($1,$2,$3)
           ON CONFLICT (general,detail) DO UPDATE
             SET target_category_id=EXCLUDED.target_category_id`,
          [source.general, source.detail, targetId],
        );
      }
      if (source.hierarchy_only) {
        await client.query(
          `INSERT INTO category_root_aliases (general,target_category_id)
           VALUES ($1,$2)
           ON CONFLICT (general) DO UPDATE
             SET target_category_id=EXCLUDED.target_category_id`,
          [source.general, targetId],
        );
      }
      await client.query(`DELETE FROM categories WHERE id=$1`, [sourceId]);
    } catch (error) {
      if (pgErrorCode(error) === "23505")
        throw conflict(
          "Merge would duplicate a category membership or sibling name; resolve the conflict first",
        );
      throw error;
    }
    const merged: CategoryNodeRow | undefined = (
      await client.query(`${NODE_SELECT} WHERE c.id=$1`, [targetId])
    ).rows[0];
    return mapNode(merged);
  });
}
