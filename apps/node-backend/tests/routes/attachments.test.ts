/**
 * Attachment route tests — upload cleanup on failed DB insert.
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.ts) — validateIdParam is no longer stubbed. The
 * multer upload middleware (`attachmentUpload.single`) stays mocked because
 * the route test does not need to parse multipart bodies; the mock drives `req.file` /
 * upload errors through the real middleware chain instead of the test
 * hand-building a `req.file`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.ts';
import { routeAgent, okEnvelope, errEnvelope } from '../helpers/routeApp.ts';

const uploadState = vi.hoisted(() => ({
  file: null as { originalname: string; size: number } | null | undefined,
  error: null as Error | null,
}));

vi.mock('../../src/services/attachmentRecordService.ts', () => ({
  attachmentRepository: {
    transactionExists: vi.fn(),
    create: vi.fn(),
    findById: vi.fn(),
    listByTransaction: vi.fn(),
    countByTransaction: vi.fn(),
    deleteById: vi.fn(),
  },
}));

vi.mock('../../src/middleware/attachmentUpload.ts', () => ({
  attachmentUpload: {
    single: () => (req: { file?: unknown }, _res: unknown, cb: (err?: Error) => void) => {
      if (uploadState.error) return cb(uploadState.error);
      req.file = uploadState.file;
      cb();
    },
  },
}));

vi.mock('../../src/services/attachmentService.ts', () => ({
  storeAttachment: vi.fn(),
  resolveAbsolutePath: vi.fn(),
  removeAttachmentFile: vi.fn(),
  verifyAttachmentContent: vi.fn(),
}));

vi.mock('../../src/config/logger.ts', () => ({
  logger: mockLogger(),
}));

import { attachmentRepository as rawAttachmentRepository } from '../../src/services/attachmentRecordService.ts';
import {
  storeAttachment as rawStoreAttachment,
  removeAttachmentFile as rawRemoveAttachmentFile,
  verifyAttachmentContent as rawVerifyAttachmentContent,
} from '../../src/services/attachmentService.ts';
import type { FormattedAttachment } from '../../src/repositories/attachmentRepository.ts';
import { logger } from '../../src/config/logger.ts';

const attachmentRepository = vi.mocked(rawAttachmentRepository);
const storeAttachment = vi.mocked(rawStoreAttachment);
const removeAttachmentFile = vi.mocked(rawRemoveAttachmentFile);
const verifyAttachmentContent = vi.mocked(rawVerifyAttachmentContent);

/**
 * Stand-in for a full attachment row: the route reads only the fields given,
 * and forwards the numeric ids these fixtures use unchanged.
 */
const attachment = (row: Record<string, unknown>) =>
  row as unknown as FormattedAttachment;

const { default: attachmentsRouter } = await import('../../src/routes/attachments.ts');

const api = routeAgent(attachmentsRouter, { mountPath: '/api/attachments' });
const BASE = '/api/attachments';

