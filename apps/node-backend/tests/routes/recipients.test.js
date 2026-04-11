/**
 * Recipient route tests.
 * Mirrors: apps/backend/tests/test_recipients.py
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

vi.mock('../../src/repositories/recipientRepository.js', () => ({
  default: {
    getAll: vi.fn(),
    getCount: vi.fn(),
    getById: vi.fn(),
    createOrGet: vi.fn(),
    update: vi.fn(),
    hardDelete: vi.fn(),
    mergeRecipients: vi.fn(),
    getAliases: vi.fn(),
    unmergeRecipient: vi.fn(),
  },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import recipientRepository from '../../src/repositories/recipientRepository.js';
await import('../../src/routes/recipients.js');

describe('Recipient Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /', () => {
    it('should return empty list', async () => {
      recipientRepository.getAll.mockResolvedValue([]);
      recipientRepository.getCount.mockResolvedValue(0);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should return recipients with data', async () => {
      recipientRepository.getAll.mockResolvedValue([
        { id: 1, name: 'JOHN DOE', is_active: true },
        { id: 2, name: 'JANE SMITH', is_active: true },
      ]);
      recipientRepository.getCount.mockResolvedValue(2);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.json.mock.calls[0][0].total).toBe(2);
    });
  });

  describe('POST /', () => {
    it('should create recipient with 201', async () => {
      recipientRepository.createOrGet.mockResolvedValue({
        recipient: { id: 1, name: 'JOHN DOE', is_active: true },
        created: true,
      });

      const req = { body: { name: 'John Doe' } };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should return 200 for duplicate', async () => {
      recipientRepository.createOrGet.mockResolvedValue({
        recipient: { id: 1, name: 'JOHN DOE', is_active: true },
        created: false,
      });

      const req = { body: { name: 'John Doe' } };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should return 400 for missing name', async () => {
      const req = { body: {} };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('GET /:id', () => {
    it('should return recipient by id', async () => {
      recipientRepository.getById.mockResolvedValue({ id: 1, name: 'JOHN DOE' });

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['get:/:id'](req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should return 404 for non-existent', async () => {
      recipientRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await routeHandlers['get:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('PATCH /:id', () => {
    it('should update recipient', async () => {
      recipientRepository.update.mockResolvedValue({ id: 1, name: 'UPDATED' });

      const req = { params: { id: '1' }, body: { notes: 'new' } };
      const res = mockResponse();
      await routeHandlers['patch:/:id'](req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should return 404 for non-existent', async () => {
      recipientRepository.update.mockResolvedValue(null);

      const req = { params: { id: '99999' }, body: { notes: 'x' } };
      const res = mockResponse();
      await routeHandlers['patch:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('DELETE /:id', () => {
    it('should delete recipient', async () => {
      recipientRepository.hardDelete.mockResolvedValue(true);

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.json.mock.calls[0][0].message).toContain('deleted permanently');
    });

    it('should return 404 for non-existent', async () => {
      recipientRepository.hardDelete.mockResolvedValue(false);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('POST /:id/merge', () => {
    it('should return 400 when alias_ids is missing', async () => {
      const req = { params: { id: '1' }, body: {} };
      const res = mockResponse();
      await routeHandlers['post:/:id/merge'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Missing required field: alias_ids (array of recipient IDs)' });
    });

    it('should return 400 when primary recipient is itself an alias', async () => {
      recipientRepository.getById.mockResolvedValue({ id: 1, primary_recipient_id: 2 });

      const req = { params: { id: '1' }, body: { alias_ids: [3] } };
      const res = mockResponse();
      await routeHandlers['post:/:id/merge'](req, res);

      expect(recipientRepository.getById).toHaveBeenCalledWith(1);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        detail: 'Cannot merge into a recipient that is itself an alias. Use its primary instead.',
      });
    });

    it('should merge aliases and return primary plus aliases', async () => {
      recipientRepository.getById
        .mockResolvedValueOnce({ id: 1, name: 'PRIMARY', primary_recipient_id: null })
        .mockResolvedValueOnce({ id: 1, name: 'PRIMARY', primary_recipient_id: null });
      recipientRepository.mergeRecipients.mockResolvedValue([3, 4]);
      recipientRepository.getAliases.mockResolvedValue([
        { id: 3, name: 'ALIAS A' },
        { id: 4, name: 'ALIAS B' },
      ]);

      const req = { params: { id: '1' }, body: { alias_ids: ['3', '4'] } };
      const res = mockResponse();
      await routeHandlers['post:/:id/merge'](req, res);

      expect(recipientRepository.mergeRecipients).toHaveBeenCalledWith(1, [3, 4]);
      expect(res.json).toHaveBeenCalledWith({
        primary: { id: 1, name: 'PRIMARY', primary_recipient_id: null, links: [] },
        merged_ids: [3, 4],
        aliases: [
          { id: 3, name: 'ALIAS A' },
          { id: 4, name: 'ALIAS B' },
        ],
      });
    });

    it('should return 404 when primary recipient does not exist', async () => {
      recipientRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '123' }, body: { alias_ids: [5] } };
      const res = mockResponse();
      await routeHandlers['post:/:id/merge'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Primary recipient not found' });
    });
  });

  describe('POST /:id/unmerge', () => {
    it('should return 404 when recipient cannot be unmerged', async () => {
      recipientRepository.unmergeRecipient.mockResolvedValue(false);

      const req = { params: { id: '44' } };
      const res = mockResponse();
      await routeHandlers['post:/:id/unmerge'](req, res);

      expect(recipientRepository.unmergeRecipient).toHaveBeenCalledWith(44);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Recipient not found' });
    });

    it('should return updated recipient when unmerge succeeds', async () => {
      recipientRepository.unmergeRecipient.mockResolvedValue(true);
      recipientRepository.getById.mockResolvedValue({ id: 44, name: 'UNMERGED', primary_recipient_id: null });

      const req = { params: { id: '44' } };
      const res = mockResponse();
      await routeHandlers['post:/:id/unmerge'](req, res);

      expect(recipientRepository.unmergeRecipient).toHaveBeenCalledWith(44);
      expect(recipientRepository.getById).toHaveBeenCalledWith(44);
      expect(res.json).toHaveBeenCalledWith({ id: 44, name: 'UNMERGED', primary_recipient_id: null, links: [] });
    });
  });

  describe('GET /:id/aliases', () => {
    it('should return aliases with items and total', async () => {
      recipientRepository.getAliases.mockResolvedValue([
        { id: 10, name: 'Alias One', primary_recipient_id: 1 },
        { id: 11, name: 'Alias Two', primary_recipient_id: 1 },
      ]);

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['get:/:id/aliases'](req, res);

      expect(recipientRepository.getAliases).toHaveBeenCalledWith(1);
      expect(res.json).toHaveBeenCalledWith({
        items: [
          { id: 10, name: 'Alias One', primary_recipient_id: 1, links: [] },
          { id: 11, name: 'Alias Two', primary_recipient_id: 1, links: [] },
        ],
        total: 2,
      });
    });
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
