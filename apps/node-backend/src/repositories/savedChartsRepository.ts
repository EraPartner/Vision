import { sql } from "kysely";
import { withTransaction } from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import { countRowSchema } from "../database/rowSchemas.ts";
import {
  idRowSchema,
  requireRow,
  savedChartRowSchema,
} from "../database/rows/catalog.ts";

import type { SavedChartRow } from "../types/rows.ts";

/**
 * The camelCase field bag the routes pass for create/update. All fields are
 * optional on update; create requires the NOT NULL ones.
 */
export interface SavedChartInput {
  name?: string | undefined;
  chartType?: string | undefined;
  categoryIds?: number[] | undefined;
  recipientIds?: number[] | undefined;
  tagIds?: number[] | undefined;
  allCategories?: boolean | undefined;
  allRecipients?: boolean | undefined;
  allTags?: boolean | undefined;
  chartVariant?: string | undefined;
  timeBucket?: string | undefined;
  /** 'YYYY-MM-DD' */
  dateRangeStart?: string | null | undefined;
  /** 'YYYY-MM-DD' */
  dateRangeEnd?: string | null | undefined;
}

/** A membership id list, ordered, never NULL. */
function memberIds(
  table: "saved_chart_categories" | "saved_chart_recipients" | "saved_chart_tags",
  column: "category_id" | "recipient_id" | "tag_id",
  alias: "category_ids" | "recipient_ids" | "tag_ids",
) {
  return sql<number[]>`COALESCE(
    (SELECT array_agg(${sql.ref(column)} ORDER BY ${sql.ref(column)})
       FROM ${sql.table(table)} WHERE saved_chart_id = sc.id),
    '{}'::INTEGER[]
  )`.as(alias);
}

// date_range_* are DATE columns — emitted via to_char so the wire carries the
// calendar day, not a pg Date that JSON-serializes to the previous day east of UTC.
function selectCharts() {
  return db
    .selectFrom("saved_charts as sc")
    .select([
      "sc.id",
      "sc.name",
      "sc.chart_type",
      memberIds("saved_chart_categories", "category_id", "category_ids"),
      memberIds("saved_chart_recipients", "recipient_id", "recipient_ids"),
      memberIds("saved_chart_tags", "tag_id", "tag_ids"),
      "sc.all_categories",
      "sc.all_recipients",
      "sc.all_tags",
      "sc.chart_variant",
      "sc.time_bucket",
      sql<string | null>`to_char(sc.date_range_start, 'YYYY-MM-DD')`.as(
        "date_range_start",
      ),
      sql<string | null>`to_char(sc.date_range_end, 'YYYY-MM-DD')`.as(
        "date_range_end",
      ),
      "sc.created_at",
      "sc.updated_at",
    ]);
}

const MEMBERSHIP_FIELDS: {
  input: "categoryIds" | "recipientIds" | "tagIds";
  table: "saved_chart_categories" | "saved_chart_recipients" | "saved_chart_tags";
  column: "category_id" | "recipient_id" | "tag_id";
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
    await db
      .deleteFrom(membership.table)
      .where("saved_chart_id", "=", chartId)
      .execute();
    if (uniqueIds.length === 0) continue;
    await sql`
      INSERT INTO ${sql.table(membership.table)} (saved_chart_id, ${sql.ref(membership.column)})
      SELECT ${chartId}, unnest(${uniqueIds}::INTEGER[])
    `.execute(db);
  }
}

async function readById(id: number): Promise<SavedChartRow | null> {
  const row = await checkedRow(
    savedChartRowSchema,
    selectCharts().where("sc.id", "=", id),
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
    all_categories: r.all_categories,
    all_recipients: r.all_recipients,
    all_tags: r.all_tags,
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
    let builder = selectCharts().orderBy("sc.created_at", "asc");
    if (limit !== null) builder = builder.limit(limit).offset(offset);
    const rows = await checkedRows(savedChartRowSchema, builder);
    return rows.map(mapRow);
  },

  /**
   * Row count — the `total` for a paginated list.
   */
  async getCount(): Promise<number> {
    const row = await checkedRow(
      countRowSchema,
      db.selectFrom("saved_charts").select(sql<string>`COUNT(*)`.as("count")),
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
    if (name === undefined) throw new Error("saved chart insert needs a name");
    return withTransaction(async () => {
      const inserted = await checkedRow(
        idRowSchema,
        db
          .insertInto("saved_charts")
          .values({
            name,
            chart_type: chartType,
            all_categories: allCategories ?? false,
            all_recipients: allRecipients ?? false,
            all_tags: allTags ?? false,
            chart_variant: chartVariant,
            time_bucket: timeBucket,
            date_range_start: dateRangeStart ?? null,
            date_range_end: dateRangeEnd ?? null,
          })
          .returning("id"),
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
    // Undefined fields are left unchanged; null clears a date bound.
    const fields = {
      name,
      chart_type: chartType,
      all_categories: allCategories,
      all_recipients: allRecipients,
      all_tags: allTags,
      chart_variant: chartVariant,
      time_bucket: timeBucket,
      date_range_start: dateRangeStart,
      date_range_end: dateRangeEnd,
    };
    const hasFields = Object.values(fields).some((v) => v !== undefined);

    return withTransaction(async () => {
      const locked = await db
        .selectFrom("saved_charts")
        .select("id")
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) return null;
      if (hasFields) {
        await db
          .updateTable("saved_charts")
          .set(fields)
          .where("id", "=", id)
          .execute();
      }
      await replaceMemberships(id, { categoryIds, recipientIds, tagIds });
      return readById(id);
    });
  },

  /** @returns true if a row was removed */
  async delete(id: number): Promise<boolean> {
    const result = await db
      .deleteFrom("saved_charts")
      .where("id", "=", id)
      .returning("id")
      .executeTakeFirst();
    return result !== undefined;
  },
};

export default savedChartsRepository;
