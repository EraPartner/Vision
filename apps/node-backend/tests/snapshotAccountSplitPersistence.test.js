import { describe, it, expect, vi, beforeEach } from 'vitest';

import { mockLogger } from './helpers/mockLogger.js';
import { mockTxConnection } from './helpers/repoMocks.js';
// computeAndStoreSnapshots writes both the aggregate snapshots and the ADR-100
// per-account split into portfolio_snapshot_accounts (migration 0074), inside a
// single transaction. client.query and query share one mock so we can inspect
// every statement the writer issued.
vi.mock('../src/database/connection.js', () => mockTxConnection());

vi.mock('../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import { query } from '../src/database/connection.js';
import { computeAndStoreSnapshots } from '../src/services/portfolio/snapshotBuilder.js';

beforeEach(() => vi.clearAllMocks());

// Route each query by SQL fragment so the writer's flow (builder reads →
// column/table probes → transaction writes) is deterministic regardless of call
// order. `accountsTableExists` toggles the migration-0074 probe.
function routeQueries({ txns, prices, accountsTableExists }) {
  query.mockImplementation(async (sql) => {
    if (sql.includes('MIN(first_date)')) return { rows: [{ first_data_date: '2026-07-10' }] };
    if (sql.includes("asset_class IN ('stock'")) {
      return { rows: [{ id: 1, currency: 'EUR', current_price: 10, asset_class: 'stock' }] };
    }
    if (sql.includes('FROM portfolio_transactions')) return { rows: txns };
    if (sql.includes('interest_rate')) return { rows: [] };            // non-unit investments
    if (sql.includes('asset_price_history')) return { rows: prices };
    if (sql.includes('belgian_inflation_rates')) return { rows: [] };
    if (sql.includes('is_latest = true')) return { rows: [] };         // fx latest
    if (sql.includes('FROM exchange_rates')) return { rows: [] };      // fx history
    if (sql.includes('value_fx_neutral')) return { rows: [{}] };       // hasFxNeutralColumn
    if (sql.includes("table_name = 'portfolio_snapshot_accounts'")) {
      return { rows: accountsTableExists ? [{}] : [] };                // hasSnapshotAccountsTable
    }
    return { rows: [] };                                               // DELETE / INSERT
  });
}

function accountSplitInserts() {
  return query.mock.calls.filter(([sql]) => /INSERT INTO portfolio_snapshot_accounts/.test(sql));
}

describe('per-account snapshot split persistence (migration 0074)', () => {
  it('persists value_by_account into portfolio_snapshot_accounts inside the transaction', async () => {
    routeQueries({
      txns: [
        { investment_id: 1, day: '2026-07-10', type: 'buy', amount: 60, units: 6, currency: 'EUR', fx_rate_to_eur: null, account_id: 10 },
        { investment_id: 1, day: '2026-07-10', type: 'buy', amount: 40, units: 4, currency: 'EUR', fx_rate_to_eur: null, account_id: 20 },
      ],
      prices: [{ investment_id: 1, day: '2026-07-10', close_price: 10 }],
      accountsTableExists: true,
    });

    await computeAndStoreSnapshots('EUR');

    const inserts = accountSplitInserts();
    expect(inserts.length).toBeGreaterThan(0);

    // Flatten every persisted (currency, account_key, value) triple.
    const persisted = [];
    for (const [sql, params] of inserts) {
      expect(sql).toContain('ON CONFLICT (snapshot_date, currency, account_key)');
      for (let i = 0; i < params.length; i += 4) {
        persisted.push({ currency: params[i + 1], accountKey: params[i + 2], value: params[i + 3] });
      }
    }

    // 10 units @ €10 = €100 split 60/40 across accounts 10 and 20, every day.
    const acct10 = persisted.filter((r) => r.accountKey === '10');
    const acct20 = persisted.filter((r) => r.accountKey === '20');
    expect(acct10.length).toBeGreaterThan(0);
    expect(acct20.length).toBeGreaterThan(0);
    expect(acct10[0].value).toBeCloseTo(60, 2);
    expect(acct20[0].value).toBeCloseTo(40, 2);
    expect(persisted.every((r) => r.currency === 'EUR')).toBe(true);
    // Sparse by construction: no zero-value rows are written.
    expect(persisted.every((r) => Number(r.value) !== 0)).toBe(true);
  });

  it('degrades gracefully when the side table is absent (no split writes)', async () => {
    routeQueries({
      txns: [
        { investment_id: 1, day: '2026-07-10', type: 'buy', amount: 100, units: 10, currency: 'EUR', fx_rate_to_eur: null, account_id: 10 },
      ],
      prices: [{ investment_id: 1, day: '2026-07-10', close_price: 10 }],
      accountsTableExists: false,
    });

    await computeAndStoreSnapshots('EUR');
    expect(accountSplitInserts().length).toBe(0);
  });
});
