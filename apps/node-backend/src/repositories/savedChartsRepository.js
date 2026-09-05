import { query, withTransaction } from "../database/connection.js";
import { buildSetClauses, buildLimitOffset } from "../lib/sqlClauses.js";

/** @typedef {import('../types/rows.js').SavedChartRow} SavedChartRow */

/**
 * The camelCase field bag the routes pass for create/update. All fields are
 * optional on update; create requires the NOT NULL ones.
 *
 * @typedef {object} SavedChartInput
 * @property {string} [name]
 * @property {string} [chartType]
 * @property {number[]} [categoryIds]
 * @property {number[]} [recipientIds]
 * @property {number[]} [tagIds]
 * @property {boolean} [allCategories]
 * @property {boolean} [allRecipients]
 * @property {boolean} [allTags]
 * @property {string} [chartVariant]
 * @property {string} [timeBucket]
 * @property {string|null} [dateRangeStart] 'YYYY-MM-DD'
 * @property {string|null} [dateRangeEnd] 'YYYY-MM-DD'
 */

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

const MEMBERSHIP_FIELDS = [
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
 * @param {number} chartId
 * @param {SavedChartInput} input
 */
async function replaceMemberships(chartId, input) {
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

/** @param {number} id */
async function readById(id) {
  const result = await query(
    `SELECT ${COLUMNS} FROM saved_charts sc WHERE sc.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * @param {SavedChartRow} r
 * @returns {SavedChartRow}
 */
function mapRow(r) {
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
   *
   * @param {{ limit?: number|null, offset?: number }} [page]
   * @returns {Promise<SavedChartRow[]>}
   */
  async getAll({ limit = null, offset = 0 } = {}) {
    /** @type {any[]} */
    const params = [];
    const sql =
      `SELECT ${COLUMNS} FROM saved_charts sc ORDER BY sc.created_at ASC` +
      buildLimitOffset(params, { limit, offset });
    const result = await query(sql, params);
    return result.rows.map(mapRow);
  },

  /**
   * Row count — the `total` for a paginated list.
   * @returns {Promise<number>}
   */
  async getCount() {
    const result = await query("SELECT COUNT(*) FROM saved_charts");
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * @param {number} id
   * @returns {Promise<SavedChartRow|null>}
   */
  async getById(id) {
    return readById(id);
  },

  /**
   * @param {SavedChartInput} input
   * @returns {Promise<SavedChartRow>}
   */
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
  }) {
    return withTransaction(async () => {
      const result = await query(
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
      const id = Number(result.rows[0].id);
      await replaceMemberships(id, {
        categoryIds,
        recipientIds: recipientIds ?? [],
        tagIds: tagIds ?? [],
      });
      return readById(id);
    });
  },

  /**
   * @param {number} id
   * @param {SavedChartInput} patch
   * @returns {Promise<SavedChartRow|null>}
   */
  async update(
    id,
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
    },
  ) {
    // Shared clause builder (lib/sqlClauses.js): undefined fields are skipped,
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

  /**
   * @param {number} id
   * @returns {Promise<boolean>} true if a row was removed
   */
  async delete(id) {
    const result = await query(
      `DELETE FROM saved_charts WHERE id = $1 RETURNING id`,
      [id],
    );
    return result.rows.length > 0;
  },
};

export default savedChartsRepository;
