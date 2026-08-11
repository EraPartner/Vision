/**
 * Validation-behavior pins for the transactions route bodies (ZOD-06).
 *
 * These tests pin the exact accept/reject/coercion behavior of the body
 * validation in POST /, PATCH /:id, POST /bulk-tag, and POST /bulk-update, so
 * the wire contract cannot silently change: rejected inputs stay
 * 400/VALIDATION_ERROR, accepted inputs reach the repository byte-identically
 * (raw vs coerced), and clear-vs-absent semantics survive.
 *
 * Driven over HTTP against the real router (tests/helpers/routeApp.js), so the
 * status/envelope assertions are the ones the error handler actually emits
 * rather than a hand-replayed approximation.
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

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

vi.mock('../../src/services/transferReconciliationService.js', () => mockTransferReconciliation());

vi.mock('../../src/services/currency/currencyConversionService.js', () => mockCurrencyConversion());

vi.mock('../../src/database/connection.js', () => mockPooledTxConnection());

vi.mock('../../src/services/plannedMatchService.js', () => ({
  autoLinkTransactions: vi.fn(async () => ({ autoLinkedCount: 0, links: [] })),
}));

import transactionRepository from '../../src/repositories/transactionRepository.js';
import { recordManualRawTransaction, isManualDuplicate } from '../../src/services/deduplication.js';

const { default: transactionsRouter } = await import('../../src/routes/transactions.js');

const api = routeAgent(transactionsRouter, { mountPath: '/api/transactions' });

const validPostBody = () => ({
  transaction_date: '2026-01-15',
  bank_account: 'Chase',
  recipient_id: 1,
  amount: -50,
});

const post = (body) => api.post('/api/transactions/').send(body);
const patch = (body) => api.patch('/api/transactions/1').send(body);
const bulkTag = (body) => api.post('/api/transactions/bulk-tag').send(body);
const bulkUpdate = (body) => api.post('/api/transactions/bulk-update').send(body);

/** Assert a 400 VALIDATION_ERROR envelope and return the response. */
async function expectValidationError(pending) {
  const res = await pending;
  expect(res.status).toBe(400);
  expect(res.body.ok).toBe(false);
  expect(res.body.error.code).toBe('VALIDATION_ERROR');
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  isManualDuplicate.mockResolvedValue({ isDuplicate: false });
  transactionRepository.create.mockResolvedValue({ id: 1, amount: '-50', date: '2026-01-15' });
  transactionRepository.update.mockResolvedValue({ id: 1, amount: '10', date: '2026-07-01' });
});

