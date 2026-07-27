/**
 * Attachment route tests — upload cleanup on failed DB insert.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';

const { router: mockRouter, handlers: routeHandlers } = createMockRouter();

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

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

vi.mock('../../src/services/attachmentService.js', () => ({
  attachmentUpload: { single: vi.fn(() => vi.fn()) },
  storeAttachment: vi.fn(),
  resolveAbsolutePath: vi.fn(),
  removeAttachmentFile: vi.fn(),
  verifyAttachmentContent: vi.fn(),
}));

vi.mock('../../src/middleware/validation.js', () => ({
  validateIdParam: vi.fn(),
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import { attachmentRepository } from '../../src/services/attachmentRecordService.js';
import { storeAttachment, removeAttachmentFile, verifyAttachmentContent } from '../../src/services/attachmentService.js';
import { logger } from '../../src/config/logger.js';
await import('../../src/routes/attachments.js');

const UPLOAD_REQ = () => ({
  params: { id: '1' },
  file: { originalname: 'receipt.png', size: 1234 },
});

describe('Attachment routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyAttachmentContent.mockReturnValue('image/png');
    attachmentRepository.transactionExists.mockResolvedValue(true);
    storeAttachment.mockResolvedValue('attachments/1/receipt.png');
  });

  describe('POST /transaction/:id', () => {
    it('stores the file and creates the DB row', async () => {
      attachmentRepository.create.mockResolvedValue({ id: 7, transaction_id: 1 });

      const res = mockResponse();
      await callHandler(routeHandlers['post:/transaction/:id'], UPLOAD_REQ(), res);

      expect(res.status).toHaveBeenCalledWith(201);
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

      const res = mockResponse();
      await callHandler(routeHandlers['post:/transaction/:id'], UPLOAD_REQ(), res);

      expect(removeAttachmentFile).toHaveBeenCalledWith('attachments/1/receipt.png');
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('still surfaces the insert error when cleanup itself fails', async () => {
      attachmentRepository.create.mockRejectedValue(new Error('FK violation'));
      removeAttachmentFile.mockRejectedValue(new Error('EACCES'));

      const res = mockResponse();
      await callHandler(routeHandlers['post:/transaction/:id'], UPLOAD_REQ(), res);

      expect(res.status).toHaveBeenCalledWith(500);
      const body = res.json.mock.calls[0][0];
      expect(body.error.message).toBe('FK violation');
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('DELETE /:id', () => {
    it('deletes the row and the file and answers 204 with no body', async () => {
      attachmentRepository.findById.mockResolvedValue({ id: 7, stored_path: 'attachments/1/receipt.png' });
      attachmentRepository.deleteById.mockResolvedValue(true);
      removeAttachmentFile.mockResolvedValue(undefined);

      const res = mockResponse();
      await routeHandlers['delete:/:id']({ params: { id: '7' } }, res);

      expect(attachmentRepository.deleteById).toHaveBeenCalledWith(7);
      expect(removeAttachmentFile).toHaveBeenCalledWith('attachments/1/receipt.png');
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalledWith();
      expect(res.json).not.toHaveBeenCalled();
    });

    // The row is already gone; an orphaned file is logged, not surfaced.
    it('still answers 204 when the file removal fails', async () => {
      attachmentRepository.findById.mockResolvedValue({ id: 7, stored_path: 'attachments/1/receipt.png' });
      attachmentRepository.deleteById.mockResolvedValue(true);
      removeAttachmentFile.mockRejectedValue(new Error('EACCES'));

      const res = mockResponse();
      await routeHandlers['delete:/:id']({ params: { id: '7' } }, res);

      expect(logger.warn).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.json).not.toHaveBeenCalled();
    });

    it('404s when the attachment does not exist', async () => {
      attachmentRepository.findById.mockResolvedValue(null);

      const res = mockResponse();
      await callHandler(routeHandlers['delete:/:id'], { params: { id: '99' } }, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(attachmentRepository.deleteById).not.toHaveBeenCalled();
    });
  });

  // Pagination is opt-in: the attachment strip sends no limit/offset and must
  // keep receiving every file on the transaction.
  describe('GET /transaction/:id', () => {
    it('lists every attachment (unbounded query, no limit/offset echoed)', async () => {
      attachmentRepository.listByTransaction.mockResolvedValue([{ id: 1 }, { id: 2 }]);

      const res = mockResponse();
      await routeHandlers['get:/transaction/:id']({ params: { id: '5' }, query: {} }, res);

      expect(attachmentRepository.listByTransaction).toHaveBeenCalledWith(5, {});
      expect(attachmentRepository.countByTransaction).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        data: { items: [{ id: 1 }, { id: 2 }], total: 2 },
      });
    });

    it('pages and reports the full total when limit/offset are supplied', async () => {
      attachmentRepository.listByTransaction.mockResolvedValue([{ id: 2 }]);
      attachmentRepository.countByTransaction.mockResolvedValue(4);

      const res = mockResponse();
      await routeHandlers['get:/transaction/:id'](
        { params: { id: '5' }, query: { limit: '1', offset: '1' } },
        res,
      );

      expect(attachmentRepository.listByTransaction).toHaveBeenCalledWith(5, { limit: 1, offset: 1 });
      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        data: { items: [{ id: 2 }], total: 4, limit: 1, offset: 1 },
      });
    });
  });
});

function mockResponse() {
  return createMockResponse({ setHeader: vi.fn(), end: vi.fn(), headersSent: false });
}

async function callHandler(handler, req, res) {
  try {
    await handler(req, res);
  } catch (err) {
    const status = err.status ?? 500;
    const code = err.code ?? 'INTERNAL_SERVER_ERROR';
    const message = err.message ?? 'Internal server error';
    const error = { code, message };
    if (err.details !== undefined) error.details = err.details;
    res.status(status).json({ ok: false, error });
  }
}
