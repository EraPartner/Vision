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
 * Models the AMBIENT TRANSACTION CONTEXT of the real connection.js (added in
 * 32806e2): while a `withTransaction` callback is running, module-level
 * `query`/`queryPrepared` execute on that transaction's client instead of the
 * pool (connection.js:85-88 and :149-152). Without this the mock contradicted
 * production — a repository call made inside a transaction appeared to run on
 * the pool — so a service that composes repos inside `withTransaction` could
 * not be tested against the client at all. Because the routed SQL lands on the
 * supplied client's spy, assertions written against `client.query.mock.calls`
 * (statement text, params, lock ordering) keep working unchanged when service
 * SQL later moves into a repository.
 *
 * Routing stops as soon as the callback settles — resolve OR reject — mirroring
 * production's store invalidation, so a leaked continuation falls back to the
 * pool rather than writing on a released client.
 *
 * `extra.query`, when supplied, becomes the POOL-side implementation rather
 * than replacing the exported spy, so ambient routing survives it. The pool
 * sink is also returned as `poolQuery` for tests that need to prime pooled
 * statements without the priming being consumed by transactional ones.
 *
 * @param {{ query: import('vitest').Mock } & Record<string, any>} [client]
 * @param {Record<string, any>} [extra]
 */
export function mockTxConnection(client, extra = {}) {
  // Mirrors connection.js's txStorage store: holds the active transaction's
  // client while the callback runs, nulled when it settles.
  const store = { client: null };
  const { query: poolImpl, ...restExtra } = extra;
  const poolQuery = poolImpl ?? vi.fn();

  // `active.query !== query` is the self-reference guard for the no-client
  // case, where the transaction shares this very spy: routing there would
  // recurse forever, and the call is already being recorded on it.
  const ambient = () => {
    const active = store.client;
    return active && active.query !== query ? active : null;
  };

  const query = vi.fn((...args) => {
    const active = ambient();
    return active ? active.query(...args) : poolQuery(...args);
  });

  const queryPrepared = vi.fn((name, text, values) => {
    const active = ambient();
    // pg's object form, exactly as connection.js:151 passes it.
    return active ? active.query({ name, text, values }) : poolQuery(text, values);
  });

  const txClient = client ?? { query };

  const withSavepointIfInTransaction = vi.fn(async (name, fn) => {
    // Savepoint presence follows the ambient store directly. Unlike normal
    // query routing, the no-explicit-client case is valid here: its shared
    // query spy records the SAVEPOINT without recursively routing to itself.
    const active = store.client;
    if (!active) return fn();
    await active.query(`SAVEPOINT ${name}`);
    try {
      const result = await fn();
      await active.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      try {
        await active.query(`ROLLBACK TO SAVEPOINT ${name}`);
      } catch {
        // The production helper logs rollback failure and preserves the
        // original error. Tests only need the same propagation contract.
      }
      throw err;
    }
  });

  return {
    query,
    queryPrepared,
    poolQuery,
    getAmbientTransactionClient: vi.fn(() => store.client),
    withTransaction: vi.fn(async (fn) => {
      store.client = txClient;
      try {
        return await fn(txClient);
      } finally {
        store.client = null;
      }
    }),
    withSavepointIfInTransaction,
    ...restExtra,
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
