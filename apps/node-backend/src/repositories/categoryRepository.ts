/**
 * Category Repository - data access for categories table.
 *
 */

import { sql } from "kysely";
import type { ExpressionBuilder, SelectQueryBuilder } from "kysely";
import { withTransaction } from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import { categoryKeyRowSchema } from "../database/rowSchemas.ts";
import {
  categoryCountRowSchema,
  categoryRowSchema,
  requireRow,
} from "../database/rows/catalog.ts";
import type { DB } from "../database/schema.generated.ts";
import { ConflictError } from "../middleware/errorHandler.ts";

import type { CategoryRow, EnrichedCategoryRow } from "../types/rows.ts";
import type { CategoryId, RecipientId } from "@vision/types/brands";
import { errorCode } from "../lib/errors.ts";

export type { EnrichedCategoryRow };

export interface CategoryFilters {
  limit?: number | null | undefined;
  offset?: number | undefined;
  general?: string | null | undefined;
  detail?: string | null | undefined;
  search?: string | null | undefined;
  active?: boolean | undefined;
}

export const categoryRepository = {
  /**
   * `limit` is optional and defaults to unbounded — the category pickers/pages
   * render every row and have no paging, so only an explicit limit/offset
   * narrows the list.
   */
  async getAll({
    limit = null,
    offset = 0,
    general = null,
    detail = null,
    search = null,
    active = true,
  }: CategoryFilters = {}): Promise<EnrichedCategoryRow[]> {
    let builder = filterCategories(db.selectFrom("categories").selectAll(), {
      general,
      detail,
      search,
      active,
    }).orderBy("general").orderBy("detail");
    if (limit != null) builder = builder.limit(limit).offset(offset);

    const rows = await checkedRows(categoryRowSchema, builder);
    return rows.map((row) => enrichCategory(row));
  },

  async getCount({
    general = null,
    detail = null,
    search = null,
    active = true,
  }: CategoryFilters = {}): Promise<number> {
    const builder = filterCategories(
      db.selectFrom("categories").select(sql<number>`count(*)`.as("count")),
      { general, detail, search, active },
    );
    // A bare count(*) reads as a number (ADR-263).
    const row = await checkedRow(categoryCountRowSchema, builder);
    return requireRow(row, "category count").count;
  },

  async getById(id: CategoryId): Promise<EnrichedCategoryRow | null> {
    const row = await checkedRow(
      categoryRowSchema,
      db.selectFrom("categories").selectAll().where("id", "=", id),
    );
    return row ? enrichCategory(row) : null;
  },

  /**
   * Resolve only active categories from a reviewed set of IDs.
   */
  async getActiveByIds(ids: CategoryId[]): Promise<EnrichedCategoryRow[]> {
    const uniqueIds = [...new Set(ids.filter(Number.isInteger))];
    if (uniqueIds.length === 0) return [];
    const rows = await checkedRows(
      categoryRowSchema,
      db
        .selectFrom("categories")
        .selectAll()
        .where(
          "id",
          "in",
          sql<CategoryId>`(SELECT value FROM json_each(${JSON.stringify(uniqueIds)}))`,
        )
        .where("is_active", "=", true)
        .orderBy("id"),
    );
    return rows.map((row) => enrichCategory(row));
  },

  async getByGeneralDetail(
    general: string,
    detail: string,
  ): Promise<EnrichedCategoryRow | null> {
    const row = await checkedRow(
      categoryRowSchema,
      db
        .selectFrom("categories")
        .selectAll()
        .where("general", "=", general.toUpperCase())
        .where("detail", "=", detail.toUpperCase()),
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
    description?: string | null | undefined;
  }): Promise<{ category: EnrichedCategoryRow | null; created: boolean }> {
    const g = general.toUpperCase().trim();
    const d = detail.toUpperCase().trim();
    // One BEGIN IMMEDIATE transaction (ADR-263) serialises this with the
    // hierarchy writes, as the PostgreSQL hierarchy advisory lock did.
    return withTransaction(async () => {
      const alias = await checkedRow(
        categoryKeyRowSchema,
        db
          .selectFrom("category_merge_aliases")
          .select("target_category_id as id")
          .where("general", "=", g)
          .where("detail", "=", d),
      );
      if (alias)
        return {
          category: await this.getById(alias.id),
          created: false,
        };
      const inserted = await checkedRow(
        categoryKeyRowSchema,
        // name is filled by the categories trigger, so the typed insert
        // builder (which requires it) does not fit.
        sql`INSERT INTO categories (general, detail, description, is_active)
            VALUES (${g}, ${d}, ${description}, true)
            ON CONFLICT (general, detail) DO NOTHING
            RETURNING *`,
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
    id: CategoryId,
    {
      general,
      detail,
      description,
      is_active,
    }: {
      general?: string | null | undefined;
      detail?: string | null | undefined;
      description?: string | null | undefined;
      is_active?: boolean | null | undefined;
    },
  ): Promise<EnrichedCategoryRow | null> {
    // undefined fields are skipped. null general/detail/is_active mean "leave
    // unchanged"; description accepts an explicit null write.
    const changes = {
      ...(general != null && { general: general.toUpperCase().trim() }),
      ...(detail != null && { detail: detail.toUpperCase().trim() }),
      ...(description !== undefined && { description }),
      ...(is_active != null && { is_active }),
    };
    if (Object.keys(changes).length === 0) return this.getById(id);

    const updated = await db
      .updateTable("categories")
      .set({ ...changes, updated_at: sql<Date>`now()` })
      .where("id", "=", id)
      .where("legacy_compatible", "=", true)
      .returning("id")
      .executeTakeFirst();
    return updated ? this.getById(id) : null;
  },

  async hardDelete(id: CategoryId): Promise<boolean> {
    try {
      const result = await db
        .deleteFrom("categories")
        .where("id", "=", id)
        .where("legacy_compatible", "=", true)
        .executeTakeFirst();
      return result.numDeletedRows > 0n;
    } catch (error) {
      // A RESTRICT reference (a child, merge or root alias) raises 23001 on
      // SQLite (ADR-263); PostgreSQL raised 23503 for every foreign key.
      const code = errorCode(error);
      if (code === "23503" || code === "23001")
        throw new ConflictError(
          "Category is still referenced or has legacy merge redirects",
        );
      throw error;
    }
  },

  /** @returns rows updated (pg `rowCount`) */
  async assignToRecipients(
    categoryId: CategoryId,
    recipientIds: RecipientId[],
  ): Promise<number | null> {
    const result = await db
      .updateTable("recipients")
      .set({ default_category_id: categoryId, updated_at: sql<Date>`now()` })
      .where(
        "id",
        "in",
        sql<RecipientId>`(SELECT value FROM json_each(${JSON.stringify(recipientIds)}))`,
      )
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  },
};

/** The legacy-compatible category filters shared by getAll and getCount. */
function filterCategories<O>(
  builder: SelectQueryBuilder<DB, "categories", O>,
  {
    general,
    detail,
    search,
    active,
  }: Pick<CategoryFilters, "general" | "detail" | "search" | "active">,
): SelectQueryBuilder<DB, "categories", O> {
  // ilike(): PostgreSQL ILIKE in the C locale (ASCII case folding).
  let filtered = builder.where("legacy_compatible", "=", true);
  if (active) filtered = filtered.where("is_active", "=", true);
  if (general) filtered = filtered.where(sql<boolean>`ilike(general, ${`%${general}%`})`);
  if (detail) filtered = filtered.where(sql<boolean>`ilike(detail, ${`%${detail}%`})`);
  if (search) {
    const sp = `%${search}%`;
    filtered = filtered.where((eb: ExpressionBuilder<DB, "categories">) =>
      eb.or([
        sql<boolean>`ilike(general, ${sp})`,
        sql<boolean>`ilike(detail, ${sp})`,
        sql<boolean>`ilike(path_name, ${sp})`,
        sql<boolean>`ilike(description, ${sp})`,
      ]),
    );
  }
  return filtered;
}

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
    category_name: row.path_name,
  };
}

export default categoryRepository;
