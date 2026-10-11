/**
 * Provider API Key Repository — data access for provider_api_keys.
 *
 * Table is created by Alembic migration 0043. Stores Settings-managed research
 * provider API keys (ADR-079); one row per provider. The key is masked in API
 * responses by the service layer and never returned in full to the frontend.
 */

import { query } from '../database/connection.ts';
import { queryRows } from '../database/rowContracts.ts';
import { providerApiKeyRowSchema } from '../database/rows/portfolio.ts';
import type { ProviderApiKeyDbRow } from '../database/rows/portfolio.ts';

/** A `provider_api_keys` row. Derived from the checked row schema. */
export type ProviderApiKeyRow = ProviderApiKeyDbRow;

/**
 * All stored provider keys.
 */
export async function listAll(): Promise<ProviderApiKeyRow[]> {
  return queryRows(
    providerApiKeyRowSchema,
    'SELECT provider, api_key, updated_at FROM provider_api_keys ORDER BY provider ASC',
  );
}

/**
 * Insert or replace a provider's key.
 */
export async function upsert(provider: string, apiKey: string): Promise<void> {
  await query(
    `INSERT INTO provider_api_keys (provider, api_key, updated_at)
          VALUES ($1, $2, NOW())
     ON CONFLICT (provider) DO UPDATE
        SET api_key = EXCLUDED.api_key,
            updated_at = NOW()`,
    [provider, apiKey],
  );
}

/**
 * Delete a provider's stored key.
 * @returns true if a row was removed
 */
export async function remove(provider: string): Promise<boolean> {
  const result = await query('DELETE FROM provider_api_keys WHERE provider = $1', [provider]);
  return (result.rowCount ?? 0) > 0;
}
