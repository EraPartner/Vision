import { describe, expect, it, vi } from 'vitest';
import { registerImportBatchRoutes } from '../src/routes/importBatchRoutes.js';

function captureRoutes(options) {
  const handlers = new Map();
  const router = {
    get: vi.fn((path, handler) => handlers.set(`GET ${path}`, handler)),
    delete: vi.fn((path, handler) => handlers.set(`DELETE ${path}`, handler)),
  };
  registerImportBatchRoutes(router, options);
  return handlers;
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
});
