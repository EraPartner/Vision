import { query } from '../database/connection.ts';
import { buildSetClauses } from '../lib/sqlClauses.ts';
import { checkDataContract } from '../lib/dataContract.ts';
import { storedParserConfigSchema } from '../lib/parserConfigSchema.ts';

import type {
  CustomParserConfigRow,
  FormattedCustomParserConfig,
} from '../types/rows.ts';

export type { CustomParserConfigRow, FormattedCustomParserConfig };

const COLUMNS = 'id, name, kind, config_json, created_at, updated_at';

function mapRow(r: CustomParserConfigRow): FormattedCustomParserConfig {
  // pg returns JSONB already parsed; tolerate a string just in case.
  const config = typeof r.config_json === 'string' ? JSON.parse(r.config_json) : r.config_json;
  // Stored configs were written through the save-path schema of their kind; a
  // row it rejects is a data-contract violation, passed through unchanged.
  checkDataContract(
    storedParserConfigSchema,
    { kind: r.kind, config },
    `custom_parser_configs row ${r.id}`,
  );
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    config,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const customParserConfigRepository = {
  async getAll(kind = 'transaction'): Promise<FormattedCustomParserConfig[]> {
    const result = await query<CustomParserConfigRow>(
      `SELECT ${COLUMNS} FROM custom_parser_configs WHERE kind = $1 ORDER BY name ASC`,
      [kind],
    );
    return result.rows.map(mapRow);
  },

  async getById(id: number): Promise<FormattedCustomParserConfig | undefined> {
    const result = await query<CustomParserConfigRow>(`SELECT ${COLUMNS} FROM custom_parser_configs WHERE id = $1`, [id]);
    const r = result.rows[0];
    return r ? mapRow(r) : undefined;
  },

  async getByName(
    name: string,
    kind = 'transaction',
  ): Promise<FormattedCustomParserConfig | undefined> {
    const result = await query<CustomParserConfigRow>(
      `SELECT ${COLUMNS} FROM custom_parser_configs WHERE name = $1 AND kind = $2`,
      [name, kind],
    );
    const r = result.rows[0];
    return r ? mapRow(r) : undefined;
  },

  async create({
    name,
    config,
    kind = 'transaction',
  }: {
    name: string;
    config: unknown;
    kind?: string;
  }): Promise<FormattedCustomParserConfig> {
    const result = await query<CustomParserConfigRow>(
      `INSERT INTO custom_parser_configs (name, kind, config_json)
       VALUES ($1, $2, $3::jsonb)
       RETURNING ${COLUMNS}`,
      [name, kind, JSON.stringify(config)],
    );
    return mapRow(result.rows[0]);
  },

  async update(
    id: number,
    { name, config }: { name?: string; config?: unknown },
  ): Promise<FormattedCustomParserConfig | undefined> {
    // Shared clause builder (lib/sqlClauses.ts): undefined fields are skipped.
    const { clauses: fields, params: values, nextIdx: idx } = buildSetClauses({
      name,
      config_json: config !== undefined ? JSON.stringify(config) : undefined,
    });
    // config_json needs the ::jsonb cast the generic builder does not emit.
    const castFields = fields.map((f) => f.startsWith('config_json = ') ? `${f}::jsonb` : f);

    if (castFields.length === 0) return this.getById(id);

    values.push(id);
    const result = await query<CustomParserConfigRow>(
      `UPDATE custom_parser_configs SET ${castFields.join(', ')} WHERE id = $${idx} RETURNING ${COLUMNS}`,
      values,
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  },

  /** @returns true if a row was removed */
  async delete(id: number): Promise<boolean> {
    const result = await query(`DELETE FROM custom_parser_configs WHERE id = $1 RETURNING id`, [id]);
    return result.rows.length > 0;
  },
};

export default customParserConfigRepository;