describe('Attachment routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadState.file = { originalname: 'receipt.png', size: 1234 };
    uploadState.error = null;
    verifyAttachmentContent.mockReturnValue('image/png');
    attachmentRepository.transactionExists.mockResolvedValue(true);
    storeAttachment.mockResolvedValue('attachments/1/receipt.png');
  });

  describe('POST /transaction/:id', () => {
    it('stores the file and creates the DB row', async () => {
      attachmentRepository.create.mockResolvedValue(attachment({ id: 7, transaction_id: 1 }));

      const res = await api.post(`${BASE}/transaction/1`).expect(201);

      expect(res.body).toEqual(okEnvelope({ id: 7, transaction_id: 1 }));
      expect(attachmentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ stored_path: 'attachments/1/receipt.png' }),
      );
      expect(removeAttachmentFile).not.toHaveBeenCalled();
    });

    it('removes the stored file when the DB insert fails', async () => {
      // The tx-exists check races a concurrent hard delete: the insert can
      // still fail after storeAttachment, which used to orphan the file.
      attachmentRepository.create.mockRejectedValue(new Error('FK violation'));
      removeAttachmentFile.mockResolvedValue(undefined);

      await api.post(`${BASE}/transaction/1`).expect(500);

      expect(removeAttachmentFile).toHaveBeenCalledWith('attachments/1/receipt.png');
    });

    it('still surfaces the insert error when cleanup itself fails', async () => {
      attachmentRepository.create.mockRejectedValue(new Error('FK violation'));
      removeAttachmentFile.mockRejectedValue(new Error('EACCES'));

      const res = await api.post(`${BASE}/transaction/1`).expect(500);

      expect(res.body.error.message).toBe('FK violation');
      expect(logger.warn).toHaveBeenCalled();
    });

    it('rejects a missing file with a 400 VALIDATION_ERROR envelope', async () => {
      // Newly on-path: the real middleware chain now runs, so a request with
      // no file actually reaches the "No file uploaded" guard.
      uploadState.file = undefined;

      const res = await api.post(`${BASE}/transaction/1`).expect(400);

      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      expect(attachmentRepository.transactionExists).not.toHaveBeenCalled();
    });

    it('rejects a non-integer :id via the real validateIdParam guard', async () => {
      const res = await api.post(`${BASE}/transaction/abc`).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      expect(attachmentRepository.transactionExists).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /:id', () => {
    it('deletes the row and the file and answers 204 with no body', async () => {
      attachmentRepository.findById.mockResolvedValue(attachment({ id: 7, stored_path: 'attachments/1/receipt.png' }));
      attachmentRepository.deleteById.mockResolvedValue(true);
      removeAttachmentFile.mockResolvedValue(undefined);

      const res = await api.delete(`${BASE}/7`).expect(204);

      expect(attachmentRepository.deleteById).toHaveBeenCalledWith(7);
      expect(removeAttachmentFile).toHaveBeenCalledWith('attachments/1/receipt.png');
      expect(res.text).toBe('');
    });

    // The row is already gone; an orphaned file is logged, not surfaced.
    it('still answers 204 when the file removal fails', async () => {
      attachmentRepository.findById.mockResolvedValue(attachment({ id: 7, stored_path: 'attachments/1/receipt.png' }));
      attachmentRepository.deleteById.mockResolvedValue(true);
      removeAttachmentFile.mockRejectedValue(new Error('EACCES'));

      const res = await api.delete(`${BASE}/7`).expect(204);

      expect(logger.warn).toHaveBeenCalled();
      expect(res.text).toBe('');
    });

    it('404s when the attachment does not exist', async () => {
      attachmentRepository.findById.mockResolvedValue(null);

      const res = await api.delete(`${BASE}/99`).expect(404);

      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(attachmentRepository.deleteById).not.toHaveBeenCalled();
    });
  });

  // Pagination is opt-in: the attachment strip sends no limit/offset and must
  // keep receiving every file on the transaction.
  describe('GET /transaction/:id', () => {
    it('lists every attachment (unbounded query, no limit/offset echoed)', async () => {
      attachmentRepository.listByTransaction.mockResolvedValue([attachment({ id: 1 }), attachment({ id: 2 })]);

      const res = await api.get(`${BASE}/transaction/5`).expect(200);

      expect(attachmentRepository.listByTransaction).toHaveBeenCalledWith(5, {});
      expect(attachmentRepository.countByTransaction).not.toHaveBeenCalled();
      expect(res.body).toEqual(okEnvelope({ items: [{ id: 1 }, { id: 2 }], total: 2 }));
    });

    it('pages and reports the full total when limit/offset are supplied', async () => {
      attachmentRepository.listByTransaction.mockResolvedValue([attachment({ id: 2 })]);
      attachmentRepository.countByTransaction.mockResolvedValue(4);

      const res = await api.get(`${BASE}/transaction/5?limit=1&offset=1`).expect(200);

      expect(attachmentRepository.listByTransaction).toHaveBeenCalledWith(5, { limit: 1, offset: 1 });
      expect(res.body).toEqual(okEnvelope({ items: [{ id: 2 }], total: 4, limit: 1, offset: 1 }));
    });
  });
});

describe('Attachment routes — :id params (zod)', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['get', `${BASE}/transaction/1e3`],
    ['get', `${BASE}/0/download`],
    ['delete', `${BASE}/-1`],
  ] as const)('%s %s rejects a malformed id before touching the store', async (method, path) => {
    const res = await api[method](path).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(attachmentRepository.listByTransaction).not.toHaveBeenCalled();
    expect(attachmentRepository.findById).not.toHaveBeenCalled();
  });

  it('keeps unparseable pagination falling back instead of rejecting', async () => {
    attachmentRepository.listByTransaction.mockResolvedValue([]);
    attachmentRepository.countByTransaction.mockResolvedValue(0);
    await api.get(`${BASE}/transaction/4?limit=abc`).expect(200);
    expect(attachmentRepository.listByTransaction).toHaveBeenCalledWith(4, { limit: 1000, offset: 0 });
  });
});
