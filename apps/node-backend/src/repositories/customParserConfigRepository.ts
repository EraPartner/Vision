import { sql } from 'kysely';
import { checkedRow, checkedRows, db } from '../database/db.ts';
import { customParserConfigRowSchema } from '../database/rows/imports.ts';
import { checkDataContract } from '../lib/dataContract.ts';
import { storedParserConfigSchema } from '../lib/parserConfigSchema.ts';

import type {
  CustomParserConfigRow,
  FormattedCustomParserConfig,
} from '../types/rows.ts';

export type { FormattedCustomParserConfig };

const COLUMNS = ['id', 'name', 'kind', 'config_json', 'created_at', 'updated_at'] as const;

function selectConfigs() {
  return db.selectFrom('custom_parser_configs').select(COLUMNS);
}

function mapRow(r: CustomParserConfigRow): FormattedCustomParserConfig {
  // pg returns JSONB already parsed; tolerate a string just in case.
  const config: unknown =
    typeof r.config_json === 'string' ? JSON.parse(r.config_json) : r.config_json;
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
    const rows = await checkedRows(
      customParserConfigRowSchema,
      selectConfigs().where('kind', '=', kind).orderBy('name', 'asc'),
    );
    return rows.map(mapRow);
  },

  async getById(id: number): Promise<FormattedCustomParserConfig | undefined> {
    const r = await checkedRow(
      customParserConfigRowSchema,
      selectConfigs().where('id', '=', id),
    );
    return r ? mapRow(r) : undefined;
  },

  async getByName(
    name: string,
    kind = 'transaction',
  ): Promise<FormattedCustomParserConfig | undefined> {
    const r = await checkedRow(
      customParserConfigRowSchema,
      selectConfigs().where('name', '=', name).where('kind', '=', kind),
    );
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
    const r = await checkedRow(
      customParserConfigRowSchema,
      db
        .insertInto('custom_parser_configs')
        .values({ name, kind, config_json: sql`${JSON.stringify(config)}::jsonb` })
        .returning(COLUMNS),
    );
    // INSERT ... RETURNING without ON CONFLICT yields its row or throws.
    if (!r) throw new Error('custom_parser_configs insert returned no row');
    return mapRow(r);
  },

  async update(
    id: number,
    { name, config }: { name?: string | undefined; config?: unknown },
  ): Promise<FormattedCustomParserConfig | undefined> {
    if (name === undefined && config === undefined) return this.getById(id);

    const r = await checkedRow(
      customParserConfigRowSchema,
      db
        .updateTable('custom_parser_configs')
        .set({
          ...(name !== undefined && { name }),
          ...(config !== undefined && {
            config_json: sql`${JSON.stringify(config)}::jsonb`,
          }),
        })
        .where('id', '=', id)
        .returning(COLUMNS),
    );
    return r ? mapRow(r) : undefined;
  },

  /** @returns true if a row was removed */
  async delete(id: number): Promise<boolean> {
    const deleted = await db
      .deleteFrom('custom_parser_configs')
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    return deleted !== undefined;
  },
};

export default customParserConfigRepository;
