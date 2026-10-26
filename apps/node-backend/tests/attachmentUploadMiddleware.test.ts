import { describe, expect, it, vi } from 'vitest';

/** The slice of multer's options the middleware passes and the tests read. */
interface CapturedMulterOptions {
  storage: unknown;
  limits: unknown;
  fileFilter: (
    req: object,
    file: { mimetype: string },
    cb: (...args: unknown[]) => void,
  ) => void;
}

const multerState = vi.hoisted(() => ({
  options: undefined as CapturedMulterOptions | undefined,
}));

vi.mock('multer', () => {
  const multer = Object.assign(
    vi.fn((options: CapturedMulterOptions) => {
      multerState.options = options;
      return { single: vi.fn() };
    }),
    { memoryStorage: vi.fn(() => ({ kind: 'memory' })) },
  );
  return { default: multer };
});

vi.mock('../src/services/attachmentService.ts', () => ({
  ATTACHMENT_MAX_SIZE_BYTES: 10 * 1024 * 1024,
  isAllowedAttachmentMime: (mimeType: string) => mimeType.startsWith('image/') || mimeType === 'application/pdf',
}));

import { attachmentUpload } from '../src/middleware/attachmentUpload.ts';
import { must } from "./helpers/must.ts";

import { mockOf } from "./helpers/mockOf.ts";
describe('attachment upload middleware', () => {
  it('uses memory storage and the configured byte ceiling', () => {
    expect(mockOf(attachmentUpload, "single")).toEqual(expect.any(Function));
    expect(must(multerState.options, "multerState.options").storage).toEqual({ kind: 'memory' });
    expect(must(multerState.options, "multerState.options").limits).toEqual({ fileSize: 10 * 1024 * 1024 });
  });

  it.each(['image/png', 'application/pdf'])('accepts declared MIME type %s', (mimetype) => {
    const cb = vi.fn();
    must(multerState.options, "multerState.options").fileFilter({}, { mimetype }, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('rejects a declared MIME type outside the attachment policy', () => {
    const cb = vi.fn();
    must(multerState.options, "multerState.options").fileFilter({}, { mimetype: 'text/plain' }, cb);
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Unsupported file type: text/plain. Allowed: images and PDF.' }),
    );
  });
});
