/**
 * Attachment route tests — upload cleanup on failed DB insert.
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js) — validateIdParam is no longer stubbed. The
 * multer upload middleware (`attachmentUpload.single`) stays mocked because
 * the route test does not need to parse multipart bodies; the mock drives `req.file` /
 * upload errors through the real middleware chain instead of the test
 * hand-building a `req.file`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { routeAgent, okEnvelope, errEnvelope } from '../helpers/routeApp.js';

const uploadState = vi.hoisted(() => ({ file: null, error: null }));

vi.mock('../../src/services/attachmentRecordService.js', () => ({
  attachmentRepository: {
    transactionExists: vi.fn(),
    create: vi.fn(),
    findById: vi.fn(),
    listByTransaction: vi.fn(),
    countByTransaction: vi.fn(),
    deleteById: vi.fn(),
  },
}));

vi.mock('../../src/middleware/attachmentUpload.js', () => ({
  attachmentUpload: {
    single: () => (req, _res, cb) => {
      if (uploadState.error) return cb(uploadState.error);
      req.file = uploadState.file;
      cb();
    },
  },
}));

vi.mock('../../src/services/attachmentService.js', () => ({
  storeAttachment: vi.fn(),
  resolveAbsolutePath: vi.fn(),
  removeAttachmentFile: vi.fn(),
  verifyAttachmentContent: vi.fn(),
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import { attachmentRepository } from '../../src/services/attachmentRecordService.js';
import { storeAttachment, removeAttachmentFile, verifyAttachmentContent } from '../../src/services/attachmentService.js';
import { logger } from '../../src/config/logger.js';

const { default: attachmentsRouter } = await import('../../src/routes/attachments.js');

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
      attachmentRepository.create.mockResolvedValue({ id: 7, transaction_id: 1 });

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
      attachmentRepository.findById.mockResolvedValue({ id: 7, stored_path: 'attachments/1/receipt.png' });
      attachmentRepository.deleteById.mockResolvedValue(true);
      removeAttachmentFile.mockResolvedValue(undefined);

      const res = await api.delete(`${BASE}/7`).expect(204);

      expect(attachmentRepository.deleteById).toHaveBeenCalledWith(7);
      expect(removeAttachmentFile).toHaveBeenCalledWith('attachments/1/receipt.png');
      expect(res.text).toBe('');
    });

    // The row is already gone; an orphaned file is logged, not surfaced.
    it('still answers 204 when the file removal fails', async () => {
      attachmentRepository.findById.mockResolvedValue({ id: 7, stored_path: 'attachments/1/receipt.png' });
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
      attachmentRepository.listByTransaction.mockResolvedValue([{ id: 1 }, { id: 2 }]);

      const res = await api.get(`${BASE}/transaction/5`).expect(200);

      expect(attachmentRepository.listByTransaction).toHaveBeenCalledWith(5, {});
      expect(attachmentRepository.countByTransaction).not.toHaveBeenCalled();
      expect(res.body).toEqual(okEnvelope({ items: [{ id: 1 }, { id: 2 }], total: 2 }));
    });

    it('pages and reports the full total when limit/offset are supplied', async () => {
      attachmentRepository.listByTransaction.mockResolvedValue([{ id: 2 }]);
      attachmentRepository.countByTransaction.mockResolvedValue(4);

      const res = await api.get(`${BASE}/transaction/5?limit=1&offset=1`).expect(200);

      expect(attachmentRepository.listByTransaction).toHaveBeenCalledWith(5, { limit: 1, offset: 1 });
      expect(res.body).toEqual(okEnvelope({ items: [{ id: 2 }], total: 4, limit: 1, offset: 1 }));
    });
  });
});
