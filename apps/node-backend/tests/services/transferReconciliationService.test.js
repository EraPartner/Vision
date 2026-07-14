import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockClient } = vi.hoisted(() => ({ mockClient: { query: vi.fn() } }));

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  withTransaction: vi.fn(async (fn) => fn(mockClient)),
}));

import { query } from '../../src/database/connection.js';
import {
  unmarkTransfer,
  markTransfer,
  reconcileTransfers,
  getTransferSuggestions,
} from '../../src/services/transferReconciliationService.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockClient.query.mockReset();
  mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('unmarkTransfer — sticky per-pair dismissal (ADR-083, migration 0070)', () => {
  it('records the rejected PAIR and resets both legs to open (NULL)', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ transfer_peer_id: 20 }] })  // lock target 10 → peer 20
      .mockResolvedValueOnce({ rows: [{ transfer_peer_id: 10 }] }); // lock peer 20 → points back at 10
    await unmarkTransfer(10);

    const sqls = mockClient.query.mock.calls.map(([sql]) => sql);
    // Both the target and its peer are locked FOR UPDATE before any mutation
    // (mirrors markTransfer) so a concurrent re-pair can't strand a third row.
    const locks = sqls.filter((s) => s.includes('FOR UPDATE'));
    expect(locks).toHaveLength(2);
    // The pairing is persisted in transfer_dismissals (ordered, idempotent)…
    const dismissal = sqls.find((s) => s.includes('INSERT INTO transfer_dismissals'));
    expect(dismissal).toBeTruthy();
    expect(dismissal).toContain('LEAST');
    expect(dismissal).toContain('GREATEST');
    expect(dismissal).toContain('ON CONFLICT DO NOTHING');
    // …and the ROWS go back to open so each can still pair with OTHER candidates.
    const updates = sqls.filter((s) => s.includes('UPDATE transactions'));
    expect(updates).toHaveLength(2); // the row + its peer
    for (const sql of updates) {
      expect(sql).toContain('transfer_source = NULL');
      expect(sql).not.toContain('dismissed');
    }
  });

  it('does not reset a peer concurrently re-paired to a third row (reciprocity under lock)', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ transfer_peer_id: 20 }] })  // lock target 10 → peer 20
      .mockResolvedValueOnce({ rows: [{ transfer_peer_id: 99 }] }); // lock peer 20 → now points at 99, not 10
    await unmarkTransfer(10);

    const sqls = mockClient.query.mock.calls.map(([sql]) => sql);
    // Both rows were still locked FOR UPDATE.
    expect(sqls.filter((s) => s.includes('FOR UPDATE'))).toHaveLength(2);
    // The stale pair 10↔20 is no longer reciprocal → no dismissal recorded…
    expect(sqls.find((s) => s.includes('transfer_dismissals'))).toBeUndefined();
    // …and ONLY the target is reset; the re-paired peer (20→99) is left intact,
    // so row 99 is never stranded as a phantom one-way transfer.
    const updates = sqls.filter((s) => s.includes('UPDATE transactions'));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('WHERE id = $1');
  });

  it('a peerless (single-leg) row is just reset — no pair to dismiss', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ transfer_peer_id: null }] });
    await unmarkTransfer(10);
    const sqls = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(sqls.find((s) => s.includes('transfer_dismissals'))).toBeUndefined();
    const updates = sqls.filter((s) => s.includes('UPDATE transactions'));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('transfer_source = NULL');
  });
});

describe('candidate pool — dismissed pairs are excluded, rows stay matchable', () => {
  it('loadCandidatePairs excludes exactly the dismissed pair (LEAST/GREATEST anti-join)', async () => {
    await getTransferSuggestions();
    const candidateSql = query.mock.calls
      .map(([sql]) => sql)
      .find((s) => s.includes('AS "outId"'));
    expect(candidateSql).toBeTruthy();
    expect(candidateSql).toContain('NOT EXISTS');
    expect(candidateSql).toContain('transfer_dismissals');
    expect(candidateSql).toContain('LEAST(a.id, b.id)');
    expect(candidateSql).toContain('GREATEST(a.id, b.id)');
    // The per-row 'dismissed' state is gone — rows are only gated by open state.
    expect(candidateSql).not.toContain("'dismissed'");
  });
});

describe('markTransfer — releases a stranded prior peer', () => {
  it('releases any existing peer of A or B before pairing them', async () => {
    // SELECT ... FOR UPDATE returns both legs, opposite signs, different accounts.
    mockClient.query.mockResolvedValueOnce({
      rows: [
        { id: 10, amount: -100, account_id: 1, is_active: true },
        { id: 20, amount: 100, account_id: 2, is_active: true },
      ],
    });
    await markTransfer(10, 20);

    const sqls = mockClient.query.mock.calls.map(([sql]) => sql);
    // First mutation releases old peers pointing at 10 or 20 (but not 10/20).
    const release = sqls.find((s) => s.includes('transfer_peer_id = ANY($1) AND id <> ALL($1)'));
    expect(release).toBeTruthy();
    expect(release).toContain('transfer_source = NULL'); // back to open, not dismissed
    // Then both legs are marked 'manual'.
    const manual = sqls.filter((s) => s.includes("transfer_source = 'manual'"));
    expect(manual).toHaveLength(2);
  });
});

describe('releaseInvalidAutoPairs — reciprocity guard', () => {
  it('the release query requires the peer to point back (p.transfer_peer_id = t.id)', async () => {
    await reconcileTransfers();
    const releaseSql = query.mock.calls
      .map(([sql]) => sql)
      .find((s) => s.includes("t.transfer_source = 'auto'") && s.includes('NOT EXISTS'));
    expect(releaseSql).toBeTruthy();
    expect(releaseSql).toContain('p.transfer_peer_id = t.id');
  });
});
