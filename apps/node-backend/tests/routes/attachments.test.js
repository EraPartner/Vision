/**
 * Attachment route tests — upload cleanup on failed DB insert.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const routeHandlers = {};
const mockRouter = {
  get: vi.fn((path, ...handlers) => { routeHandlers[`get:${path}`] = handlers[handlers.length - 1]; }),
  post: vi.fn((path, ...handlers) => { routeHandlers[`post:${path}`] = handlers[handlers.length - 1]; }),
  patch: vi.fn((path, ...handlers) => { routeHandlers[`patch:${path}`] = handlers[handlers.length - 1]; }),
  delete: vi.fn((path, ...handlers) => { routeHandlers[`delete:${path}`] = handlers[handlers.length - 1]; }),
  use: vi.fn(),
};

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('../../src/services/attachmentRecordService.js', () => ({
  attachmentRepository: {
    create: vi.fn(),
    findById: vi.fn(),
    listByTransaction: vi.fn(),
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

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { attachmentRepository } from '../../src/services/attachmentRecordService.js';
import { storeAttachment, removeAttachmentFile, verifyAttachmentContent } from '../../src/services/attachmentService.js';
import { query as dbQuery } from '../../src/database/connection.js';
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
    dbQuery.mockResolvedValue({ rows: [{ id: 1 }] });
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
});

function mockResponse() {
  const res = {
    json: vi.fn(),
    status: vi.fn(),
    send: vi.fn(),
    setHeader: vi.fn(),
    end: vi.fn(),
    headersSent: false,
  };
  res.status.mockReturnValue(res);
  res.ok = (data, meta) => {
    const body = { ok: true, data };
    if (meta) body.meta = meta;
    return res.json(body);
  };
  return res;
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
