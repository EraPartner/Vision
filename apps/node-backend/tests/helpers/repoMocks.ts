/**
 * Shared `vi.mock('.../database/connection.ts', ...)` factories.
 *
 * Repository/service tests re-implement the connection mock in dozens of
 * files with three recurring shapes; these helpers centralize them. The
 * function names are prefixed with `mock` so they may be referenced inside
 * hoisted `vi.mock` factories (same convention as `mockLogger`).
 *
 * Usage:
 *   import { mockConnection, mockTxConnection } from '../helpers/repoMocks.ts';
 *   vi.mock('../src/database/connection.ts', () => mockConnection());
 *   vi.mock('../src/database/connection.ts', () => mockTxConnection());
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { vi } from "vitest";
import type { Mock } from "vitest";

/**
 * Any callable, as vitest's own (unexported) `Procedure`. Override slots use
 * it so inline implementations such as `withTransaction: (fn) => fn()` stay
 * contextually typed in the consuming test.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MockProcedure = (...args: any[]) => any;

/** Every export of `src/database/connection.ts`, as a spy. */
export interface ConnectionMockSurface {
  default: Record<string, unknown>;
  query: Mock;
  queryPrepared: Mock;
  getClient: Mock;
  getAmbientTransactionClient: Mock;
  withTransaction: Mock;
  withSavepointIfInTransaction: Mock;
  checkConnection: Mock;
  getTableCount: Mock;
  getPoolStats: Mock;
  closePool: Mock;
}

/** Members a test may add to or override on a connection mock. */
export type ConnectionMockOverrides = {
  [K in Exclude<keyof ConnectionMockSurface, "default">]?: MockProcedure;
} & { default?: Record<string, unknown> } & Record<string, unknown>;

/** The connection mock surface with the caller's overrides applied. */
export type ConnectionMock<E extends object> = Omit<
  ConnectionMockSurface,
  keyof E
> &
  E;

/** Minimal transaction client: a `query` spy, plus whatever else the test needs. */
export interface MockTxClient {
  query: Mock;
}

/** The pool-side `query` sink: the caller's `extra.query`, else a fresh spy. */
export type PoolQuery<E> = E extends { query: infer Q extends MockProcedure }
  ? Q
  : Mock;

/** `withTransaction` as the ambient-transaction mock implements it. */
export type TxRunner<C> = <T>(fn: (client: C) => T | Promise<T>) => Promise<T>;

/** `withSavepointIfInTransaction` as the ambient-transaction mock implements it. */
export type SavepointRunner = <T>(
  name: string,
  fn: () => T | Promise<T>,
) => Promise<T>;

/**
 * Connection surface of `mockTxConnection`. The two transaction helpers are
 * callable with their generic signatures (so callbacks get a typed client and
 * results keep their type) and remain full spies.
 */
export interface TxConnectionMockSurface<C> extends Omit<
  ConnectionMockSurface,
  "withTransaction" | "withSavepointIfInTransaction"
> {
  withTransaction: TxRunner<C> & Mock<TxRunner<C>>;
  withSavepointIfInTransaction: SavepointRunner & Mock<SavepointRunner>;
}

/**
 * `mockTxConnection`'s surface: the connection spies (with `query` always the
 * ambient-routing spy), the caller's other overrides, and the pool-side sink.
 */
export type TxConnectionMock<C, E extends object> = Omit<
  TxConnectionMockSurface<C>,
  Exclude<keyof E, "query">
> &
  Omit<E, "query"> & { poolQuery: PoolQuery<E> };

interface TxStore {
  client: MockTxClient | null;
  savepointCounter: { value: number };
  activeNested: Promise<unknown> | null;
}

function completeConnectionSurface<E extends object>(
  base: E,
): ConnectionMock<E> {
  const surface = {
    default: {},
    query: vi.fn(),
    queryPrepared: vi.fn(),
    getClient: vi.fn(),
    getAmbientTransactionClient: vi.fn(() => null),
    withTransaction: vi.fn(),
    withSavepointIfInTransaction: vi.fn(),
    checkConnection: vi.fn(),
    getTableCount: vi.fn(),
    getPoolStats: vi.fn(),
    closePool: vi.fn(),
    ...base,
  };
  return surface;
}

/**
 * Inert connection mock: `query` and `withTransaction` are bare spies.
 * Pass `extra` to add or override members (e.g. a primed `query`,
 * `getClient`, `queryPrepared`, `withSavepointIfInTransaction`).
 */
export function mockConnection(): ConnectionMockSurface;
export function mockConnection<E extends ConnectionMockOverrides>(
  extra: E,
): ConnectionMock<E>;
export function mockConnection(
  extra: ConnectionMockOverrides = {},
): ConnectionMockSurface & Record<string, unknown> {
  // The overloads carry the precise types; here an override may be any callable.
  return completeConnectionSurface({
    query: vi.fn(),
    withTransaction: vi.fn(),
    ...extra,
  }) as ConnectionMockSurface & Record<string, unknown>;
}

