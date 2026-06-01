import { query } from '../database/connection.js';

const COLUMNS = 'id, name, config_json, created_at, updated_at';

function mapRow(r) {
  return {
    id: r.id,
    name: r.name,
    // pg returns JSONB already parsed; tolerate a string just in case.
    config: typeof r.config_json === 'string' ? JSON.parse(r.config_json) : r.config_json,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const customParserConfigRepository = {
  async getAll() {
    const result = await query(`SELECT ${COLUMNS} FROM custom_parser_configs ORDER BY name ASC`);
    return result.rows.map(mapRow);
  },

  async getById(id) {
    const result = await query(`SELECT ${COLUMNS} FROM custom_parser_configs WHERE id = $1`, [id]);
    const r = result.rows[0];
    return r ? mapRow(r) : undefined;
  },

  async getByName(name) {
    const result = await query(`SELECT ${COLUMNS} FROM custom_parser_configs WHERE name = $1`, [name]);
    const r = result.rows[0];
    return r ? mapRow(r) : undefined;
  },

  async create({ name, config }) {
    const result = await query(
      `INSERT INTO custom_parser_configs (name, config_json)
       VALUES ($1, $2::jsonb)
       RETURNING ${COLUMNS}`,
      [name, JSON.stringify(config)]
    );
    return mapRow(result.rows[0]);
  },

  async update(id, { name, config }) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name); }
    if (config !== undefined) { fields.push(`config_json = $${idx++}::jsonb`); values.push(JSON.stringify(config)); }

    if (fields.length === 0) return this.getById(id);

    values.push(id);
    const result = await query(
      `UPDATE custom_parser_configs SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${COLUMNS}`,
      values
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  },

  async delete(id) {
    const result = await query(`DELETE FROM custom_parser_configs WHERE id = $1 RETURNING id`, [id]);
    return result.rows.length > 0;
  },
};

export default customParserConfigRepository;