describe('POST / — validation pins', () => {
  it('emits the 400 VALIDATION_ERROR envelope for a missing-fields body', async () => {
    const res = await expectValidationError(post({}));
    expect(res.body.error.message).toContain('Missing required fields');
    // The failure envelope carries the request id injected by requestId middleware.
    expect(res.body.meta.requestId).toEqual(expect.any(String));
    expect(res.headers['x-request-id']).toBe(res.body.meta.requestId);
  });

  it('rejects when any required field is absent', async () => {
    for (const missing of ['transaction_date', 'bank_account', 'recipient_id', 'amount']) {
      const body = validPostBody();
      delete body[missing];
      await expectValidationError(post(body));
    }
    expect(transactionRepository.create).not.toHaveBeenCalled();
  });

  it('falls back from transaction_date to date', async () => {
    const body = validPostBody();
    delete body.transaction_date;
    await post({ ...body, date: '2026-02-03' }).expect(201);
    expect(transactionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ transaction_date: '2026-02-03' }),
    );
  });

  it('rejects zero, non-numeric, and out-of-range amounts', async () => {
    // Infinity/-Infinity are not representable in JSON, so they arrive as the
    // string forms a client would actually send.
    for (const amount of [0, '0', 'abc', 'Infinity', '-Infinity', 1e12 + 1, -1e13]) {
      await expectValidationError(post({ ...validPostBody(), amount }));
    }
    expect(transactionRepository.create).not.toHaveBeenCalled();
  });

  it('passes an accepted numeric-string amount through RAW (no coercion)', async () => {
    await post({ ...validPostBody(), amount: '-12.5' }).expect(201);
    expect(transactionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '-12.5' }),
    );
  });

  // The reject list used to stop at the values a `Number()` coercion fails on.
  // The ones it silently *accepts* are the harmful half: '1e3' booked the
  // transaction against recipient 1000, '0x10' against 16, `true` against 1 and
  // `[7]` against 7 — a ledger row attributed to someone the caller never named,
  // 201 and all. The intent of this pin was always "a positive integer".
  it('rejects non-positive-integer recipient ids, including the retargeting forms', async () => {
    for (const recipient_id of [
      1.5, 'abc', -1, '2.5', 0, '12abc',
      '1e3', '0x10', '0o17', '0b11', true, [7], '+7', ' 7 ', '7.0',
    ]) {
      await expectValidationError(post({ ...validPostBody(), recipient_id }));
    }
    expect(transactionRepository.create).not.toHaveBeenCalled();
  });

  it('passes an accepted numeric-string recipient_id through RAW', async () => {
    await post({ ...validPostBody(), recipient_id: '5' }).expect(201);
    expect(transactionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_id: '5' }),
    );
  });

  it('rejects non-array tags, defaults absent tags to null, passes arrays through', async () => {
    await expectValidationError(post({ ...validPostBody(), tags: 'x' }));
    await expectValidationError(post({ ...validPostBody(), tags: null }));

    await post(validPostBody()).expect(201);
    expect(transactionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ tags: null }),
    );

    await post({ ...validPostBody(), tags: ['a', 'b'] }).expect(201);
    expect(transactionRepository.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ tags: ['a', 'b'] }),
    );
  });

  it('normalises currency to uppercase ISO and rejects free text', async () => {
    await expectValidationError(post({ ...validPostBody(), currency: 'euro' }));

    await post({ ...validPostBody(), currency: 'usd' }).expect(201);
    expect(transactionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'USD' }),
    );

    await post(validPostBody()).expect(201);
    expect(transactionRepository.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ currency: undefined }),
    );
  });

  it('rejects a bank_account longer than 100 characters', async () => {
    const res = await expectValidationError(post({ ...validPostBody(), bank_account: 'a'.repeat(101) }));
    expect(res.body.error.message).toMatch(/bank_account/);
  });

  it('still records the raw-transaction mirror with the accepted values', async () => {
    await post({ ...validPostBody(), memo: 'm', category_id: 4 }).expect(201);
    expect(recordManualRawTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-01-15', recipientId: 1, categoryId: 4, memo: 'm' }),
    );
  });
});

describe('PATCH /:id — validation pins', () => {
  it('rejects a cleared or free-text currency but uppercases a valid one', async () => {
    await expectValidationError(patch({ currency: '' }));
    await expectValidationError(patch({ currency: null }));
    await expectValidationError(patch({ currency: 'euro' }));

    await patch({ currency: 'usd' }).expect(200);
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ currency: 'USD' }),
    );
  });

  it('allows a zero amount on PATCH (unlike POST) and coerces it to a number', async () => {
    await patch({ amount: '0' }).expect(200);
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ amount: 0 }),
    );
  });

  it('rejects an out-of-range amount', async () => {
    await expectValidationError(patch({ amount: 1e13 }));
    await expectValidationError(patch({ amount: 'Infinity' }));
  });

  it('caps bank_account at 100 chars but lets null through untouched', async () => {
    await expectValidationError(patch({ bank_account: 'a'.repeat(101) }));

    await patch({ bank_account: null }).expect(200);
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ bank_account: null }),
    );
  });

  it('rejects non-array tags and passes arrays through', async () => {
    await expectValidationError(patch({ tags: 'x' }));

    await patch({ tags: ['a'] }).expect(200);
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ tags: ['a'] }),
    );
  });

  it('keeps the boundary loose: unvalidated fields pass through untouched', async () => {
    await patch({ memo: 'hi', is_active: 'yes', comment: 7 }).expect(200);
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ memo: 'hi', is_active: 'yes', comment: 7 }),
    );
  });

  it('absent fields stay absent in the patch handed to the repository', async () => {
    await patch({ memo: 'only-this' }).expect(200);
    const patchArg = transactionRepository.update.mock.calls[0][1];
    expect('amount' in patchArg).toBe(false);
    expect('transaction_date' in patchArg).toBe(false);
    expect('currency' in patchArg).toBe(false);
    expect('recipient_id' in patchArg).toBe(false);
    expect('category_id' in patchArg).toBe(false);
  });

  it('coerces numeric-string FK ids to numbers', async () => {
    await patch({ recipient_id: '7', category_id: '3' }).expect(200);
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ recipient_id: 7, category_id: 3 }),
    );
  });

  // The retargeting half of this contract ('1e3' → recipient 1000) lives in
  // tests/routes/transactionsFkIdValidation.test.js: it needs more PATCHes than
  // this file has left under the route's own 30/min rate limiter.

  it('strips read-only keys (id, created_at, links) before the repository', async () => {
    await patch({ id: 99, created_at: 'x', links: ['a'], memo: 'ok' }).expect(200);
    const patchArg = transactionRepository.update.mock.calls[0][1];
    expect('id' in patchArg).toBe(false);
    expect('created_at' in patchArg).toBe(false);
    expect('links' in patchArg).toBe(false);
    expect(patchArg.memo).toBe('ok');
  });
});

