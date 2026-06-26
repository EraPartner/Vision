import { query } from '../database/connection.js';

const COLUMNS = 'id, name, chart_type, category_ids, recipient_ids, tag_ids, all_categories, all_recipients, all_tags, chart_variant, time_bucket, date_range_start, date_range_end, created_at, updated_at';

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
  async getAll() {
    const result = await query(`SELECT ${COLUMNS} FROM saved_charts ORDER BY created_at ASC`);
    return result.rows.map(mapRow);
  },

  async getById(id) {
    const result = await query(`SELECT ${COLUMNS} FROM saved_charts WHERE id = $1`, [id]);
    const r = result.rows[0];
    return r ? mapRow(r) : null;
  },

  async create({ name, chartType, categoryIds, recipientIds, tagIds, allCategories, allRecipients, allTags, chartVariant, timeBucket, dateRangeStart, dateRangeEnd }) {
    const result = await query(
      `INSERT INTO saved_charts (name, chart_type, category_ids, recipient_ids, tag_ids, all_categories, all_recipients, all_tags, chart_variant, time_bucket, date_range_start, date_range_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${COLUMNS}`,
      [name, chartType, categoryIds, recipientIds, tagIds ?? [], allCategories ?? false, allRecipients ?? false, allTags ?? false, chartVariant, timeBucket, dateRangeStart ?? null, dateRangeEnd ?? null]
    );
    return mapRow(result.rows[0]);
  },

  async update(id, { name, chartType, categoryIds, recipientIds, tagIds, allCategories, allRecipients, allTags, chartVariant, timeBucket, dateRangeStart, dateRangeEnd }) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name); }
    if (chartType !== undefined) { fields.push(`chart_type = $${idx++}`); values.push(chartType); }
    if (categoryIds !== undefined) { fields.push(`category_ids = $${idx++}`); values.push(categoryIds); }
    if (recipientIds !== undefined) { fields.push(`recipient_ids = $${idx++}`); values.push(recipientIds); }
    if (tagIds !== undefined) { fields.push(`tag_ids = $${idx++}`); values.push(tagIds); }
    if (allCategories !== undefined) { fields.push(`all_categories = $${idx++}`); values.push(allCategories); }
    if (allRecipients !== undefined) { fields.push(`all_recipients = $${idx++}`); values.push(allRecipients); }
    if (allTags !== undefined) { fields.push(`all_tags = $${idx++}`); values.push(allTags); }
    if (chartVariant !== undefined) { fields.push(`chart_variant = $${idx++}`); values.push(chartVariant); }
    if (timeBucket !== undefined) { fields.push(`time_bucket = $${idx++}`); values.push(timeBucket); }
    if (dateRangeStart !== undefined) { fields.push(`date_range_start = $${idx++}`); values.push(dateRangeStart); }
    if (dateRangeEnd !== undefined) { fields.push(`date_range_end = $${idx++}`); values.push(dateRangeEnd); }

    if (fields.length === 0) return this.getById(id);

    values.push(id);
    const result = await query(
      `UPDATE saved_charts SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${COLUMNS}`,
      values
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  },

  async delete(id) {
    const result = await query(`DELETE FROM saved_charts WHERE id = $1 RETURNING id`, [id]);
    return result.rows.length > 0;
  },
};

export default savedChartsRepository;
