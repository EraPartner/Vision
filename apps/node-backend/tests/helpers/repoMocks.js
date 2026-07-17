/**
 * Shared `vi.mock('.../database/connection.js', ...)` factories.
 *
 * Repository/service tests re-implement the connection mock in dozens of
 * files with three recurring shapes; these helpers centralize them. The
 * function names are prefixed with `mock` so they may be referenced inside
 * hoisted `vi.mock` factories (same convention as `mockLogger`).
 *
 * Usage:
 *   import { mockConnection, mockTxConnection } from '../helpers/repoMocks.js';
 *   vi.mock('../src/database/connection.js', () => mockConnection());
 *   vi.mock('../src/database/connection.js', () => mockTxConnection());
 */
import { vi } from 'vitest';

/**
 * Inert connection mock: `query` and `withTransaction` are bare spies.
 * Pass `extra` to add or override members (e.g. a primed `query`,
 * `getClient`, `queryPrepared`, `withSavepointIfInTransaction`).
 *
 * @param {Record<string, any>} [extra]
 */
export function mockConnection(extra = {}) {
  return { query: vi.fn(), withTransaction: vi.fn(), ...extra };
}

/**
 * Connection mock whose `withTransaction` runs the callback immediately with
 * a client (a throw propagates = rollback). With no argument the client
 * shares the module-level `query` spy so tests can route pooled and
 * transactional SQL through one mock; pass a `client` to use it instead.
 *
 * @param {{ query: import('vitest').Mock } & Record<string, any>} [client]
 * @param {Record<string, any>} [extra]
 */
export function mockTxConnection(client, extra = {}) {
  const query = vi.fn();
  return {
    query,
    withTransaction: vi.fn(async (fn) => fn(client ?? { query })),
    ...extra,
  };
}

/**
 * Connection mock with the full client-pool transaction ceremony:
 * `withTransaction` checks out `getClient()`, issues BEGIN/COMMIT (ROLLBACK
 * on error) through the client, and releases it — so tests can assert
 * transaction semantics on the client's `query` spy. Tests prime
 * `getClient.mockResolvedValue({ query, release })` per case.
 */
export function mockPooledTxConnection() {
  const getClient = vi.fn();
  return {
    query: vi.fn(),
    getClient,
    withTransaction: vi.fn(async (fn) => {
      const client = await getClient();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* rollback failure is secondary */
        }
        throw err;
      } finally {
        client.release();
      }
    }),
  };
}
