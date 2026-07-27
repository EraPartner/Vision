import { query } from '../database/connection.js';
import { buildSetClauses } from '../lib/sqlClauses.js';

/** @typedef {import('../types/rows.js').CustomParserConfigRow} CustomParserConfigRow */
/** @typedef {import('../types/rows.js').FormattedCustomParserConfig} FormattedCustomParserConfig */

const COLUMNS = 'id, name, kind, config_json, created_at, updated_at';

/**
 * @param {CustomParserConfigRow} r
 * @returns {FormattedCustomParserConfig}
 */
function mapRow(r) {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    // pg returns JSONB already parsed; tolerate a string just in case.
    config: typeof r.config_json === 'string' ? JSON.parse(r.config_json) : r.config_json,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const customParserConfigRepository = {
  /**
   * @param {string} [kind]
   * @returns {Promise<FormattedCustomParserConfig[]>}
   */
  async getAll(kind = 'transaction') {
    const result = await query(
      `SELECT ${COLUMNS} FROM custom_parser_configs WHERE kind = $1 ORDER BY name ASC`,
      [kind],
    );
    return result.rows.map(mapRow);
  },

  /**
   * @param {number} id
   * @returns {Promise<FormattedCustomParserConfig|undefined>}
   */
  async getById(id) {
    const result = await query(`SELECT ${COLUMNS} FROM custom_parser_configs WHERE id = $1`, [id]);
    const r = result.rows[0];
    return r ? mapRow(r) : undefined;
  },

  /**
   * @param {string} name
   * @param {string} [kind]
   * @returns {Promise<FormattedCustomParserConfig|undefined>}
   */
  async getByName(name, kind = 'transaction') {
    const result = await query(
      `SELECT ${COLUMNS} FROM custom_parser_configs WHERE name = $1 AND kind = $2`,
      [name, kind],
    );
    const r = result.rows[0];
    return r ? mapRow(r) : undefined;
  },

  /**
   * @param {{ name: string, config: any, kind?: string }} input
   * @returns {Promise<FormattedCustomParserConfig>}
   */
  async create({ name, config, kind = 'transaction' }) {
    const result = await query(
      `INSERT INTO custom_parser_configs (name, kind, config_json)
       VALUES ($1, $2, $3::jsonb)
       RETURNING ${COLUMNS}`,
      [name, kind, JSON.stringify(config)],
    );
    return mapRow(result.rows[0]);
  },

  /**
   * @param {number} id
   * @param {{ name?: string, config?: any }} patch
   * @returns {Promise<FormattedCustomParserConfig|undefined>}
   */
  async update(id, { name, config }) {
    // Shared clause builder (lib/sqlClauses.js): undefined fields are skipped.
    const { clauses: fields, params: values, nextIdx: idx } = buildSetClauses({
      name,
      config_json: config !== undefined ? JSON.stringify(config) : undefined,
    });
    // config_json needs the ::jsonb cast the generic builder does not emit.
    const castFields = fields.map((f) => f.startsWith('config_json = ') ? `${f}::jsonb` : f);

    if (castFields.length === 0) return this.getById(id);

    values.push(id);
    const result = await query(
      `UPDATE custom_parser_configs SET ${castFields.join(', ')} WHERE id = $${idx} RETURNING ${COLUMNS}`,
      values,
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  },

  /**
   * @param {number} id
   * @returns {Promise<boolean>} true if a row was removed
   */
  async delete(id) {
    const result = await query(`DELETE FROM custom_parser_configs WHERE id = $1 RETURNING id`, [id]);
    return result.rows.length > 0;
  },
};

export default customParserConfigRepository;
