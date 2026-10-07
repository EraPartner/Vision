/**
 * Instrument Provider Map Repository — data access for instrument_provider_map.
 *
 * Table is created by Alembic migration
 * 0042_add_research_provider_mapping_and_quota. Holds the user-confirmed
 * cross-provider symbol map (ADR-079): one row per (instrument_key, key_type,
 * provider). All mutations use parameterised queries.
 */

import { query } from '../database/connection.ts';
import type { InstrumentProviderMapRow } from '../types/rows.ts';

export type { InstrumentProviderMapRow };

const COLUMNS = `id, instrument_key, key_type, provider, provider_symbol,
                 resolved_name, exchange, currency, status, verified_at,
                 created_at, updated_at`;

/**
 * All mappings for an instrument, ordered by provider.
 * @param keyType  'isin' | 'internal'
 */
export async function listByInstrument(
  instrumentKey: string,
  keyType: string,
): Promise<InstrumentProviderMapRow[]> {
  const result = await query<InstrumentProviderMapRow>(
    `SELECT ${COLUMNS}
       FROM instrument_provider_map
      WHERE instrument_key = $1 AND key_type = $2
      ORDER BY provider ASC`,
    [instrumentKey, keyType],
  );
  return result.rows;
}

/**
 * Upsert one mapping. Conflict target is the (instrument_key, key_type, provider)
 * unique index; an existing row's symbol/name/exchange/currency/status are replaced.
 * @returns the upserted row
 */
export async function upsert(m: {
  instrumentKey: string;
  keyType: string;
  provider: string;
  providerSymbol?: string | null;
  resolvedName?: string | null;
  exchange?: string | null;
  currency?: string | null;
  status?: string | null;
}): Promise<InstrumentProviderMapRow> {
  const result = await query<InstrumentProviderMapRow>(
    `INSERT INTO instrument_provider_map
        (instrument_key, key_type, provider, provider_symbol, resolved_name, exchange, currency, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (instrument_key, key_type, provider) DO UPDATE
        SET provider_symbol = EXCLUDED.provider_symbol,
            resolved_name   = EXCLUDED.resolved_name,
            exchange        = EXCLUDED.exchange,
            currency        = EXCLUDED.currency,
            status          = EXCLUDED.status,
            updated_at      = NOW()
     RETURNING ${COLUMNS}`,
    [
      m.instrumentKey,
      m.keyType,
      m.provider,
      m.providerSymbol ?? undefined,
      m.resolvedName ?? undefined,
      m.exchange ?? undefined,
      m.currency ?? undefined,
      m.status ?? 'confirmed',
    ],
  );
  return result.rows[0];
}

/**
 * Delete a mapping by id.
 * @returns true if a row was removed
 */
export async function deleteById(id: number): Promise<boolean> {
  const result = await query(
    `DELETE FROM instrument_provider_map WHERE id = $1`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Stamp verified_at = NOW() on all mappings for an instrument (after a self-audit).
 * @returns rows stamped
 */
export async function markVerified(
  instrumentKey: string,
  keyType: string,
): Promise<number | null> {
  const result = await query(
    `UPDATE instrument_provider_map
        SET verified_at = NOW()
      WHERE instrument_key = $1 AND key_type = $2`,
    [instrumentKey, keyType],
  );
  return result.rowCount;
}
