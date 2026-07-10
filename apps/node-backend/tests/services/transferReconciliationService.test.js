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
} from '../../src/services/transferReconciliationService.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockClient.query.mockReset();
  mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('unmarkTransfer — sticky dismissal (ADR-083)', () => {
  it("stamps both legs transfer_source='dismissed' so they can't auto re-pair", async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ transfer_peer_id: 20 }] }); // SELECT peer
    await unmarkTransfer(10);

    const updates = mockClient.query.mock.calls
      .map(([sql]) => sql)
      .filter((s) => s.includes('UPDATE transactions'));
    expect(updates).toHaveLength(2); // the row + its peer
    for (const sql of updates) {
      expect(sql).toContain("transfer_source = 'dismissed'");
      expect(sql).not.toContain('transfer_source = NULL');
    }
  });

  it('dismisses even a peerless (single-leg) row', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ transfer_peer_id: null }] });
    await unmarkTransfer(10);
    const updates = mockClient.query.mock.calls
      .map(([sql]) => sql)
      .filter((s) => s.includes('UPDATE transactions'));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("transfer_source = 'dismissed'");
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
