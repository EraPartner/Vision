/**
 * Provider Health Repository — data access for the provider_health table.
 *
 * Table is defined in db/migrations/0001_baseline.sql.
 * All mutations use parameterised queries.
 */

import { sql } from 'kysely';
import { checkedRow, checkedRows, db } from '../database/db.ts';
import { providerHealthRowSchema } from '../database/rows/portfolio.ts';
import type { ProviderHealthDbRow } from '../database/rows/portfolio.ts';

/** A `provider_health` row; `kind` is 'price' | 'fx' | 'inflation' | 'import'. */
export type ProviderHealth = ProviderHealthDbRow;

function selectHealth() {
  return db
    .selectFrom('provider_health')
    .select([
      'provider',
      'kind',
      'last_success_at',
      'last_error_at',
      'last_error',
      'consecutive_failures',
      'updated_at',
    ]);
}

/**
 * Return all provider health rows ordered by kind, then provider.
 */
async function listAll(): Promise<ProviderHealth[]> {
  return checkedRows(
    providerHealthRowSchema,
    selectHealth().orderBy('kind', 'asc').orderBy('provider', 'asc'),
  );
}

/**
 * Return a single row by provider key, or null.
 */
async function findByProvider(
  provider: string,
): Promise<ProviderHealth | null> {
  const row = await checkedRow(
    providerHealthRowSchema,
    selectHealth().where('provider', '=', provider),
  );
  return row ?? null;
}

/**
 * Upsert a success event: clear error state, reset consecutive_failures.
 */
async function recordSuccess(provider: string, kind: string): Promise<void> {
  await db
    .insertInto('provider_health')
    .values({
      provider,
      kind,
      last_success_at: sql<Date>`NOW()`,
      consecutive_failures: 0,
      updated_at: sql<Date>`NOW()`,
    })
    .onConflict((oc) =>
      oc.column('provider').doUpdateSet({
        last_success_at: sql<Date>`NOW()`,
        consecutive_failures: 0,
        updated_at: sql<Date>`NOW()`,
      }),
    )
    .execute();
}

/**
 * Upsert an error event: set last_error, increment consecutive_failures.
 */
async function recordError(
  provider: string,
  kind: string,
  errorMessage: string,
): Promise<void> {
  const lastError = String(errorMessage).slice(0, 1000);
  await db
    .insertInto('provider_health')
    .values({
      provider,
      kind,
      last_error_at: sql<Date>`NOW()`,
      last_error: lastError,
      consecutive_failures: 1,
      updated_at: sql<Date>`NOW()`,
    })
    .onConflict((oc) =>
      oc.column('provider').doUpdateSet((eb) => ({
        last_error_at: sql<Date>`NOW()`,
        last_error: lastError,
        consecutive_failures: eb('provider_health.consecutive_failures', '+', 1),
        updated_at: sql<Date>`NOW()`,
      })),
    )
    .execute();
}

export default { listAll, findByProvider, recordSuccess, recordError };
