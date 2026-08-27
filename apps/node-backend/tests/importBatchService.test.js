import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/repositories/importBatchRepository.js', () => ({
  listBatches: vi.fn(),
  getBatch: vi.fn(),
  rollbackBatch: vi.fn(),
  getPreviewRows: vi.fn(),
  overrideRecipient: vi.fn(),
  overrideCategory: vi.fn(),
  categoryExists: vi.fn(),
}));

import { getPreviewRows } from '../src/repositories/importBatchRepository.js';
import { getImportBatchPreview } from '../src/services/importBatchService.js';

describe('getImportBatchPreview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preserves recipient grouping, category precedence, projected rows, and totals', async () => {
    getPreviewRows.mockResolvedValue([
      {
        id: 1,
        row_index: 0,
        effective_recipient_id: 7,
        recipient_name: 'Shop',
        recipient_raw: 'SHOP ONE',
        recipient_default_category_id: 11,
        recipient_default_category_general: 'Living',
        recipient_default_category_detail: 'Food',
        override_category_id: 22,
        override_category_general: 'Home',
        override_category_detail: 'Tools',
        matched_pattern_id: 5,
        matched_pattern_text: 'SHOP*',
        matched_pattern_kind: 'glob',
        amount: '-12.50',
        currency: 'EUR',
        tx_date: '2026-08-01',
        memo: 'one',
        bank_account: 'Main',
        match_source: 'exact',
        match_similarity: '1.0',
        user_override_recipient_id: null,
      },
      {
        id: 2,
        row_index: 1,
        effective_recipient_id: 7,
        recipient_name: 'Shop',
        recipient_raw: 'SHOP TWO',
        amount: '-3.25',
        currency: 'EUR',
        tx_date: '2026-08-02',
        memo: 'two',
        bank_account: null,
        match_source: 'fuzzy',
        match_similarity: '0.9',
        matched_pattern_id: null,
        user_override_recipient_id: 7,
        override_category_id: null,
      },
      {
        id: 3,
        row_index: 2,
        effective_recipient_id: null,
        recipient_name: null,
        recipient_raw: 'UNKNOWN A',
        amount: '-1.00',
        currency: 'EUR',
        tx_date: '2026-08-03',
        memo: '',
        match_source: null,
      },
      {
        id: 4,
        row_index: 3,
        effective_recipient_id: null,
        recipient_name: null,
        recipient_raw: 'UNKNOWN B',
        amount: '-2.00',
        currency: 'EUR',
        tx_date: '2026-08-04',
        memo: '',
        match_source: 'new',
      },
    ]);

    const result = await getImportBatchPreview(9);

    expect(getPreviewRows).toHaveBeenCalledWith(9);
    expect(result.totals).toEqual({ exact: 1, fuzzy: 1, pattern: 0, new: 1, unresolved: 1 });
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]).toEqual(expect.objectContaining({
      recipient_id: 7,
      row_count: 2,
      recipient_default_category_label: 'Living: Food',
      current_category_id: 22,
      current_category_label: 'Home: Tools',
    }));
    expect(result.groups[0].rows[0]).toEqual(expect.objectContaining({
      id: 1,
      amount: '-12.50',
      bank_account: 'Main',
      match_similarity: '1.0',
      override_category_id: 22,
    }));
    expect(result.groups[0].rows[1].bank_account).toBeNull();
    expect(result.groups[1]).toEqual(expect.objectContaining({
      recipient_id: null,
      row_count: 2,
    }));
    expect(result.groups[1].rows.map((row) => row.id)).toEqual([3, 4]);
  });

  it('returns the complete zeroed totals shape for an empty preview', async () => {
    getPreviewRows.mockResolvedValue([]);
    await expect(getImportBatchPreview(1)).resolves.toEqual({
      groups: [],
      totals: { exact: 0, fuzzy: 0, pattern: 0, new: 0, unresolved: 0 },
    });
  });
});