/**
 * Connection mock whose `withTransaction` runs the callback immediately with
 * a client (a throw propagates = rollback). With no argument the client
 * shares the module-level `query` spy so tests can route pooled and
 * transactional SQL through one mock; pass a `client` to use it instead.
 *
 * Models the AMBIENT TRANSACTION CONTEXT of the real connection.ts (added in
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
 */
export function mockTxConnection<C extends MockTxClient>(
  client?: C,
): TxConnectionMock<C, Record<never, never>>;
export function mockTxConnection<
  C extends MockTxClient,
  E extends ConnectionMockOverrides,
>(client: C | undefined, extra: E): TxConnectionMock<C, E>;
export function mockTxConnection(
  client?: MockTxClient,
  extra: ConnectionMockOverrides = {},
): TxConnectionMock<MockTxClient, ConnectionMockOverrides> {
  const txStorage = new AsyncLocalStorage<TxStore>();
  const { query: poolImpl, ...restExtra } = extra;
  const poolQuery: MockProcedure = poolImpl ?? vi.fn();

  // `active.query !== query` is the self-reference guard for the no-client
  // case, where the transaction shares this very spy: routing there would
  // recurse forever, and the call is already being recorded on it.
  const ambient = () => {
    const active = txStorage.getStore()?.client;
    return active && active.query !== query ? active : null;
  };

  const query: Mock = vi.fn((...args: unknown[]) => {
    const active = ambient();
    return active ? active.query(...args) : poolQuery(...args);
  });

  const queryPrepared = vi.fn(
    (name: string, text: string, values?: unknown[]) => {
      const active = ambient();
      // pg's object form, exactly as connection.js:151 passes it.
      return active
        ? active.query({ name, text, values })
        : poolQuery(text, values);
    },
  );

  const txClient: MockTxClient = client ?? { query };

  const withSavepointIfInTransaction = vi.fn(
    async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
      // Savepoint presence follows the ambient store directly. Unlike normal
      // query routing, the no-explicit-client case is valid here: its shared
      // query spy records the SAVEPOINT without recursively routing to itself.
      const active = txStorage.getStore()?.client;
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
    },
  );

  const withTransaction = vi.fn(
    async <T>(fn: (client: MockTxClient) => T | Promise<T>): Promise<T> => {
      const parentStore = txStorage.getStore();
      const ambientClient = parentStore?.client;
      if (parentStore && ambientClient) {
        if (parentStore.activeNested) {
          try {
            await parentStore.activeNested;
          } catch {
            // The active scope reports its own error.
          }
          throw new Error(
            "Concurrent sibling withTransaction calls are not supported; await nested transactions sequentially",
          );
        }
        const runNested = async () => {
          parentStore.savepointCounter.value += 1;
          const savepointName = `vision_nested_tx_${parentStore.savepointCounter.value}`;
          const childStore: TxStore = {
            client: ambientClient,
            savepointCounter: parentStore.savepointCounter,
            activeNested: null,
          };
          try {
            // The spy's recorded signature drops the generic; the result is fn's.
            return (await withSavepointIfInTransaction(savepointName, () =>
              txStorage.run(childStore, () => fn(ambientClient)),
            )) as T;
          } finally {
            childStore.client = null;
          }
        };
        const operation = runNested();
        parentStore.activeNested = operation;
        try {
          return await operation;
        } finally {
          if (parentStore.activeNested === operation) {
            parentStore.activeNested = null;
          }
        }
      }

      const store: TxStore = {
        client: txClient,
        savepointCounter: { value: 0 },
        activeNested: null,
      };
      try {
        return await txStorage.run(store, () => fn(txClient));
      } finally {
        store.client = null;
      }
    },
  );

  // The pool sink's static type comes from E (see PoolQuery), which the
  // implementation only sees as a MockProcedure.
  return completeConnectionSurface({
    query,
    queryPrepared,
    poolQuery,
    getAmbientTransactionClient: vi.fn(
      () => txStorage.getStore()?.client ?? null,
    ),
    withTransaction,
    withSavepointIfInTransaction,
    ...restExtra,
  }) as unknown as TxConnectionMock<MockTxClient, ConnectionMockOverrides>;
}

/**
 * Connection mock with the full client-pool transaction ceremony:
 * `withTransaction` checks out `getClient()`, issues BEGIN/COMMIT (ROLLBACK
 * on error) through the client, and releases it — so tests can assert
 * transaction semantics on the client's `query` spy. Tests prime
 * `getClient.mockResolvedValue({ query, release })` per case.
 */
export function mockPooledTxConnection(): ConnectionMock<{
  query: Mock;
  getClient: Mock;
  withTransaction: Mock;
}> {
  const getClient: Mock = vi.fn();
  return completeConnectionSurface({
    query: vi.fn(),
    getClient,
    withTransaction: vi.fn(async (fn: (client: unknown) => unknown) => {
      const client = await getClient();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* rollback failure is secondary */
        }
        throw err;
      } finally {
        client.release();
      }
    }),
  });
}
