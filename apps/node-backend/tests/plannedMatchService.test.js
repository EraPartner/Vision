import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockListActiveUnexecuted = vi.fn();
const mockListRecentUnlinked = vi.fn();
const mockGetClusterRootMap = vi.fn();
const mockSettingsGet = vi.fn();
const mockExecutePlanned = vi.fn();

vi.mock('../src/repositories/plannedTransactionRepository.js', () => ({
  default: { listActiveUnexecuted: (...a) => mockListActiveUnexecuted(...a) },
}));
vi.mock('../src/repositories/transactionRepository.js', () => ({
  default: { listRecentUnlinked: (...a) => mockListRecentUnlinked(...a) },
}));
vi.mock('../src/repositories/recipientRepository.js', () => ({
  default: { getClusterRootMap: (...a) => mockGetClusterRootMap(...a) },
}));
vi.mock('../src/repositories/settingsRepository.js', () => ({
  default: { get: (...a) => mockSettingsGet(...a) },
}));
vi.mock('../src/services/plannedExecutionService.js', () => ({
  executePlanned: (...a) => mockExecutePlanned(...a),
}));
vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  matchesTolerance,
  autoLinkTransactions,
  getMatchSuggestions,
} from '../src/services/plannedMatchService.js';

const planned = (over = {}) => ({
  id: 1,
  recipient_id: 42,
  recipient_cluster_id: 42,
  amount: '-100.00',
  planned_date: '2026-07-01',
  currency: 'EUR',
  is_recurring: true,
  recipient_name: 'Spotify',
  ...over,
});

const tx = (over = {}) => ({
  id: 1000,
  recipient_id: 42,
  recipient_cluster_id: 42,
  amount: '-100.00',
  transaction_date: '2026-07-01',
  currency: 'EUR',
  recipient_name: 'Spotify',
  ...over,
});

describe('matchesTolerance', () => {
  it('matches identical recipient/amount/date', () => {
    expect(matchesTolerance(planned(), tx())).toBe(true);
  });

  it('accepts amount within 5% and rejects beyond it', () => {
    expect(matchesTolerance(planned(), tx({ amount: '-104.00' }))).toBe(true); // 4%
    expect(matchesTolerance(planned(), tx({ amount: '-106.00' }))).toBe(false); // 6%
  });

  it('applies the max(1, 5%) floor for small amounts', () => {
    const p = planned({ amount: '-10.00' }); // 5% = 0.50 -> floor to 1.00
    expect(matchesTolerance(p, tx({ amount: '-11.00' }))).toBe(true);
    expect(matchesTolerance(p, tx({ amount: '-11.50' }))).toBe(false);
  });

  it('rejects sign mismatch', () => {
    expect(matchesTolerance(planned({ amount: '-50.00' }), tx({ amount: '50.00' }))).toBe(false);
  });

  it('accepts date within ±5 days and rejects beyond', () => {
    expect(matchesTolerance(planned(), tx({ transaction_date: '2026-07-06' }))).toBe(true);
    expect(matchesTolerance(planned(), tx({ transaction_date: '2026-06-26' }))).toBe(true);
    expect(matchesTolerance(planned(), tx({ transaction_date: '2026-07-07' }))).toBe(false);
  });

  it('rejects a different recipient cluster', () => {
    expect(matchesTolerance(planned(), tx({ recipient_cluster_id: 7 }))).toBe(false);
  });

  it('handles pg Date objects for the date fields', () => {
    const p = planned({ planned_date: new Date(2026, 6, 1) }); // local midnight Jul 1
    expect(matchesTolerance(p, tx({ transaction_date: new Date(2026, 6, 3) }))).toBe(true);
  });
});

