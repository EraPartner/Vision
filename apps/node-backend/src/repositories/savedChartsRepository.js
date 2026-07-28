import { query } from '../database/connection.js';
import { buildSetClauses, buildLimitOffset } from '../lib/sqlClauses.js';

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
const COLUMNS = "id, name, chart_type, category_ids, recipient_ids, tag_ids, all_categories, all_recipients, all_tags, chart_variant, time_bucket, to_char(date_range_start, 'YYYY-MM-DD') AS date_range_start, to_char(date_range_end, 'YYYY-MM-DD') AS date_range_end, created_at, updated_at";

/**
 * @param {SavedChartRow} r
 * @returns {SavedChartRow}
 */
function mapRow(r) {
  return {
    ...r,
    category_ids: Array.isArray(r.category_ids) ? r.category_ids.map(Number) : [],
    recipient_ids: Array.isArray(r.recipient_ids) ? r.recipient_ids.map(Number) : [],
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
    const sql = `SELECT ${COLUMNS} FROM saved_charts ORDER BY created_at ASC`
      + buildLimitOffset(params, { limit, offset });
    const result = await query(sql, params);
    return result.rows.map(mapRow);
  },

  /**
   * Row count — the `total` for a paginated list.
   * @returns {Promise<number>}
   */
  async getCount() {
    const result = await query('SELECT COUNT(*) FROM saved_charts');
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * @param {number} id
   * @returns {Promise<SavedChartRow|null>}
   */
  async getById(id) {
    const result = await query(`SELECT ${COLUMNS} FROM saved_charts WHERE id = $1`, [id]);
    const r = result.rows[0];
    return r ? mapRow(r) : null;
  },

  /**
   * @param {SavedChartInput} input
   * @returns {Promise<SavedChartRow>}
   */
  async create({ name, chartType, categoryIds, recipientIds, tagIds, allCategories, allRecipients, allTags, chartVariant, timeBucket, dateRangeStart, dateRangeEnd }) {
    const result = await query(
      `INSERT INTO saved_charts (name, chart_type, category_ids, recipient_ids, tag_ids, all_categories, all_recipients, all_tags, chart_variant, time_bucket, date_range_start, date_range_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${COLUMNS}`,
      [name, chartType, categoryIds, recipientIds, tagIds ?? [], allCategories ?? false, allRecipients ?? false, allTags ?? false, chartVariant, timeBucket, dateRangeStart ?? null, dateRangeEnd ?? null]
    );
    return mapRow(result.rows[0]);
  },

  /**
   * @param {number} id
   * @param {SavedChartInput} patch
   * @returns {Promise<SavedChartRow|null>}
   */
  async update(id, { name, chartType, categoryIds, recipientIds, tagIds, allCategories, allRecipients, allTags, chartVariant, timeBucket, dateRangeStart, dateRangeEnd }) {
    // Shared clause builder (lib/sqlClauses.js): undefined fields are skipped,
    // mapColumn translates the camelCase API bag to the snake_case columns.
    const { clauses: fields, params: values, nextIdx: idx } = buildSetClauses(
      { name, chartType, categoryIds, recipientIds, tagIds, allCategories, allRecipients, allTags, chartVariant, timeBucket, dateRangeStart, dateRangeEnd },
      { mapColumn: (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) },
    );

    if (fields.length === 0) return this.getById(id);

    values.push(id);
    const result = await query(
      `UPDATE saved_charts SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${COLUMNS}`,
      values
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  },

  /**
   * @param {number} id
   * @returns {Promise<boolean>} true if a row was removed
   */
  async delete(id) {
    const result = await query(`DELETE FROM saved_charts WHERE id = $1 RETURNING id`, [id]);
    return result.rows.length > 0;
  },
};

export default savedChartsRepository;
