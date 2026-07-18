/**
 * Shared `vi.mock` factories for the transactions route-test family
 * (`routes/transactions*.test.js`, `transactionPatchValidation.test.js`),
 * which all mock the same module set around `src/routes/transactions.js`.
 *
 * Function names are prefixed with `mock` so they may be referenced inside
 * hoisted `vi.mock` factories (same convention as `mockLogger`).
 *
 * Usage:
 *   import { mockTransactionRepository } from '../helpers/transactionsRouteMocks.js';
 *   vi.mock('../../src/repositories/transactionRepository.js', () => mockTransactionRepository());
 */
import { vi } from 'vitest';

/** Default-export repository stub covering every method the routes touch. */
export function mockTransactionRepository() {
  return {
    default: {
      getAll: vi.fn(),
      getAllWithCount: vi.fn(),
      getUncategorised: vi.fn(),
      getUncategorisedWithCount: vi.fn(),
      getCount: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      hardDelete: vi.fn(),
    },
  };
}

/** `services/deduplication.js`: nothing is ever a duplicate. */
export function mockDeduplication() {
  return {
    isManualDuplicate: vi.fn(async () => ({ isDuplicate: false })),
    recordManualRawTransaction: vi.fn(async () => undefined),
  };
}

/** `services/transferReconciliationService.js`: all spies. */
export function mockTransferReconciliation() {
  return {
    scheduleReconcile: vi.fn(),
    getTransferSuggestions: vi.fn(),
    markTransfer: vi.fn(),
    unmarkTransfer: vi.fn(),
  };
}

/** `services/materializedViewService.js`: refresh scheduling is a spy. */
export function mockMaterializedViews() {
  return { scheduleRefresh: vi.fn() };
}

/** `services/currency/currencyConversionService.js`: EUR conversion is a passthrough. */
export function mockCurrencyConversion() {
  return { convertRowsToEur: vi.fn(async (rows) => rows) };
}

/** `services/attachmentRecordService.js`: no attachments on any transaction. */
export function mockAttachmentRecordService() {
  return {
    attachmentRepository: {
      listPathsByTransactionIds: vi.fn(async () => []),
    },
  };
}

/** `services/attachmentService.js`: file removal is a resolved spy. */
export function mockAttachmentService() {
  return { removeAttachmentFile: vi.fn(async () => undefined) };
}
