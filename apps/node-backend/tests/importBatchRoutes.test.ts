import { describe, expect, it, vi } from 'vitest';
import type { Router } from 'express';
import { registerImportBatchRoutes } from '../src/routes/importBatchRoutes.ts';

// The registered handlers are called directly with hand-built req/res stubs.
type CapturedHandler = (req: unknown, res: unknown) => Promise<void>;

function captureRoutes(options: Parameters<typeof registerImportBatchRoutes>[1]) {
  const handlers = new Map<string, CapturedHandler>();
  const router = {
    get: vi.fn((path: string, handler: CapturedHandler) => handlers.set(`GET ${path}`, handler)),
    delete: vi.fn((path: string, handler: CapturedHandler) => handlers.set(`DELETE ${path}`, handler)),
  };
  registerImportBatchRoutes(router as unknown as Router, options);
  return {
    get: (key: string): CapturedHandler => {
      const handler = handlers.get(key);
      if (!handler) throw new Error(`No handler registered for ${key}`);
      return handler;
    },
  };
}

function response() {
  return { ok: vi.fn() };
}

describe('registerImportBatchRoutes', () => {
  it('registers the canonical paginated list response', async () => {
    const listBatches = vi.fn().mockResolvedValue({ batches: [{ id: 1 }], total: 1 });
    const handlers = captureRoutes({
      listBatches,
      getBatch: vi.fn(),
      inProgressStatuses: [],
      rollback: vi.fn(),
    });
    const res = response();

    await handlers.get('GET /batches')({ query: { limit: '999', offset: '4' } }, res);

    expect(listBatches).toHaveBeenCalledWith({ limit: 200, offset: 4 });
    expect(res.ok).toHaveBeenCalledWith({
      items: [{ id: 1 }],
      total: 1,
      limit: 200,
      offset: 4,
    });
  });

  it('returns a batch and preserves the shared not-found error', async () => {
    const getBatch = vi.fn().mockResolvedValueOnce({ id: 7 }).mockResolvedValueOnce(null);
    const handlers = captureRoutes({
      listBatches: vi.fn(),
      getBatch,
      inProgressStatuses: [],
      rollback: vi.fn(),
    });
    const res = response();

    await handlers.get('GET /batches/:id')({ params: { id: '7' } }, res);
    expect(res.ok).toHaveBeenCalledWith({ id: 7 });
    await expect(handlers.get('GET /batches/:id')({ params: { id: '8' } }, res))
      .rejects.toMatchObject({ message: 'Import batch 8 not found' });
  });

  it('applies the configured status guard before the pipeline rollback callback', async () => {
    const rollback = vi.fn().mockResolvedValue({ deleted: 2 });
    const getBatch = vi.fn()
      .mockResolvedValueOnce({ id: 3, status: 'pending' })
      .mockResolvedValueOnce({ id: 3, status: 'complete' });
    const handlers = captureRoutes({
      listBatches: vi.fn(),
      getBatch,
      inProgressStatuses: ['pending'],
      rollback,
    });
    const res = response();

    await expect(handlers.get('DELETE /batches/:id')({ params: { id: '3' } }, res))
      .rejects.toMatchObject({ message: 'Cannot rollback a batch that is still in progress' });
    expect(rollback).not.toHaveBeenCalled();

    await handlers.get('DELETE /batches/:id')({ params: { id: '3' } }, res);
    expect(rollback).toHaveBeenCalledWith(3);
    expect(res.ok).toHaveBeenCalledWith({ deleted: 2 });
  });

  it('rejects a malformed batch id with the canonical message before any lookup', async () => {
    const getBatch = vi.fn();
    const rollback = vi.fn();
    const handlers = captureRoutes({ listBatches: vi.fn(), getBatch, inProgressStatuses: [], rollback });
    const res = response();

    for (const key of ['GET /batches/:id', 'DELETE /batches/:id']) {
      for (const id of ['12abc', '1e3', '0', '-1']) {
        await expect(handlers.get(key)({ params: { id } }, res)).rejects.toMatchObject({
          code: 'VALIDATION_ERROR',
          message: 'Invalid batch id',
        });
      }
    }
    expect(getBatch).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('keeps BIGSERIAL batch ids above the int4 ceiling', async () => {
    const getBatch = vi.fn().mockResolvedValue({ id: 2147483648 });
    const handlers = captureRoutes({ listBatches: vi.fn(), getBatch, inProgressStatuses: [], rollback: vi.fn() });
    await handlers.get('GET /batches/:id')({ params: { id: '2147483648' } }, response());
    expect(getBatch).toHaveBeenCalledWith(2147483648);
  });

  it('keeps unparseable pagination on its fallbacks', async () => {
    const listBatches = vi.fn().mockResolvedValue({ batches: [], total: 0 });
    const handlers = captureRoutes({ listBatches, getBatch: vi.fn(), inProgressStatuses: [], rollback: vi.fn() });
    await handlers.get('GET /batches')({ query: { limit: 'abc', offset: '-3' } }, response());
    expect(listBatches).toHaveBeenCalledWith({ limit: 50, offset: 0 });
  });
});
