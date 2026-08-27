import { describe, expect, it, vi } from 'vitest';

const multerState = vi.hoisted(() => ({ options: undefined }));

vi.mock('multer', () => {
  const multer = vi.fn((options) => {
    multerState.options = options;
    return { single: vi.fn() };
  });
  multer.memoryStorage = vi.fn(() => ({ kind: 'memory' }));
  return { default: multer };
});

vi.mock('../src/services/attachmentService.js', () => ({
  ATTACHMENT_MAX_SIZE_BYTES: 10 * 1024 * 1024,
  isAllowedAttachmentMime: (mimeType) => mimeType.startsWith('image/') || mimeType === 'application/pdf',
}));

import multer from 'multer';
import { attachmentUpload } from '../src/middleware/attachmentUpload.js';

describe('attachment upload middleware', () => {
  it('uses memory storage and the configured byte ceiling', () => {
    expect(attachmentUpload.single).toEqual(expect.any(Function));
    expect(multer.memoryStorage).toHaveBeenCalledOnce();
    expect(multerState.options.storage).toEqual({ kind: 'memory' });
    expect(multerState.options.limits).toEqual({ fileSize: 10 * 1024 * 1024 });
  });

  it.each(['image/png', 'application/pdf'])('accepts declared MIME type %s', (mimetype) => {
    const cb = vi.fn();
    multerState.options.fileFilter({}, { mimetype }, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('rejects a declared MIME type outside the attachment policy', () => {
    const cb = vi.fn();
    multerState.options.fileFilter({}, { mimetype: 'text/plain' }, cb);
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Unsupported file type: text/plain. Allowed: images and PDF.' }),
    );
  });
});