describe('autoLinkTransactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettingsGet.mockResolvedValue({}); // enabled (key undefined -> default ON)
    mockGetClusterRootMap.mockResolvedValue(new Map([[42, 42], [7, 7]]));
    mockExecutePlanned.mockResolvedValue({ duplicate: false, current: {} });
  });

  it('auto-executes a single unambiguous match', async () => {
    mockListActiveUnexecuted.mockResolvedValue([planned({ id: 1 })]);
    const res = await autoLinkTransactions([{ id: 1000, recipient_id: 42, amount: '-100.00', transaction_date: '2026-07-01' }]);
    expect(res.autoLinkedCount).toBe(1);
    expect(res.links).toEqual([{ plannedTransactionId: 1, transactionId: 1000 }]);
    expect(mockExecutePlanned).toHaveBeenCalledWith({ id: 1, executedTransactionId: 1000, executionDate: '2026-07-01' });
  });

  it('does not execute when the tx matches two planned payments', async () => {
    mockListActiveUnexecuted.mockResolvedValue([planned({ id: 1 }), planned({ id: 2 })]);
    const res = await autoLinkTransactions([{ id: 1000, recipient_id: 42, amount: '-100.00', transaction_date: '2026-07-01' }]);
    expect(res.autoLinkedCount).toBe(0);
    expect(mockExecutePlanned).not.toHaveBeenCalled();
  });

  it('does not execute when two txs match the same planned payment (direction-2 guard)', async () => {
    mockListActiveUnexecuted.mockResolvedValue([planned({ id: 1 })]);
    const res = await autoLinkTransactions([
      { id: 1000, recipient_id: 42, amount: '-100.00', transaction_date: '2026-07-01' },
      { id: 1001, recipient_id: 42, amount: '-100.00', transaction_date: '2026-07-02' },
    ]);
    expect(res.autoLinkedCount).toBe(0);
    expect(mockExecutePlanned).not.toHaveBeenCalled();
  });

  it('skips entirely when the setting is off', async () => {
    mockSettingsGet.mockResolvedValue({ autoClearPlannedOnMatch: false });
    mockListActiveUnexecuted.mockResolvedValue([planned({ id: 1 })]);
    const res = await autoLinkTransactions([{ id: 1000, recipient_id: 42, amount: '-100.00', transaction_date: '2026-07-01' }]);
    expect(res.autoLinkedCount).toBe(0);
    expect(mockListActiveUnexecuted).not.toHaveBeenCalled();
    expect(mockExecutePlanned).not.toHaveBeenCalled();
  });

  it('counts a duplicate replay as not newly linked', async () => {
    mockListActiveUnexecuted.mockResolvedValue([planned({ id: 1 })]);
    mockExecutePlanned.mockResolvedValue({ duplicate: true, current: {} });
    const res = await autoLinkTransactions([{ id: 1000, recipient_id: 42, amount: '-100.00', transaction_date: '2026-07-01' }]);
    expect(res.autoLinkedCount).toBe(0);
    expect(res.links).toEqual([]);
  });

  it('returns early with no planned payments', async () => {
    mockListActiveUnexecuted.mockResolvedValue([]);
    const res = await autoLinkTransactions([{ id: 1000, recipient_id: 42, amount: '-100.00', transaction_date: '2026-07-01' }]);
    expect(res.autoLinkedCount).toBe(0);
    expect(mockExecutePlanned).not.toHaveBeenCalled();
  });
});

describe('getMatchSuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns planned payments with their candidate transactions', async () => {
    mockListActiveUnexecuted.mockResolvedValue([planned({ id: 1, amount: '-14.99' })]);
    mockListRecentUnlinked.mockResolvedValue([
      tx({ id: 1000, amount: '-14.99', transaction_date: '2026-07-02' }),
      tx({ id: 1001, recipient_cluster_id: 999 }), // different cluster, excluded
    ]);
    const res = await getMatchSuggestions();
    expect(res).toHaveLength(1);
    expect(res[0].planned.id).toBe(1);
    expect(res[0].candidates).toHaveLength(1);
    expect(res[0].candidates[0].id).toBe(1000);
  });

  it('returns empty when no planned payments are active', async () => {
    mockListActiveUnexecuted.mockResolvedValue([]);
    const res = await getMatchSuggestions();
    expect(res).toEqual([]);
    expect(mockListRecentUnlinked).not.toHaveBeenCalled();
  });
});
