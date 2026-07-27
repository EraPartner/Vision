import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';

const { router: mockRouter, handlers: routeHandlers } = createMockRouter();

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('../../src/repositories/tagRepository.js', () => ({
  default: {
    getAll: vi.fn(),
    getCount: vi.fn(),
    getBySlug: vi.fn(),
    findOrCreateBySlug: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    countTransactionReferences: vi.fn(),
  },
}));

vi.mock('../../src/middleware/validation.js', () => ({
  validateIdParam: vi.fn((_req, _res, next) => next()),
}));

await import('../../src/routes/tags.js');

import tagRepository from '../../src/repositories/tagRepository.js';

describe('GET /api/tags', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns active tags by default', async () => {
    tagRepository.getAll.mockResolvedValue([{ id: 1, slug: 'rome-2020', is_active: true }]);
    tagRepository.getCount.mockResolvedValue(1);
    const req = { query: {} };
    const res = mockResponse();
    await routeHandlers['get:/'](req, res);
    expect(tagRepository.getAll).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
    expect(res.json.mock.calls[0][0].data.total).toBe(1);
    expect(res.json.mock.calls[0][0].data.items[0].slug).toBe('rome-2020');
  });

  it('passes active=false when ?active=false', async () => {
    tagRepository.getAll.mockResolvedValue([]);
    tagRepository.getCount.mockResolvedValue(0);
    const req = { query: { active: 'false' } };
    const res = mockResponse();
    await routeHandlers['get:/'](req, res);
    expect(tagRepository.getAll).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
  });

  it('passes active=null when ?active=all', async () => {
    tagRepository.getAll.mockResolvedValue([]);
    tagRepository.getCount.mockResolvedValue(0);
    const req = { query: { active: 'all' } };
    const res = mockResponse();
    await routeHandlers['get:/'](req, res);
    expect(tagRepository.getAll).toHaveBeenCalledWith(expect.objectContaining({ active: null }));
  });
});

describe('POST /api/tags', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates new tag, slugifies input, returns 201', async () => {
    tagRepository.getBySlug.mockResolvedValue(null);
    tagRepository.findOrCreateBySlug.mockResolvedValue({
      tag: { id: 1, slug: 'rome-2020', color: null, is_active: true },
      reactivated: false,
    });
    const req = { body: { slug: 'Rome 2020' } };
    const res = mockResponse();
    await routeHandlers['post:/'](req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(tagRepository.findOrCreateBySlug).toHaveBeenCalledWith('rome-2020', null);
    expect(res.json.mock.calls[0][0].data.slug).toBe('rome-2020');
    expect(res.json.mock.calls[0][0].data.reactivated).toBe(false);
  });

  it('reactivates inactive tag, returns 201 with junction count', async () => {
    tagRepository.getBySlug.mockResolvedValue({ id: 5, slug: 'old', is_active: false });
    tagRepository.countTransactionReferences.mockResolvedValue(3);
    tagRepository.findOrCreateBySlug.mockResolvedValue({
      tag: { id: 5, slug: 'old', is_active: true },
      reactivated: true,
    });
    const req = { body: { slug: 'old' } };
    const res = mockResponse();
    await routeHandlers['post:/'](req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    const data = res.json.mock.calls[0][0].data;
    expect(data.reactivated).toBe(true);
    expect(data.reactivated_junction_count).toBe(3);
  });

  it('returns 200 when slug matches an active tag (conflict update path)', async () => {
    tagRepository.getBySlug.mockResolvedValue({ id: 6, slug: 'active', is_active: true });
    tagRepository.findOrCreateBySlug.mockResolvedValue({
      tag: { id: 6, slug: 'active', is_active: true },
      reactivated: true,
    });
    const req = { body: { slug: 'active' } };
    const res = mockResponse();
    await routeHandlers['post:/'](req, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 400 when slug is missing', async () => {
    const req = { body: {} };
    const res = mockResponse();
    await callHandler(routeHandlers['post:/'], req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when slug normalizes to empty string', async () => {
    const req = { body: { slug: '!!!' } };
    const res = mockResponse();
    await callHandler(routeHandlers['post:/'], req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when color is not a string', async () => {
    tagRepository.getBySlug.mockResolvedValue(null);
    const req = { body: { slug: 'valid', color: 123 } };
    const res = mockResponse();
    await callHandler(routeHandlers['post:/'], req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('accepts null color', async () => {
    tagRepository.getBySlug.mockResolvedValue(null);
    tagRepository.findOrCreateBySlug.mockResolvedValue({
      tag: { id: 1, slug: 'x', color: null, is_active: true },
      reactivated: false,
    });
    const req = { body: { slug: 'x', color: null } };
    const res = mockResponse();
    await routeHandlers['post:/'](req, res);
    expect(tagRepository.findOrCreateBySlug).toHaveBeenCalledWith('x', null);
  });
});

describe('PATCH /api/tags/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates color and returns the tag', async () => {
    tagRepository.update.mockResolvedValue({ id: 1, slug: 'rome', color: '#f00', is_active: true });
    const req = { params: { id: '1' }, body: { color: '#f00' } };
    const res = mockResponse();
    await routeHandlers['patch:/:id'](req, res);
    expect(res.json.mock.calls[0][0].data.color).toBe('#f00');
  });

  it('returns 404 when tag not found', async () => {
    tagRepository.update.mockResolvedValue(null);
    const req = { params: { id: '999' }, body: { color: '#f00' } };
    const res = mockResponse();
    await callHandler(routeHandlers['patch:/:id'], req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 400 when color is not a string', async () => {
    const req = { params: { id: '1' }, body: { color: 42 } };
    const res = mockResponse();
    await callHandler(routeHandlers['patch:/:id'], req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when is_active is not a boolean', async () => {
    const req = { params: { id: '1' }, body: { is_active: 'yes' } };
    const res = mockResponse();
    await callHandler(routeHandlers['patch:/:id'], req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('DELETE /api/tags/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  // Soft delete, so 200 + the deactivated entity rather than 204 (see
  // docs/reference/code-patterns.md, "DELETE responses").
  it('soft-deletes and returns 200 with the deactivated tag', async () => {
    tagRepository.softDelete.mockResolvedValue({ id: 1, slug: 'rome', is_active: false });
    const req = { params: { id: '1' } };
    const res = mockResponse();
    await routeHandlers['delete:/:id'](req, res);
    const data = res.json.mock.calls[0][0].data;
    expect(data).toMatchObject({ id: 1, slug: 'rome', is_active: false, links: [] });
    expect(res.status).not.toHaveBeenCalledWith(204);
  });

  it('returns 404 when tag not found', async () => {
    tagRepository.softDelete.mockResolvedValue(null);
    const req = { params: { id: '999' } };
    const res = mockResponse();
    await callHandler(routeHandlers['delete:/:id'], req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

function mockResponse() {
  return createMockResponse({ headersSent: false });
}

async function callHandler(handler, req, res) {
  try {
    await handler(req, res);
  } catch (err) {
    const status = err.status ?? 500;
    const code = err.code ?? 'INTERNAL_SERVER_ERROR';
    res.status(status).json({ ok: false, error: { code, message: err.message } });
  }
}
