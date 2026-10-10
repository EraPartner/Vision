/**
 * Category Repository - data access for categories table.
 *
 */

import { query, withTransaction } from "../database/connection.ts";
import { queryOne, queryRows } from "../database/rowContracts.ts";
import { countRowSchema } from "../database/rowSchemas.ts";
import {
  categoryRowSchema,
  idRowSchema,
  requireRow,
} from "../database/rows/catalog.ts";
import { buildLimitOffset, buildSetClauses } from "../lib/sqlClauses.ts";
import { ConflictError } from "../middleware/errorHandler.ts";

import type { CategoryRow, EnrichedCategoryRow } from "../types/rows.ts";

export type { EnrichedCategoryRow };

export interface CategoryFilters {
  limit?: number | null;
  offset?: number;
  general?: string | null;
  detail?: string | null;
  search?: string | null;
  active?: boolean;
}

export const categoryRepository = {
  /**
   * `limit` is optional and defaults to unbounded — the category pickers/pages
   * render every row and have no paging, so only an explicit limit/offset
   * narrows the list (buildLimitOffset).
   */
  async getAll({
    limit = null,
    offset = 0,
    general = null,
    detail = null,
    search = null,
    active = true,
  }: CategoryFilters = {}): Promise<EnrichedCategoryRow[]> {
    let sql = `SELECT * FROM categories WHERE legacy_compatible = true`;
    const params: unknown[] = [];
    let paramIdx = 1;

    if (active) {
      sql += ` AND is_active = true`;
    }
    if (general) {
      sql += ` AND general ILIKE $${paramIdx++}`;
      params.push(`%${general}%`);
    }
    if (detail) {
      sql += ` AND detail ILIKE $${paramIdx++}`;
      params.push(`%${detail}%`);
    }
    if (search) {
      const sp = `%${search}%`;
      sql += ` AND (general ILIKE $${paramIdx} OR detail ILIKE $${paramIdx} OR path_name ILIKE $${paramIdx} OR description ILIKE $${paramIdx})`;
      params.push(sp);
    }

    sql += ` ORDER BY general, detail`;
    sql += buildLimitOffset(params, { limit, offset });

    const rows = await queryRows(categoryRowSchema, sql, params);
    return rows.map((row) => enrichCategory(row));
  },

  async getCount({
    general = null,
    detail = null,
    search = null,
    active = true,
  }: CategoryFilters = {}): Promise<number> {
    let sql = `SELECT count(*) FROM categories WHERE legacy_compatible = true`;
    const params: unknown[] = [];
    let paramIdx = 1;

    if (active) sql += ` AND is_active = true`;
    if (general) {
      sql += ` AND general ILIKE $${paramIdx++}`;
      params.push(`%${general}%`);
    }
    if (detail) {
      sql += ` AND detail ILIKE $${paramIdx++}`;
      params.push(`%${detail}%`);
    }
    if (search) {
      const sp = `%${search}%`;
      sql += ` AND (general ILIKE $${paramIdx} OR detail ILIKE $${paramIdx} OR path_name ILIKE $${paramIdx} OR description ILIKE $${paramIdx})`;
      params.push(sp);
    }

    const row = await queryOne(countRowSchema, sql, params);
    return parseInt(requireRow(row, "category count").count, 10);
  },

  async getById(id: number): Promise<EnrichedCategoryRow | null> {
    const row = await queryOne(
      categoryRowSchema,
      "SELECT * FROM categories WHERE id = $1",
      [id],
    );
    return row ? enrichCategory(row) : null;
  },

  /**
   * Resolve only active categories from a reviewed set of IDs.
   */
  async getActiveByIds(ids: number[]): Promise<EnrichedCategoryRow[]> {
    const uniqueIds = [...new Set(ids.filter(Number.isInteger))];
    if (uniqueIds.length === 0) return [];
    const rows = await queryRows(
      categoryRowSchema,
      `SELECT * FROM categories
       WHERE id = ANY($1::int[]) AND is_active = true
       ORDER BY id`,
      [uniqueIds],
    );
    return rows.map((row) => enrichCategory(row));
  },

  async getByGeneralDetail(
    general: string,
    detail: string,
  ): Promise<EnrichedCategoryRow | null> {
    const row = await queryOne(
      categoryRowSchema,
      "SELECT * FROM categories WHERE general = $1 AND detail = $2",
      [general.toUpperCase(), detail.toUpperCase()],
    );
    return row ? enrichCategory(row) : null;
  },

  async createOrGet({
    general,
    detail,
    description = null,
  }: {
    general: string;
    detail: string;
    description?: string | null;
  }): Promise<{ category: EnrichedCategoryRow | null; created: boolean }> {
    const g = general.toUpperCase().trim();
    const d = detail.toUpperCase().trim();
    return withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(1128356178, 1)");
      const alias = await queryOne(
        idRowSchema,
        `SELECT target_category_id AS id FROM category_merge_aliases
       WHERE general=$1 AND detail=$2`,
        [g, d],
      );
      if (alias)
        return {
          category: await this.getById(alias.id),
          created: false,
        };
      const inserted = await queryOne(
        idRowSchema,
        `INSERT INTO categories (general, detail, description, is_active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (general, detail) DO NOTHING
       RETURNING *`,
        [g, d, description],
      );

      if (inserted) {
        // The hierarchy path is recomputed by an AFTER trigger, so RETURNING
        // still sees the pre-trigger placeholder. Read the committed row again.
        return {
          category: await this.getById(inserted.id),
          created: true,
        };
      }

      const existing = await this.getByGeneralDetail(g, d);
      return { category: existing, created: false };
    });
  },

  async update(
    id: number,
    {
      general,
      detail,
      description,
      is_active,
    }: {
      general?: string | null;
      detail?: string | null;
      description?: string | null;
      is_active?: boolean | null;
    },
  ): Promise<EnrichedCategoryRow | null> {
    // Shared clause builder (lib/sqlClauses.ts): undefined fields are skipped.
    // null general/detail/is_active mean "leave unchanged" (pre-mapped to
    // undefined); description accepts an explicit null write.
    const {
      clauses: setClauses,
      params,
      nextIdx: paramIdx,
    } = buildSetClauses({
      general: general != null ? general.toUpperCase().trim() : undefined,
      detail: detail != null ? detail.toUpperCase().trim() : undefined,
      description,
      is_active: is_active ?? undefined,
    });

    if (setClauses.length === 0) return this.getById(id);

    setClauses.push(`updated_at = NOW()`);
    params.push(id);
    const sql = `UPDATE categories SET ${setClauses.join(", ")} WHERE id = $${paramIdx} AND legacy_compatible = true RETURNING *`;
    const result = await query(sql, params);
    return result.rows[0] ? this.getById(id) : null;
  },

  async hardDelete(id: number): Promise<boolean> {
    try {
      const result = await query(
        "DELETE FROM categories WHERE id = $1 AND legacy_compatible = true",
        [id],
      );
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      if ((error as { code?: unknown } | null | undefined)?.code === "23503")
        throw new ConflictError(
          "Category is still referenced or has legacy merge redirects",
        );
      throw error;
    }
  },

  /** @returns rows updated (pg `rowCount`) */
  async assignToRecipients(
    categoryId: number,
    recipientIds: number[],
  ): Promise<number | null> {
    const sql = `UPDATE recipients SET default_category_id = $1, updated_at = NOW() WHERE id = ANY($2::int[])`;
    const result = await query(sql, [categoryId, recipientIds]);
    return result.rowCount;
  },
};

/**
 * Add the `GENERAL:DETAIL` display name to a `categories` row.
 */
function enrichCategory(row: CategoryRow): EnrichedCategoryRow;
function enrichCategory(
  row: CategoryRow | null | undefined,
): EnrichedCategoryRow | null;
function enrichCategory(
  row: CategoryRow | null | undefined,
): EnrichedCategoryRow | null {
  if (!row) return null;
  return {
    ...row,
    category_name: row.path_name ?? `${row.general}:${row.detail}`,
  };
}

export default categoryRepository;
