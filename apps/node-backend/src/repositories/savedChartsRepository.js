import { query } from '../database/connection.js';

const savedChartsRepository = {
  async getAll() {
    const result = await query(
      `SELECT id, name, chart_type, category_ids, created_at, updated_at
       FROM saved_charts
       ORDER BY created_at ASC`
    );
    return result.rows;
  },

  async getById(id) {
    const result = await query(
      `SELECT id, name, chart_type, category_ids, created_at, updated_at
       FROM saved_charts WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  async create({ name, chartType, categoryIds }) {
    const result = await query(
      `INSERT INTO saved_charts (name, chart_type, category_ids)
       VALUES ($1, $2, $3)
       RETURNING id, name, chart_type, category_ids, created_at, updated_at`,
      [name, chartType, JSON.stringify(categoryIds)]
    );
    return result.rows[0];
  },

  async update(id, { name, chartType, categoryIds }) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name); }
    if (chartType !== undefined) { fields.push(`chart_type = $${idx++}`); values.push(chartType); }
    if (categoryIds !== undefined) { fields.push(`category_ids = $${idx++}`); values.push(JSON.stringify(categoryIds)); }

    if (fields.length === 0) return this.getById(id);

    values.push(id);
    const result = await query(
      `UPDATE saved_charts SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING id, name, chart_type, category_ids, created_at, updated_at`,
      values
    );
    return result.rows[0] || null;
  },

  async delete(id) {
    const result = await query(
      `DELETE FROM saved_charts WHERE id = $1 RETURNING id`,
      [id]
    );
    return result.rows.length > 0;
  },
};

export default savedChartsRepository;
