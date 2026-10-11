import { query, withTransaction } from "../database/connection.ts";
import { queryOne, queryRows } from "../database/rowContracts.ts";
import { countRowSchema } from "../database/rowSchemas.ts";
import {
  idRowSchema,
  requireRow,
  savedChartRowSchema,
} from "../database/rows/catalog.ts";
import { buildSetClauses, buildLimitOffset } from "../lib/sqlClauses.ts";

import type { SavedChartRow } from "../types/rows.ts";

export type { SavedChartRow };

/**
 * The camelCase field bag the routes pass for create/update. All fields are
 * optional on update; create requires the NOT NULL ones.
 */
export interface SavedChartInput {
  name?: string;
  chartType?: string;
  categoryIds?: number[];
  recipientIds?: number[];
  tagIds?: number[];
  allCategories?: boolean;
  allRecipients?: boolean;
  allTags?: boolean;
  chartVariant?: string;
  timeBucket?: string;
  /** 'YYYY-MM-DD' */
  dateRangeStart?: string | null;
  /** 'YYYY-MM-DD' */
  dateRangeEnd?: string | null;
}

// date_range_* are DATE columns — emitted via to_char so the wire carries the
// calendar day, not a pg Date that JSON-serializes to the previous day east of UTC.
const COLUMNS = `
  sc.id,
  sc.name,
  sc.chart_type,
  COALESCE(
    (SELECT array_agg(category_id ORDER BY category_id)
       FROM saved_chart_categories WHERE saved_chart_id = sc.id),
    '{}'::INTEGER[]
  ) AS category_ids,
  COALESCE(
    (SELECT array_agg(recipient_id ORDER BY recipient_id)
       FROM saved_chart_recipients WHERE saved_chart_id = sc.id),
    '{}'::INTEGER[]
  ) AS recipient_ids,
  COALESCE(
    (SELECT array_agg(tag_id ORDER BY tag_id)
       FROM saved_chart_tags WHERE saved_chart_id = sc.id),
    '{}'::INTEGER[]
  ) AS tag_ids,
  sc.all_categories,
  sc.all_recipients,
  sc.all_tags,
  sc.chart_variant,
  sc.time_bucket,
  to_char(sc.date_range_start, 'YYYY-MM-DD') AS date_range_start,
  to_char(sc.date_range_end, 'YYYY-MM-DD') AS date_range_end,
  sc.created_at,
  sc.updated_at`;

const MEMBERSHIP_FIELDS: {
  input: "categoryIds" | "recipientIds" | "tagIds";
  table: string;
  column: string;
}[] = [
  {
    input: "categoryIds",
    table: "saved_chart_categories",
    column: "category_id",
  },
  {
    input: "recipientIds",
    table: "saved_chart_recipients",
    column: "recipient_id",
  },
  { input: "tagIds", table: "saved_chart_tags", column: "tag_id" },
];

/**
 * Replace only the membership sets present in `input`. The surrounding caller
 * owns the transaction and row lock, so delete-plus-insert is atomic.
 */
async function replaceMemberships(
  chartId: number,
  input: SavedChartInput,
): Promise<void> {
  for (const membership of MEMBERSHIP_FIELDS) {
    const ids = input[membership.input];
    if (ids === undefined) continue;
    const uniqueIds = [...new Set(ids)].sort((a, b) => a - b);
    await query(`DELETE FROM ${membership.table} WHERE saved_chart_id = $1`, [
      chartId,
    ]);
    if (uniqueIds.length === 0) continue;
    await query(
      `INSERT INTO ${membership.table} (saved_chart_id, ${membership.column})
       SELECT $1, unnest($2::INTEGER[])`,
      [chartId, uniqueIds],
    );
  }
}

async function readById(id: number): Promise<SavedChartRow | null> {
  const row = await queryOne(
    savedChartRowSchema,
    `SELECT ${COLUMNS} FROM saved_charts sc WHERE sc.id = $1`,
    [id],
  );
  return row ? mapRow(row) : null;
}

