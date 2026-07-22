import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../src/repositories/infoRepositoryHelpers.js', async () => {
  const actual = await vi.importActual('../src/repositories/infoRepositoryHelpers.js');
  return { ...actual, batchConvertGroupsWithHistoricalRateFallback: vi.fn() };
});

import { query } from '../src/database/connection.js';
import { batchConvertGroupsWithHistoricalRateFallback } from '../src/repositories/infoRepositoryHelpers.js';
import { banksRepository } from '../src/repositories/infoRepositoryBanks.js';
import { COMPUTED_BALANCE_LATERAL } from '../src/repositories/accountBalanceSql.js';

beforeEach(() => vi.clearAllMocks());

describe('banksRepository.getBankBalances', () => {
  it('returns empty when no transactions exist', async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([[], []]);
    const r = await banksRepository.getBankBalances();
    expect(r).toEqual({
      accounts: [],
      total_net_position: 0,
      history: {},
      total_history: [],
    });
  });

  it('builds account list with current balance and total net position', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          { bank_account: 'A', currency: 'EUR', balance: '1000', date: '2025-04-15', transaction_count: '10', first_transaction: '2024-01-01', last_transaction: '2025-04-15' },
          { bank_account: 'B', currency: 'USD', balance: '200', date: '2025-04-15', transaction_count: '5', first_transaction: '2024-06-01', last_transaction: '2025-04-15' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [
        { bank_account: 'A', amount_eur: 1000, transaction_count: '10', first_transaction: '2024-01-01', last_transaction: '2025-04-15' },
        { bank_account: 'B', amount_eur: 187.5, transaction_count: '5', first_transaction: '2024-06-01', last_transaction: '2025-04-15' },
      ],
      [],
    ]);

    const r = await banksRepository.getBankBalances();
    expect(r.accounts).toHaveLength(2);
    expect(r.accounts[0]).toMatchObject({ bank_account: 'A', balance: 1000, transaction_count: 10 });
    expect(r.accounts[1]).toMatchObject({ bank_account: 'B', balance: 187.5, transaction_count: 5 });
    expect(r.total_net_position).toBe(1187.5);
  });

  it('groups historical balances by bank account, sorted by date asc', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { bank_account: 'A', day: '2025-03-14', currency: 'EUR', balance: '900', date: '2025-03-14' },
          { bank_account: 'A', day: '2025-03-15', currency: 'EUR', balance: '1000', date: '2025-03-15' },
          { bank_account: 'B', day: '2025-03-15', currency: 'EUR', balance: '500', date: '2025-03-15' },
        ],
      });

    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [],
      [
        { bank_account: 'A', day: '2025-03-15', amount_eur: 1000 },
        { bank_account: 'A', day: '2025-03-14', amount_eur: 900 },
        { bank_account: 'B', day: '2025-03-15', amount_eur: 500 },
      ],
    ]);

    const r = await banksRepository.getBankBalances();
    expect(r.history.A).toEqual([
      { date: '2025-03-14', balance: 900 },
      { date: '2025-03-15', balance: 1000 },
    ]);
    expect(r.history.B).toEqual([{ date: '2025-03-15', balance: 500 }]);
  });

  it('aggregates total_history by summing balances across all banks per day', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [],
      [
        { bank_account: 'A', day: '2025-03-15', amount_eur: 1000 },
        { bank_account: 'B', day: '2025-03-15', amount_eur: 500 },
        { bank_account: 'A', day: '2025-03-14', amount_eur: 900 },
      ],
    ]);

    const r = await banksRepository.getBankBalances();
    expect(r.total_history).toEqual([
      { date: '2025-03-14', balance: 900 },
      { date: '2025-03-15', balance: 1500 },
    ]);
  });

  it('formats a Date-shaped day defensively as YYYY-MM-DD', async () => {
    // The SQL emits day via to_char so it always arrives as a string; the Date
    // branch is defensive (local getters — not toISOString) for pg-DATE shapes.
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [],
      [{ bank_account: 'A', day: new Date(2025, 3, 1), amount_eur: 100 }],
    ]);

    const r = await banksRepository.getBankBalances();
    expect(r.history.A[0].date).toBe('2025-04-01');
  });

  it('drops history rows missing a bank_account', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ bank_account: null, day: '2025-04-01', currency: 'EUR', balance: '100' }],
      });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([[], []]);

    const r = await banksRepository.getBankBalances();
    expect(r.history).toEqual({});
  });

  it('carries display_name, native drift and balance provenance per account (WP-A1)', async () => {
    // Three fixture shapes:
    //  (a) manual-only — nothing ever stamped: no anchor_date, count = ALL
    //      active rows, no statement balance so no drift;
    //  (b) stamped + manual rows after the anchor: anchor_date + entries-since
    //      + a native-currency drift matching the hub badge;
    //  (c) display_name falls back to the account name when unset.
    query
      .mockResolvedValueOnce({
        rows: [
          { bank_account: 'Cash', display_name: 'Cash', currency: 'EUR', balance: '200', drift: null, anchor_date: null, post_anchor_count: '3', transaction_count: '3', first_transaction: '2026-01-01', last_transaction: '2026-07-01' },
          { bank_account: 'BE12 3456', display_name: 'KBC Zichtrekening', currency: 'EUR', balance: '5100', drift: '-12.5', anchor_date: '2026-06-30', post_anchor_count: '2', transaction_count: '40', first_transaction: '2024-01-01', last_transaction: '2026-07-20' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [
        { bank_account: 'Cash', display_name: 'Cash', amount_eur: 200, drift: null, anchor_date: null, post_anchor_count: '3', transaction_count: '3', first_transaction: '2026-01-01', last_transaction: '2026-07-01' },
        { bank_account: 'BE12 3456', display_name: 'KBC Zichtrekening', amount_eur: 5100, drift: '-12.5', anchor_date: '2026-06-30', post_anchor_count: '2', transaction_count: '40', first_transaction: '2024-01-01', last_transaction: '2026-07-20' },
      ],
      [],
    ]);

    const r = await banksRepository.getBankBalances();

    // (a) manual-only: included with its computed Σ(amount) balance —
    // provenance says "sum of 3 entries" (no anchor). null → undefined
    // (backend never returns null), so JSON omits the absent fields.
    expect(r.accounts[0]).toMatchObject({
      bank_account: 'Cash',
      display_name: 'Cash',
      balance: 200,
      post_anchor_count: 3,
    });
    expect(r.accounts[0].anchor_date).toBeUndefined();
    expect(r.accounts[0].drift).toBeUndefined();

    // (b) stamped + manual: "as of 2026-06-30 statement + 2 entries since",
    // drift is the hub's native-currency figure.
    expect(r.accounts[1]).toMatchObject({
      bank_account: 'BE12 3456',
      display_name: 'KBC Zichtrekening',
      balance: 5100,
      drift: -12.5,
      anchor_date: '2026-06-30',
      post_anchor_count: 2,
    });

    // Both populate the widget — the old `balance IS NOT NULL` gate that hid
    // stamp-less accounts is gone.
    expect(r.accounts).toHaveLength(2);
    expect(r.total_net_position).toBe(5300);
  });

  it('falls back to the account name when display_name is absent', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ bank_account: 'Old Row', currency: 'EUR', balance: '10', transaction_count: '1', first_transaction: '2026-01-01', last_transaction: '2026-01-01' }],
      })
      .mockResolvedValueOnce({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [{ bank_account: 'Old Row', amount_eur: 10, transaction_count: '1', first_transaction: '2026-01-01', last_transaction: '2026-01-01' }],
      [],
    ]);

    const r = await banksRepository.getBankBalances();
    expect(r.accounts[0].display_name).toBe('Old Row');
  });

  it('selects display_name, drift and the lateral provenance columns in the current-balance SQL', async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([[], []]);

    await banksRepository.getBankBalances();

    const currentBalanceSql = query.mock.calls[0][0];
    expect(currentBalanceSql).toContain('COALESCE(a.display_name, a.name) AS display_name');
    expect(currentBalanceSql).toContain('a.statement_balance - COALESCE(lb.balance, 0)');
    expect(currentBalanceSql).toContain('lb.anchor_date');
    expect(currentBalanceSql).toContain('lb.post_anchor_count');
  });

  it('sources the current balance from the shared anchor+delta lateral (not a frozen stamped balance)', async () => {
    // Regression: the widget used to read the latest stamped `transactions.balance`,
    // freezing at the last imported statement figure and diverging from the accounts
    // hub. It must now consume the SAME COMPUTED_BALANCE_LATERAL the hub and
    // net-worth-by-account use, so all three surfaces agree by construction.
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([[], []]);

    await banksRepository.getBankBalances();

    const currentBalanceSql = query.mock.calls[0][0];
    expect(currentBalanceSql).toContain(COMPUTED_BALANCE_LATERAL.trim());
    // The balance is the lateral's anchored figure, not a frozen stamped row:
    // the old query keyed off `DISTINCT ON (t.account_id) ... t.balance` — that
    // shape must be gone.
    expect(currentBalanceSql).not.toContain('DISTINCT ON (t.account_id)');
  });

  it('gates BOTH queries on in_net_worth so the widget population matches net worth (§1 F3)', async () => {
    // Close semantics: closing an account sets in_net_worth=false, and
    // in_net_worth governs aggregates (is_active governs UI listing) — so a
    // closed/tracking-only account must vanish from the widget's current
    // balances AND its 12-month history the moment it is closed.
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([[], []]);

    await banksRepository.getBankBalances();

    const currentBalanceSql = query.mock.calls[0][0];
    const historySql = query.mock.calls[1][0];
    expect(currentBalanceSql).toContain('a.in_net_worth = true');
    expect(historySql).toContain('a.in_net_worth = true');
    // The pre-existing filters stay.
    expect(currentBalanceSql).toContain(`a.type <> 'liability'`);
    expect(currentBalanceSql).toContain('tx.transaction_count > 0');
    expect(historySql).toContain(`a.type <> 'liability'`);
  });

  it('runs the two queries in parallel', async () => {
    let resolveCurrent;
    let resolveHistory;
    query
      .mockImplementationOnce(() => new Promise((r) => { resolveCurrent = () => r({ rows: [] }); }))
      .mockImplementationOnce(() => new Promise((r) => { resolveHistory = () => r({ rows: [] }); }));
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([[], []]);

    const p = banksRepository.getBankBalances();
    expect(query).toHaveBeenCalledTimes(2); // both fired before either resolves
    resolveCurrent();
    resolveHistory();
    await p;
  });
});
