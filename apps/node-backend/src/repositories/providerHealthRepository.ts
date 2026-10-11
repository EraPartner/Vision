/**
 * Provider Health Repository — data access for the provider_health table.
 *
 * Table is created by Alembic migration 0010_add_provider_health.
 * All mutations use parameterised queries.
 */

import { query } from '../database/connection.ts';
import { queryOne, queryRows } from '../database/rowContracts.ts';
import { providerHealthRowSchema } from '../database/rows/portfolio.ts';
import type { ProviderHealthDbRow } from '../database/rows/portfolio.ts';

/** A `provider_health` row; `kind` is 'price' | 'fx' | 'inflation' | 'import'. */
export type ProviderHealth = ProviderHealthDbRow;

/**
 * Return all provider health rows ordered by kind, then provider.
 */
async function listAll(): Promise<ProviderHealth[]> {
  return queryRows(
    providerHealthRowSchema,
    `SELECT provider, kind, last_success_at, last_error_at, last_error,
            consecutive_failures, updated_at
       FROM provider_health
      ORDER BY kind ASC, provider ASC`,
  );
}

/**
 * Return a single row by provider key, or null.
 */
async function findByProvider(
  provider: string,
): Promise<ProviderHealth | null> {
  const row = await queryOne(
    providerHealthRowSchema,
    `SELECT provider, kind, last_success_at, last_error_at, last_error,
            consecutive_failures, updated_at
       FROM provider_health
      WHERE provider = $1`,
    [provider],
  );
  return row ?? null;
}

/**
 * Upsert a success event: clear error state, reset consecutive_failures.
 */
async function recordSuccess(provider: string, kind: string): Promise<void> {
  await query(
    `INSERT INTO provider_health (provider, kind, last_success_at, consecutive_failures, updated_at)
          VALUES ($1, $2, NOW(), 0, NOW())
     ON CONFLICT (provider) DO UPDATE
        SET last_success_at      = NOW(),
            consecutive_failures = 0,
            updated_at           = NOW()`,
    [provider, kind],
  );
}

/**
 * Upsert an error event: set last_error, increment consecutive_failures.
 */
async function recordError(
  provider: string,
  kind: string,
  errorMessage: string,
): Promise<void> {
  await query(
    `INSERT INTO provider_health
            (provider, kind, last_error_at, last_error, consecutive_failures, updated_at)
          VALUES ($1, $2, NOW(), $3, 1, NOW())
     ON CONFLICT (provider) DO UPDATE
        SET last_error_at        = NOW(),
            last_error           = $3,
            consecutive_failures = provider_health.consecutive_failures + 1,
            updated_at           = NOW()`,
    [provider, kind, String(errorMessage).slice(0, 1000)],
  );
}

export default { listAll, findByProvider, recordSuccess, recordError };
