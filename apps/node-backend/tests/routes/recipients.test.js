/**
 * Recipient route tests.
 * Mirrors: apps/backend/tests/test_recipients.py
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';

const { router: mockRouter, handlers: routeHandlers } = createMockRouter();

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

vi.mock('../../src/services/recipientMergeService.js', () => ({
  mergeRecipients: vi.fn(),
}));

vi.mock('../../src/services/recipientPatternService.js', () => ({
  listPatternsForRecipient: vi.fn(),
  createPattern: vi.fn(),
  updatePattern: vi.fn(),
  deletePattern: vi.fn(),
  previewPatternMatches: vi.fn(),
  suggestPatternFromNames: vi.fn(() => null),
}));

vi.mock('../../src/services/recipientClusterService.js', () => ({
  findRecipientClusters: vi.fn(),
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import recipientRepository from '../../src/repositories/recipientRepository.js';
import { mergeRecipients as mergeRecipientsAtomic } from '../../src/services/recipientMergeService.js';
import { ValidationError, NotFoundError } from '../../src/middleware/errorHandler.js';
await import('../../src/routes/recipients.js');

describe('Recipient Routes', () => {
  beforeEach(() => vi.resetAllMocks());

  describe('GET /', () => {
    it('should return empty list', async () => {
      recipientRepository.getAll.mockResolvedValue([]);
      recipientRepository.getCount.mockResolvedValue(0);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.ok).toBe(true);
      expect(result.data.items).toEqual([]);
      expect(result.data.total).toBe(0);
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

      expect(res.json.mock.calls[0][0].data.total).toBe(2);
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

    it('should throw ValidationError for missing name', async () => {
      const req = { body: {} };
      const res = mockResponse();
      await expect(routeHandlers['post:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
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

    it('should throw NotFoundError for non-existent', async () => {
      recipientRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await expect(routeHandlers['get:/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
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

    it('should throw NotFoundError for non-existent', async () => {
      recipientRepository.update.mockResolvedValue(null);

      const req = { params: { id: '99999' }, body: { notes: 'x' } };
      const res = mockResponse();
      await expect(routeHandlers['patch:/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('DELETE /:id', () => {
    it('should delete recipient', async () => {
      recipientRepository.hardDelete.mockResolvedValue(true);

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.json.mock.calls[0][0].data.message).toContain('deleted permanently');
    });

    it('should throw NotFoundError for non-existent', async () => {
      recipientRepository.hardDelete.mockResolvedValue(false);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await expect(routeHandlers['delete:/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('POST /:id/merge', () => {
    it('should throw ValidationError when alias_ids is missing', async () => {
      const req = { params: { id: '1' }, body: {} };
      const res = mockResponse();
      await expect(routeHandlers['post:/:id/merge'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('should throw ValidationError when primary recipient is itself an alias', async () => {
      recipientRepository.getById.mockResolvedValue({ id: 1, primary_recipient_id: 2 });

      const req = { params: { id: '1' }, body: { alias_ids: [3] } };
      const res = mockResponse();
      await expect(routeHandlers['post:/:id/merge'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('should merge aliases and return primary plus aliases', async () => {
      recipientRepository.getById
        .mockResolvedValueOnce({ id: 1, name: 'PRIMARY', primary_recipient_id: null })
        .mockResolvedValueOnce({ id: 1, name: 'PRIMARY', primary_recipient_id: null });
      mergeRecipientsAtomic.mockResolvedValue({
        mergedAliasIds: [3, 4],
        reassigned: { transactions: 7, splits: 0, planned: 0, bankAccounts: 1 },
      });
      recipientRepository.getAliases.mockResolvedValue([
        { id: 3, name: 'ALIAS A' },
        { id: 4, name: 'ALIAS B' },
      ]);

      const req = { params: { id: '1' }, body: { alias_ids: ['3', '4'] } };
      const res = mockResponse();
      await routeHandlers['post:/:id/merge'](req, res);

      expect(mergeRecipientsAtomic).toHaveBeenCalledWith(1, [3, 4]);
      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        data: {
          primary: { id: 1, name: 'PRIMARY', primary_recipient_id: null, links: [] },
          merged_ids: [3, 4],
          reassigned: { transactions: 7, splits: 0, planned: 0, bankAccounts: 1 },
          aliases: [
            { id: 3, name: 'ALIAS A' },
            { id: 4, name: 'ALIAS B' },
          ],
          patternSuggestion: null,
        },
      });
    });

    it('should throw NotFoundError when primary recipient does not exist', async () => {
      recipientRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '123' }, body: { alias_ids: [5] } };
      const res = mockResponse();
      await expect(routeHandlers['post:/:id/merge'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('POST /:id/unmerge', () => {
    it('should throw NotFoundError when recipient cannot be unmerged', async () => {
      recipientRepository.unmergeRecipient.mockResolvedValue(false);

      const req = { params: { id: '44' } };
      const res = mockResponse();
      await expect(routeHandlers['post:/:id/unmerge'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('should return updated recipient when unmerge succeeds', async () => {
      recipientRepository.unmergeRecipient.mockResolvedValue(true);
      recipientRepository.getById.mockResolvedValue({ id: 44, name: 'UNMERGED', primary_recipient_id: null });

      const req = { params: { id: '44' } };
      const res = mockResponse();
      await routeHandlers['post:/:id/unmerge'](req, res);

      expect(recipientRepository.unmergeRecipient).toHaveBeenCalledWith(44);
      expect(recipientRepository.getById).toHaveBeenCalledWith(44);
      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        data: { id: 44, name: 'UNMERGED', primary_recipient_id: null, links: [] },
      });
    });
  });

  describe('GET /:id/aliases', () => {
    it('should return aliases with pagination meta', async () => {
      recipientRepository.getAliases.mockResolvedValue([
        { id: 10, name: 'Alias One', primary_recipient_id: 1 },
        { id: 11, name: 'Alias Two', primary_recipient_id: 1 },
      ]);

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['get:/:id/aliases'](req, res);

      expect(recipientRepository.getAliases).toHaveBeenCalledWith(1);
      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        data: {
          items: [
            { id: 10, name: 'Alias One', primary_recipient_id: 1, links: [] },
            { id: 11, name: 'Alias Two', primary_recipient_id: 1, links: [] },
          ],
          total: 2,
        },
      });
    });
  });
});

function mockResponse() {
  return createMockResponse();
}
