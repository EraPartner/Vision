/**
 * Unit tests for the shared connection-mock helpers themselves.
 *
 * `mockTxConnection` models the ambient transaction context of the real
 * connection.js: module-level `query`/`queryPrepared` run on the open
 * transaction's client instead of the pool. These tests pin that contract,
 * because service tests depend on it to keep asserting against
 * `client.query.mock.calls` once service SQL moves into repositories.
 */
import { describe, expect, it, vi } from 'vitest';

import { mockTxConnection } from './repoMocks.js';

describe('mockTxConnection — ambient transaction routing', () => {
  it('routes module-level query onto the transaction client while a tx is open', async () => {
    const client = { query: vi.fn(async () => ({ rows: [{ id: 1 }], rowCount: 1 })) };
    const conn = mockTxConnection(client);

    const result = await conn.withTransaction(async () => {
      // A repository call: module-level query(), no client threaded through.
      return conn.query('UPDATE transactions SET account_id = $1', [7]);
    });

    // The statement landed on the transaction's client, not the pool.
    expect(client.query).toHaveBeenCalledWith('UPDATE transactions SET account_id = $1', [7]);
    expect(conn.poolQuery).not.toHaveBeenCalled();
    // …and the client's result is handed back to the caller unchanged.
    expect(result).toEqual({ rows: [{ id: 1 }], rowCount: 1 });
  });

  it('does NOT route outside a transaction — module query falls back to the pool', async () => {
    const client = { query: vi.fn() };
    const conn = mockTxConnection(client);

    await conn.query('SELECT 1');

    expect(client.query).not.toHaveBeenCalled();
    expect(conn.poolQuery).toHaveBeenCalledWith('SELECT 1');
  });

  it('stops routing once the callback settles, including after a rollback', async () => {
    const client = { query: vi.fn() };
    const conn = mockTxConnection(client);

    // Resolve path.
    await conn.withTransaction(async () => {});
    await conn.query('SELECT after_commit');

    // Reject path: the throw propagates (= rollback) and must still invalidate.
    await expect(
      conn.withTransaction(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await conn.query('SELECT after_rollback');

    // Neither post-transaction statement leaked onto the released client.
    expect(client.query).not.toHaveBeenCalled();
    expect(conn.poolQuery.mock.calls.map(([sql]) => sql)).toEqual([
      'SELECT after_commit',
      'SELECT after_rollback',
    ]);
  });

  it('keeps lock-order assertions intact: mixed client/module SQL lands on ONE spy in order', async () => {
    // The pattern service tests rely on — FOR UPDATE locks taken via the
    // client, repointing statements issued by a repository through module
    // query(), all observable in issue order on a single spy.
    const client = { query: vi.fn(async () => ({ rows: [{ id: 2 }], rowCount: 1 })) };
    const conn = mockTxConnection(client);

    await conn.withTransaction(async (txClient) => {
      await txClient.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [2]);
      await conn.query('SELECT id FROM accounts WHERE id = ANY($1::int[]) FOR UPDATE', [[1]]);
      await conn.query('UPDATE transactions SET account_id = $1', [2]);
      await txClient.query('DELETE FROM accounts WHERE id = ANY($1::int[])', [[1]]);
    });

    const sqls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqls).toEqual([
      'SELECT id FROM accounts WHERE id = $1 FOR UPDATE',
      'SELECT id FROM accounts WHERE id = ANY($1::int[]) FOR UPDATE',
      'UPDATE transactions SET account_id = $1',
      'DELETE FROM accounts WHERE id = ANY($1::int[])',
    ]);
    // Both locks are visible on the one client, so `FOR UPDATE` counting works.
    expect(sqls.filter((s) => s.includes('FOR UPDATE'))).toHaveLength(2);
  });

  it('routes queryPrepared onto the transaction client in pg object form', async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })) };
    const conn = mockTxConnection(client);

    await conn.withTransaction(async () => conn.queryPrepared('tx_get_by_id', 'SELECT 1', [5]));

    expect(client.query).toHaveBeenCalledWith({
      name: 'tx_get_by_id',
      text: 'SELECT 1',
      values: [5],
    });
  });

  it('with no client the transaction shares the module spy (no self-routing recursion)', async () => {
    const conn = mockTxConnection();

    // Would recurse forever if the self-reference guard were missing.
    await conn.withTransaction(async (txClient) => {
      await txClient.query('UPDATE a SET b = 1');
      await conn.query('UPDATE c SET d = 2');
    });

    expect(conn.query.mock.calls.map(([sql]) => sql)).toEqual([
      'UPDATE a SET b = 1',
      'UPDATE c SET d = 2',
    ]);
  });

  it('treats extra.query as the POOL implementation so routing survives it', async () => {
    const client = { query: vi.fn(async () => ({ rows: ['tx'] })) };
    const poolImpl = vi.fn(async () => ({ rows: ['pool'] }));
    const conn = mockTxConnection(client, { query: poolImpl });

    expect(await conn.query('SELECT outside')).toEqual({ rows: ['pool'] });
    expect(await conn.withTransaction(async () => conn.query('SELECT inside'))).toEqual({ rows: ['tx'] });

    // The exported spy still records every call, so `query.mock.calls`
    // assertions in existing suites keep working.
    expect(conn.query.mock.calls.map(([sql]) => sql)).toEqual(['SELECT outside', 'SELECT inside']);
  });

  it('exposes the ambient client only while the transaction is open', async () => {
    const client = { query: vi.fn() };
    const conn = mockTxConnection(client);

    expect(conn.getAmbientTransactionClient()).toBeNull();
    await conn.withTransaction(async () => {
      expect(conn.getAmbientTransactionClient()).toBe(client);
    });
    expect(conn.getAmbientTransactionClient()).toBeNull();
  });
});