describe('POST /bulk-tag — validation pins', () => {
  it('rejects a non-array add_slugs / remove_slugs', async () => {
    for (const body of [
      { transaction_ids: [1], add_slugs: 'x' },
      { transaction_ids: [1], remove_slugs: { a: 1 } },
      { transaction_ids: [1], add_slugs: null },
    ]) {
      await expectValidationError(bulkTag(body));
    }
  });

  it('rejects remove_slugs above 50 entries', async () => {
    await expectValidationError(bulkTag({
      transaction_ids: [1],
      remove_slugs: Array.from({ length: 51 }, (_, i) => `t-${i}`),
    }));
  });

  it('checks the both-empty rule before filtering invalid ids', async () => {
    const res = await expectValidationError(bulkTag({
      transaction_ids: ['abc'], add_slugs: [], remove_slugs: [],
    }));
    expect(res.body.error.message).toMatch(/at least one/i);
  });

  // Was: expected the generic 'no valid IDs' this route reached only after
  // every element had been silently discarded. Each element is now validated as
  // sent, so the first bad one is named and echoed back.
  it('rejects when transaction_ids contains a non-int4 id', async () => {
    const res = await expectValidationError(bulkTag({
      transaction_ids: ['abc', 0, -2, 2 ** 31], add_slugs: ['x'],
    }));
    expect(res.body.error.message).toBe('transaction_ids contains invalid value: abc');
  });

  // A partly-valid list is rejected too — it used to be silently truncated to
  // its valid members, tagging fewer transactions than the caller asked for
  // with a 200 and a count that looked plausible.
  it('rejects a partly-valid transaction_ids list rather than tagging a subset', async () => {
    const res = await expectValidationError(bulkTag({
      transaction_ids: [1, 2.5, 3], add_slugs: ['x'],
    }));
    expect(res.body.error.message).toBe('transaction_ids contains invalid value: 2.5');
  });

  // The retarget: '1e3' used to reach Number() and tag transaction 1000.
  it('never coerces a transaction id into a different record id', async () => {
    for (const bad of ['1e3', '0x10', true, [7]]) {
      await expectValidationError(bulkTag({ transaction_ids: [bad], add_slugs: ['x'] }));
    }
  });
});

describe('POST /bulk-update — validation pins', () => {
  it('rejects an array fields value', async () => {
    await expectValidationError(bulkUpdate({ ids: [1], fields: [] }));
  });

  it('keeps FK ids strict: numeric strings and floats are rejected', async () => {
    for (const fields of [
      { category_id: '5' },
      { category_id: 3.5 },
      { recipient_id: '5' },
      { recipient_id: 0 },
      { recipient_id: true },
    ]) {
      await expectValidationError(bulkUpdate({ ids: [1], fields }));
    }
  });
});
