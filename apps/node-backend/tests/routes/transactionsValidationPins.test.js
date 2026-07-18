/**
 * Validation-behavior pins for the transactions route bodies (ZOD-06).
 *
 * These tests pin the exact accept/reject/coercion behavior of the hand-rolled
 * validation in POST /, PATCH /:id, POST /bulk-tag, and POST /bulk-update
 * BEFORE the zod migration, so the swap cannot silently change the wire
 * contract: rejected inputs stay 400/VALIDATION_ERROR, accepted inputs reach
 * the repository byte-identically (raw vs coerced), and clear-vs-absent
 * semantics survive.
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
import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';

const { router: mockRouter, handlers: routeHandlers } = createMockRouter();

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

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
import { recordManualRawTransaction } from '../../src/services/deduplication.js';
import { ValidationError } from '../../src/middleware/errorHandler.js';
await import('../../src/routes/transactions.js');

function mockResponse() {
  return createMockResponse({ headersSent: false });
}

// Runs a handler through the same status/envelope shaping as errorHandler.js
// so pins can assert the wire format (400 + VALIDATION_ERROR).
async function callHandler(handler, req, res) {
  try {
    await handler(req, res);
  } catch (err) {
    const status = err.status ?? 500;
    const code = err.code ?? 'INTERNAL_SERVER_ERROR';
    res.status(status).json({ ok: false, error: { code, message: err.message } });
  }
}

const validPostBody = () => ({
  transaction_date: '2026-01-15',
  bank_account: 'Chase',
  recipient_id: 1,
  amount: -50,
});

const runPost = (body) => routeHandlers['post:/'](
  { body },
  createMockResponse({ headersSent: false }),
);

const runPatch = (body) => routeHandlers['patch:/:id'](
  { params: { id: '1' }, body },
  createMockResponse({ headersSent: false }),
);

beforeEach(() => {
  vi.clearAllMocks();
  transactionRepository.create.mockResolvedValue({ id: 1, amount: '-50', date: '2026-01-15' });
  transactionRepository.update.mockResolvedValue({ id: 1, amount: '10', date: '2026-07-01' });
});

describe('POST / — validation pins', () => {
  it('emits the 400 VALIDATION_ERROR envelope for a missing-fields body', async () => {
    const res = mockResponse();
    await callHandler(routeHandlers['post:/'], { body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('Missing required fields');
  });

  it('rejects when any required field is absent', async () => {
    for (const missing of ['transaction_date', 'bank_account', 'recipient_id', 'amount']) {
      const body = validPostBody();
      delete body[missing];
      await expect(runPost(body)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(transactionRepository.create).not.toHaveBeenCalled();
  });

  it('falls back from transaction_date to date', async () => {
    await runPost({ ...validPostBody(), transaction_date: undefined, date: '2026-02-03' });
    expect(transactionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ transaction_date: '2026-02-03' }),
    );
  });

  it('rejects zero, non-numeric, and out-of-range amounts', async () => {
    for (const amount of [0, '0', 'abc', Infinity, -Infinity, 1e12 + 1, -1e13]) {
      await expect(runPost({ ...validPostBody(), amount })).rejects.toBeInstanceOf(ValidationError);
    }
    expect(transactionRepository.create).not.toHaveBeenCalled();
  });

  it('passes an accepted numeric-string amount through RAW (no coercion)', async () => {
    await runPost({ ...validPostBody(), amount: '-12.5' });
    expect(transactionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '-12.5' }),
    );
  });

  it('rejects non-positive-integer recipient ids', async () => {
    for (const recipient_id of [1.5, 'abc', -1, '2.5']) {
      await expect(runPost({ ...validPostBody(), recipient_id })).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('passes an accepted numeric-string recipient_id through RAW', async () => {
    await runPost({ ...validPostBody(), recipient_id: '5' });
    expect(transactionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_id: '5' }),
    );
  });

  it('rejects non-array tags, defaults absent tags to null, passes arrays through', async () => {
    await expect(runPost({ ...validPostBody(), tags: 'x' })).rejects.toBeInstanceOf(ValidationError);
    await expect(runPost({ ...validPostBody(), tags: null })).rejects.toBeInstanceOf(ValidationError);

    await runPost(validPostBody());
    expect(transactionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ tags: null }),
    );

    await runPost({ ...validPostBody(), tags: ['a', 'b'] });
    expect(transactionRepository.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ tags: ['a', 'b'] }),
    );
  });

  it('normalises currency to uppercase ISO and rejects free text', async () => {
    await expect(runPost({ ...validPostBody(), currency: 'euro' })).rejects.toBeInstanceOf(ValidationError);

    await runPost({ ...validPostBody(), currency: 'usd' });
    expect(transactionRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'USD' }),
    );

    await runPost(validPostBody());
    expect(transactionRepository.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ currency: undefined }),
    );
  });

  it('rejects a bank_account longer than 100 characters', async () => {
    await expect(runPost({ ...validPostBody(), bank_account: 'a'.repeat(101) }))
      .rejects.toThrow(/bank_account/);
  });

  it('still records the raw-transaction mirror with the accepted values', async () => {
    await runPost({ ...validPostBody(), memo: 'm', category_id: 4 });
    expect(recordManualRawTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-01-15', recipientId: 1, categoryId: 4, memo: 'm' }),
    );
  });
});

describe('PATCH /:id — validation pins', () => {
  it('rejects a cleared or free-text currency but uppercases a valid one', async () => {
    await expect(runPatch({ currency: '' })).rejects.toBeInstanceOf(ValidationError);
    await expect(runPatch({ currency: null })).rejects.toBeInstanceOf(ValidationError);
    await expect(runPatch({ currency: 'euro' })).rejects.toBeInstanceOf(ValidationError);

    await runPatch({ currency: 'usd' });
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ currency: 'USD' }),
    );
  });

  it('allows a zero amount on PATCH (unlike POST) and coerces it to a number', async () => {
    await runPatch({ amount: '0' });
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ amount: 0 }),
    );
  });

  it('rejects an out-of-range amount', async () => {
    await expect(runPatch({ amount: 1e13 })).rejects.toBeInstanceOf(ValidationError);
    await expect(runPatch({ amount: Infinity })).rejects.toBeInstanceOf(ValidationError);
  });

  it('caps bank_account at 100 chars but lets null through untouched', async () => {
    await expect(runPatch({ bank_account: 'a'.repeat(101) })).rejects.toBeInstanceOf(ValidationError);

    await runPatch({ bank_account: null });
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ bank_account: null }),
    );
  });

  it('rejects non-array tags and passes arrays through', async () => {
    await expect(runPatch({ tags: 'x' })).rejects.toBeInstanceOf(ValidationError);

    await runPatch({ tags: ['a'] });
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ tags: ['a'] }),
    );
  });

  it('keeps the boundary loose: unvalidated fields pass through untouched', async () => {
    await runPatch({ memo: 'hi', is_active: 'yes', comment: 7 });
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ memo: 'hi', is_active: 'yes', comment: 7 }),
    );
  });

  it('absent fields stay absent in the patch handed to the repository', async () => {
    await runPatch({ memo: 'only-this' });
    const patchArg = transactionRepository.update.mock.calls[0][1];
    expect('amount' in patchArg).toBe(false);
    expect('transaction_date' in patchArg).toBe(false);
    expect('currency' in patchArg).toBe(false);
    expect('recipient_id' in patchArg).toBe(false);
    expect('category_id' in patchArg).toBe(false);
  });

  it('coerces numeric-string FK ids to numbers', async () => {
    await runPatch({ recipient_id: '7', category_id: '3' });
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ recipient_id: 7, category_id: 3 }),
    );
  });

  it('strips read-only keys (id, created_at, links) before the repository', async () => {
    await runPatch({ id: 99, created_at: 'x', links: ['a'], memo: 'ok' });
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
      const res = mockResponse();
      await callHandler(routeHandlers['post:/bulk-tag'], { body }, res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });

  it('rejects remove_slugs above 50 entries', async () => {
    const res = mockResponse();
    const body = { transaction_ids: [1], remove_slugs: Array.from({ length: 51 }, (_, i) => `t-${i}`) };
    await callHandler(routeHandlers['post:/bulk-tag'], { body }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('checks the both-empty rule before filtering invalid ids', async () => {
    const res = mockResponse();
    const body = { transaction_ids: ['abc'], add_slugs: [], remove_slugs: [] };
    await callHandler(routeHandlers['post:/bulk-tag'], { body }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.message).toMatch(/at least one/i);
  });

  it('rejects when transaction_ids contains no int4-valid ids', async () => {
    const res = mockResponse();
    const body = { transaction_ids: ['abc', 0, -2, 2 ** 31], add_slugs: ['x'] };
    await callHandler(routeHandlers['post:/bulk-tag'], { body }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.message).toContain('no valid IDs');
  });
});

describe('POST /bulk-update — validation pins', () => {
  it('rejects an array fields value', async () => {
    const res = mockResponse();
    await callHandler(routeHandlers['post:/bulk-update'], { body: { ids: [1], fields: [] } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('keeps FK ids strict: numeric strings and floats are rejected', async () => {
    for (const fields of [
      { category_id: '5' },
      { category_id: 3.5 },
      { recipient_id: '5' },
      { recipient_id: 0 },
      { recipient_id: true },
    ]) {
      const res = mockResponse();
      await callHandler(routeHandlers['post:/bulk-update'], { body: { ids: [1], fields } }, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].error.code).toBe('VALIDATION_ERROR');
    }
  });
});
