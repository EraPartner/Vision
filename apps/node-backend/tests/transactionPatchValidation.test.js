import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from './helpers/mockLogger.js';

// PATCH /api/transactions/:id validation parity (TODO E8): the handler
// whitelist-filtered only — a cleared inline date ('') survived to Postgres
// as `SET "date" = ''` (22007 → 500), and non-numeric amount / non-integer
// FK ids surfaced as DB cast errors instead of 400s.

const routeHandlers = {};
const mockRouter = {
  get: vi.fn((path, ...args) => { routeHandlers[`get:${path}`] = args[args.length - 1]; }),
  post: vi.fn((path, ...args) => { routeHandlers[`post:${path}`] = args[args.length - 1]; }),
  put: vi.fn((path, ...args) => { routeHandlers[`put:${path}`] = args[args.length - 1]; }),
  patch: vi.fn((path, ...args) => { routeHandlers[`patch:${path}`] = args[args.length - 1]; }),
  delete: vi.fn((path, ...args) => { routeHandlers[`delete:${path}`] = args[args.length - 1]; }),
  use: vi.fn(),
};

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));
vi.mock('../src/database/connection.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  withTransaction: vi.fn(),
}));
vi.mock('../src/services/transactionService.js', () => ({
  default: {
    update: vi.fn().mockResolvedValue({ id: 1, amount: '10', date: '2026-07-01' }),
  },
}));
vi.mock('../src/services/deduplication.js', () => ({
  isManualDuplicate: vi.fn(),
  recordManualRawTransaction: vi.fn(),
}));
vi.mock('../src/services/currency/currencyConversionService.js', () => ({ convertRowsToEur: vi.fn() }));
vi.mock('../src/config/logger.js', () => ({
  logger: mockLogger(),
}));
vi.mock('../src/services/transferReconciliationService.js', () => ({
  scheduleReconcile: vi.fn(),
  getTransferSuggestions: vi.fn(),
  markTransfer: vi.fn(),
  unmarkTransfer: vi.fn(),
}));
vi.mock('../src/services/plannedMatchService.js', () => ({ autoLinkTransactions: vi.fn() }));
vi.mock('../src/services/transactionExport.js', () => ({
  EXPORT_MAX_LIST_SIZE: 1000,
  streamCsvExport: vi.fn(),
  streamNdjsonExport: vi.fn(),
  buildIdListWhere: vi.fn(),
}));
vi.mock('../src/services/bulkSelection.js', () => ({ resolveBulkSelection: vi.fn() }));

import transactionRepository from '../src/services/transactionService.js';
import { ValidationError } from '../src/middleware/errorHandler.js';
await import('../src/routes/transactions.js');

function mockRes() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  res.ok = (data) => res.json({ ok: true, data });
  return res;
}

const patchReq = (body) => ({ params: { id: '1' }, body });
const runPatch = (body) => routeHandlers['patch:/:id'](patchReq(body), mockRes());

beforeEach(() => {
  vi.clearAllMocks();
  transactionRepository.update.mockResolvedValue({ id: 1, amount: '10', date: '2026-07-01' });
});

describe('PATCH /api/transactions/:id validation', () => {
  it('rejects a cleared date instead of forwarding SET "date" = \'\'', async () => {
    await expect(runPatch({ date: '' })).rejects.toBeInstanceOf(ValidationError);
    await expect(runPatch({ transaction_date: null })).rejects.toBeInstanceOf(ValidationError);
    expect(transactionRepository.update).not.toHaveBeenCalled();
  });

  it('rejects a malformed date', async () => {
    await expect(runPatch({ date: 'banana' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('accepts a valid Y-M-D date and remaps it to transaction_date', async () => {
    await runPatch({ date: '2026-07-01' });
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ transaction_date: '2026-07-01' }),
    );
  });

  it('rejects non-numeric or cleared amounts', async () => {
    await expect(runPatch({ amount: 'abc' })).rejects.toBeInstanceOf(ValidationError);
    await expect(runPatch({ amount: null })).rejects.toBeInstanceOf(ValidationError);
    await expect(runPatch({ amount: '' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('coerces a numeric-string amount', async () => {
    await runPatch({ amount: '-12.5' });
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ amount: -12.5 }),
    );
  });

  it('rejects non-integer FK ids but lets null clear them', async () => {
    await expect(runPatch({ recipient_id: 'abc' })).rejects.toBeInstanceOf(ValidationError);
    await expect(runPatch({ category_id: 1.5 })).rejects.toBeInstanceOf(ValidationError);

    await runPatch({ recipient_id: null, category_id: null });
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ recipient_id: null, category_id: null }),
    );
  });
});
