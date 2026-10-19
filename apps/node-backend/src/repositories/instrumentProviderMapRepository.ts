/**
 * Instrument Provider Map Repository — data access for instrument_provider_map.
 *
 * Table is defined in db/migrations/0001_baseline.sql. Holds the user-confirmed
 * cross-provider symbol map (ADR-079): one row per (instrument_key, key_type,
 * provider). All mutations use parameterised queries.
 */

import { sql } from 'kysely';
import { checkedRow, checkedRows, db } from '../database/db.ts';
import { instrumentProviderMapRowSchema } from '../database/rows/portfolio.ts';
import type { InstrumentProviderMapRow } from '../types/rows.ts';

export type { InstrumentProviderMapRow };

const COLUMNS = [
  'id',
  'instrument_key',
  'key_type',
  'provider',
  'provider_symbol',
  'resolved_name',
  'exchange',
  'currency',
  'status',
  'verified_at',
  'created_at',
  'updated_at',
] as const;

/**
 * All mappings for an instrument, ordered by provider.
 * @param keyType  'isin' | 'internal'
 */
export async function listByInstrument(
  instrumentKey: string,
  keyType: string,
): Promise<InstrumentProviderMapRow[]> {
  return checkedRows(
    instrumentProviderMapRowSchema,
    db
      .selectFrom('instrument_provider_map')
      .select(COLUMNS)
      .where('instrument_key', '=', instrumentKey)
      .where('key_type', '=', keyType)
      .orderBy('provider', 'asc'),
  );
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
  providerSymbol?: string | null | undefined;
  resolvedName?: string | null | undefined;
  exchange?: string | null | undefined;
  currency?: string | null | undefined;
  status?: string | null | undefined;
}): Promise<InstrumentProviderMapRow> {
  const row = await checkedRow(
    instrumentProviderMapRowSchema,
    db
      .insertInto('instrument_provider_map')
      .values({
        instrument_key: m.instrumentKey,
        key_type: m.keyType,
        provider: m.provider,
        provider_symbol: m.providerSymbol ?? null,
        resolved_name: m.resolvedName ?? null,
        exchange: m.exchange ?? null,
        currency: m.currency ?? null,
        status: m.status ?? 'confirmed',
        updated_at: sql<Date>`NOW()`,
      })
      .onConflict((oc) =>
        oc.columns(['instrument_key', 'key_type', 'provider']).doUpdateSet((eb) => ({
          provider_symbol: eb.ref('excluded.provider_symbol'),
          resolved_name: eb.ref('excluded.resolved_name'),
          exchange: eb.ref('excluded.exchange'),
          currency: eb.ref('excluded.currency'),
          status: eb.ref('excluded.status'),
          updated_at: sql<Date>`NOW()`,
        })),
      )
      .returning(COLUMNS),
  );
  // An upsert without a DO UPDATE WHERE always returns its row or throws.
  if (!row) throw new Error('Instrument provider map upsert returned no row');
  return row;
}

/**
 * Delete a mapping by id.
 * @returns true if a row was removed
 * @public Reached through the injectable repository in researchMappingService.
 */
export async function deleteById(id: number): Promise<boolean> {
  const result = await db
    .deleteFrom('instrument_provider_map')
    .where('id', '=', id)
    .executeTakeFirst();
  return result.numDeletedRows > 0n;
}

/**
 * Stamp verified_at = NOW() on all mappings for an instrument (after a self-audit).
 * @returns rows stamped
 * @public Reached through the injectable repository in researchMappingService.
 */
export async function markVerified(
  instrumentKey: string,
  keyType: string,
): Promise<number | null> {
  const result = await db
    .updateTable('instrument_provider_map')
    .set({ verified_at: sql<Date>`NOW()` })
    .where('instrument_key', '=', instrumentKey)
    .where('key_type', '=', keyType)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}
