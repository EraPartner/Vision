/**
 * Provider API Key Repository — data access for provider_api_keys.
 *
 * Table is defined in db/migrations/0001_baseline.sql. Stores Settings-managed research
 * provider API keys (ADR-079); one row per provider. The key is masked in API
 * responses by the service layer and never returned in full to the frontend.
 */

import { sql } from 'kysely';
import { checkedRows, db } from '../database/db.ts';
import { providerApiKeyRowSchema } from '../database/rows/portfolio.ts';
import type { ProviderApiKeyDbRow } from '../database/rows/portfolio.ts';

/** A `provider_api_keys` row. Derived from the checked row schema. */
export type ProviderApiKeyRow = ProviderApiKeyDbRow;

/**
 * All stored provider keys.
 */
export async function listAll(): Promise<ProviderApiKeyRow[]> {
  return checkedRows(
    providerApiKeyRowSchema,
    db
      .selectFrom('provider_api_keys')
      .select(['provider', 'api_key', 'updated_at'])
      .orderBy('provider', 'asc'),
  );
}

/**
 * Insert or replace a provider's key.
 */
export async function upsert(provider: string, apiKey: string): Promise<void> {
  await db
    .insertInto('provider_api_keys')
    .values({ provider, api_key: apiKey, updated_at: sql<Date>`NOW()` })
    .onConflict((oc) =>
      oc.column('provider').doUpdateSet((eb) => ({
        api_key: eb.ref('excluded.api_key'),
        updated_at: sql<Date>`NOW()`,
      })),
    )
    .execute();
}

/**
 * Delete a provider's stored key.
 * @returns true if a row was removed
 */
export async function remove(provider: string): Promise<boolean> {
  const result = await db
    .deleteFrom('provider_api_keys')
    .where('provider', '=', provider)
    .executeTakeFirst();
  return result.numDeletedRows > 0n;
}
