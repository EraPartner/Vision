/**
 * FK-id shape on the transaction write bodies (`recipient_id`, `category_id`).
 *
 * These two fields were validated with `Number.isInteger(Number(value))`, the
 * same sub-shape as the import-override guards. It rejects '12abc', which is
 * why it read as sound, but it *accepts* '1e3' as 1000, '0x10' as 16, '0o17' as
 * 15, `true` as 1 and `[7]` as 7 — so a malformed id was not rejected, it named
 * a different row. On POST that files a new ledger entry against a recipient
 * the caller never named; on PATCH it re-attributes an existing one. Both
 * persist, and both answered 2xx.
 *
 * Absent and null are deliberately untouched: `recipient_id` is required on
 * POST but nullable on PATCH, `category_id` is nullable on both, and null there
 * means "clear the FK" / "uncategorized" — the inline row editor's clear
 * action. Pinned here so a later tightening cannot take that away by accident.
 *
 * Lives in its own file rather than in transactionsValidationPins.test.js
 * because the reject matrix needs ~30 PATCHes and the route carries its own
 * 30-requests-per-minute limiter (routes/transactions.js), which a fresh module
 * registry resets.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockPooledTxConnection } from '../helpers/repoMocks.js';
import {
  mockTransactionRepository,
  mockDeduplication,
  mockTransferReconciliation,
  mockCurrencyConversion,
} from '../helpers/transactionsRouteMocks.js';
import { mockLogger } from '../helpers/mockLogger.js';
import { routeAgent } from '../helpers/routeApp.js';

vi.mock('../../src/repositories/transactionRepository.js', () => mockTransactionRepository());
vi.mock('../../src/services/deduplication.js', () => mockDeduplication());
vi.mock('../../src/config/logger.js', () => ({ logger: mockLogger() }));
vi.mock('../../src/services/transferReconciliationService.js', () => mockTransferReconciliation());
vi.mock('../../src/services/currency/currencyConversionService.js', () => mockCurrencyConversion());
vi.mock('../../src/database/connection.js', () => mockPooledTxConnection());
vi.mock('../../src/services/plannedMatchService.js', () => ({
  autoLinkTransactions: vi.fn(async () => ({ autoLinkedCount: 0, links: [] })),
}));

import transactionRepository from '../../src/repositories/transactionRepository.js';
import { isManualDuplicate } from '../../src/services/deduplication.js';

const { default: transactionsRouter } = await import('../../src/routes/transactions.js');

const api = routeAgent(transactionsRouter, { mountPath: '/api/transactions' });

const patch = (body) => api.patch('/api/transactions/1').send(body);
const post = (body) => api.post('/api/transactions/').send({
  transaction_date: '2026-01-15',
  bank_account: 'Chase',
  recipient_id: 1,
  amount: -50,
  ...body,
});

// Values a `Number()` coercion resolves to a DIFFERENT, perfectly valid id.
const RETARGETING = ['1e3', '0x10', '0o17', '0b11', true, [7], '+7', ' 7 ', '7.0'];

beforeEach(() => {
  vi.clearAllMocks();
  isManualDuplicate.mockResolvedValue({ isDuplicate: false });
  transactionRepository.create.mockResolvedValue({ id: 1, amount: '-50', date: '2026-01-15' });
  transactionRepository.update.mockResolvedValue({ id: 1, amount: '10', date: '2026-07-01' });
});

describe('PATCH /:id — FK ids reject instead of retargeting', () => {
  it('rejects every recipient_id that used to resolve to a different recipient', async () => {
    for (const recipient_id of RETARGETING) {
      const res = await patch({ recipient_id });
      expect(res.status, `expected ${JSON.stringify(recipient_id)} to be rejected`).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(transactionRepository.update).not.toHaveBeenCalled();
  });

  it('rejects every category_id that used to resolve to a different category', async () => {
    for (const category_id of RETARGETING) {
      const res = await patch({ category_id });
      expect(res.status, `expected ${JSON.stringify(category_id)} to be rejected`).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(transactionRepository.update).not.toHaveBeenCalled();
  });

  it('keeps null clearing the FK and an absent field absent', async () => {
    await patch({ recipient_id: null, category_id: null }).expect(200);
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ recipient_id: null, category_id: null }),
    );

    transactionRepository.update.mockClear();
    await patch({ memo: 'only-this' }).expect(200);
    const patchArg = transactionRepository.update.mock.calls[0][1];
    expect('recipient_id' in patchArg).toBe(false);
    expect('category_id' in patchArg).toBe(false);
  });

  it('still accepts a digit string or an integer, coerced', async () => {
    await patch({ recipient_id: '007', category_id: 3 }).expect(200);
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ recipient_id: 7, category_id: 3 }),
    );
  });
});

describe('POST / — FK ids reject instead of retargeting', () => {
  // recipient_id's reject matrix lives with the other POST body pins in
  // transactionsValidationPins.test.js.
  //
  // category_id used to be excluded here on purpose, because POST validated
  // recipient_id and amount and forwarded every other field raw — a *missing*
  // guard rather than this file's loose one, so a malformed value reached
  // Postgres and 500'd on the cast. That gap is now closed with the same
  // nullableFkField the PATCH body uses, and the matrix below is the same one.
  it('rejects every category_id that used to reach Postgres unvalidated', async () => {
    for (const category_id of [...RETARGETING, '12abc', 0, -5, '']) {
      const res = await post({ category_id });
      expect(res.status, `expected ${JSON.stringify(category_id)} to be rejected`).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(transactionRepository.create).not.toHaveBeenCalled();
  });

  // Absent and null both mean "uncategorized" on create and always have — the
  // column is nullable and the POST handler never defaulted it. Pinned so the
  // new guard cannot turn either into a 400.
  it('still creates with an absent category_id, a null one, and a digit-string one', async () => {
    await post({}).expect(201);
    await post({ category_id: null }).expect(201);
    await post({ category_id: '4' }).expect(201);
    expect(transactionRepository.create).toHaveBeenCalledTimes(3);
    // The service always names category_id in the row it builds, so "absent"
    // reaches the repository as undefined, not as a missing key.
    expect(transactionRepository.create.mock.calls[0][0].category_id).toBeUndefined();
    expect(transactionRepository.create.mock.calls[1][0].category_id).toBeNull();
    expect(transactionRepository.create.mock.calls[2][0].category_id).toBe(4);
  });
});