function mapRow(r: SavedChartRow): SavedChartRow {
  return {
    ...r,
    category_ids: Array.isArray(r.category_ids)
      ? r.category_ids.map(Number)
      : [],
    recipient_ids: Array.isArray(r.recipient_ids)
      ? r.recipient_ids.map(Number)
      : [],
    tag_ids: Array.isArray(r.tag_ids) ? r.tag_ids.map(Number) : [],
    all_categories: !!r.all_categories,
    all_recipients: !!r.all_recipients,
    all_tags: !!r.all_tags,
  };
}

const savedChartsRepository = {
  /**
   * List saved charts. `limit` is optional and defaults to unbounded — the
   * chart picker loads every saved chart, so only an explicit limit/offset
   * narrows the result.
   */
  async getAll({
    limit = null,
    offset = 0,
  }: { limit?: number | null; offset?: number } = {}): Promise<
    SavedChartRow[]
  > {
    const params: unknown[] = [];
    const sql =
      `SELECT ${COLUMNS} FROM saved_charts sc ORDER BY sc.created_at ASC` +
      buildLimitOffset(params, { limit, offset });
    const rows = await queryRows(savedChartRowSchema, sql, params);
    return rows.map(mapRow);
  },

  /**
   * Row count — the `total` for a paginated list.
   */
  async getCount(): Promise<number> {
    const row = await queryOne(
      countRowSchema,
      "SELECT COUNT(*) FROM saved_charts",
    );
    return parseInt(requireRow(row, "saved chart count").count, 10);
  },

  async getById(id: number): Promise<SavedChartRow | null> {
    return readById(id);
  },

  async create({
    name,
    chartType,
    categoryIds,
    recipientIds,
    tagIds,
    allCategories,
    allRecipients,
    allTags,
    chartVariant,
    timeBucket,
    dateRangeStart,
    dateRangeEnd,
  }: SavedChartInput): Promise<SavedChartRow | null> {
    return withTransaction(async () => {
      const inserted = await queryOne(
        idRowSchema,
        `INSERT INTO saved_charts (name, chart_type, all_categories, all_recipients, all_tags, chart_variant, time_bucket, date_range_start, date_range_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          name,
          chartType,
          allCategories ?? false,
          allRecipients ?? false,
          allTags ?? false,
          chartVariant,
          timeBucket,
          dateRangeStart ?? null,
          dateRangeEnd ?? null,
        ],
      );
      const id = requireRow(inserted, "saved chart insert").id;
      await replaceMemberships(id, {
        categoryIds,
        recipientIds: recipientIds ?? [],
        tagIds: tagIds ?? [],
      });
      return readById(id);
    });
  },

  async update(
    id: number,
    {
      name,
      chartType,
      categoryIds,
      recipientIds,
      tagIds,
      allCategories,
      allRecipients,
      allTags,
      chartVariant,
      timeBucket,
      dateRangeStart,
      dateRangeEnd,
    }: SavedChartInput,
  ): Promise<SavedChartRow | null> {
    // Shared clause builder (lib/sqlClauses.ts): undefined fields are skipped,
    // mapColumn translates the camelCase API bag to the snake_case columns.
    const {
      clauses: fields,
      params: values,
      nextIdx: idx,
    } = buildSetClauses(
      {
        name,
        chartType,
        allCategories,
        allRecipients,
        allTags,
        chartVariant,
        timeBucket,
        dateRangeStart,
        dateRangeEnd,
      },
      {
        mapColumn: (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
      },
    );

    return withTransaction(async () => {
      const locked = await query(
        "SELECT id FROM saved_charts WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (!locked.rows[0]) return null;
      if (fields.length > 0) {
        values.push(id);
        await query(
          `UPDATE saved_charts SET ${fields.join(", ")} WHERE id = $${idx}`,
          values,
        );
      }
      await replaceMemberships(id, { categoryIds, recipientIds, tagIds });
      return readById(id);
    });
  },

  /** @returns true if a row was removed */
  async delete(id: number): Promise<boolean> {
    const result = await query(
      `DELETE FROM saved_charts WHERE id = $1 RETURNING id`,
      [id],
    );
    return result.rows.length > 0;
  },
};

export default savedChartsRepository;
