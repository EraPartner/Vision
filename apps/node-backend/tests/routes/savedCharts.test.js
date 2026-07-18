import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';

const { router: mockRouter, handlers: routeHandlers } = createMockRouter();

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('../../src/repositories/savedChartsRepository.js', () => ({
  default: {
    getAll: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import savedChartsRepository from '../../src/repositories/savedChartsRepository.js';
import { ValidationError, NotFoundError } from '../../src/middleware/errorHandler.js';

await import('../../src/routes/savedCharts.js');

describe('Saved Charts Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /', () => {
    it('returns all saved charts', async () => {
      savedChartsRepository.getAll.mockResolvedValue([{ id: 1 }]);

      const req = {};
      const res = mockResponse();

      await routeHandlers['get:/'](req, res);

      expect(res.json).toHaveBeenCalledWith({ ok: true, data: [{ id: 1 }] });
    });

    it('propagates error when repository fails', async () => {
      savedChartsRepository.getAll.mockRejectedValue(new Error('db down'));

      const req = {};
      const res = mockResponse();

      await expect(routeHandlers['get:/'](req, res)).rejects.toThrow('db down');
    });
  });

  describe('POST /', () => {
    it('throws ValidationError when name is missing', async () => {
      const req = { body: { chartType: 'line', categoryIds: [1] } };
      const res = mockResponse();

      await expect(routeHandlers['post:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError when chartType is invalid', async () => {
      const req = { body: { name: 'Main', chartType: 'pie', categoryIds: [1] } };
      const res = mockResponse();

      await expect(routeHandlers['post:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError when categoryIds has invalid entries', async () => {
      const req = { body: { name: 'Main', chartType: 'line', categoryIds: [1, 'nope'] } };
      const res = mockResponse();

      await expect(routeHandlers['post:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('creates chart with trimmed name and default chart type', async () => {
      savedChartsRepository.create.mockResolvedValue({ id: 4, name: 'Main', chart_type: 'line', category_ids: [1, 2] });

      const req = { body: { name: '  Main  ', categoryIds: ['1', 2] } };
      const res = mockResponse();

      await routeHandlers['post:/'](req, res);

      expect(savedChartsRepository.create).toHaveBeenCalledWith({
        name: 'Main',
        chartType: 'line',
        categoryIds: [1, 2],
        recipientIds: undefined,
        allCategories: false,
        allRecipients: false,
        allTags: false,
        chartVariant: 'default',
        timeBucket: 'monthly',
        dateRangeStart: undefined,
        dateRangeEnd: undefined,
      });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { id: 4, name: 'Main', chart_type: 'line', category_ids: [1, 2] } });
    });

    it('normalizes tagIds when provided', async () => {
      savedChartsRepository.create.mockResolvedValue({ id: 5, name: 'Tagged', tag_ids: [5, 6] });

      const req = { body: { name: 'Tagged', categoryIds: [], tagIds: ['5', 6] } };
      const res = mockResponse();

      await routeHandlers['post:/'](req, res);

      expect(savedChartsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ tagIds: [5, 6] }),
      );
    });

    it('throws ValidationError when tagIds has invalid entries', async () => {
      const req = { body: { name: 'Main', categoryIds: [], tagIds: [1, 'nope'] } };
      const res = mockResponse();

      await expect(routeHandlers['post:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('passes all-source flags through to the repository', async () => {
      savedChartsRepository.create.mockResolvedValue({ id: 6, name: 'AllTags' });

      const req = { body: { name: 'AllTags', categoryIds: [], allTags: true } };
      const res = mockResponse();

      await routeHandlers['post:/'](req, res);

      expect(savedChartsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ allTags: true, allCategories: false, allRecipients: false }),
      );
    });

    it('throws ValidationError when an all-source flag is not a boolean', async () => {
      const req = { body: { name: 'Main', categoryIds: [], allTags: 'yes' } };
      const res = mockResponse();

      await expect(routeHandlers['post:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('accepts the ranked variant on a bar chart', async () => {
      savedChartsRepository.create.mockResolvedValue({ id: 7, name: 'Ranked' });

      const req = { body: { name: 'Ranked', categoryIds: [1], chartType: 'bar', chartVariant: 'ranked' } };
      const res = mockResponse();

      await routeHandlers['post:/'](req, res);

      expect(savedChartsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ chartType: 'bar', chartVariant: 'ranked' }),
      );
    });

    it('rejects the ranked variant on a line chart', async () => {
      const req = { body: { name: 'Bad', categoryIds: [1], chartType: 'line', chartVariant: 'ranked' } };
      const res = mockResponse();

      await expect(routeHandlers['post:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects a whitespace-only name', async () => {
      const req = { body: { name: '   ', categoryIds: [1] } };

      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
      expect(savedChartsRepository.create).not.toHaveBeenCalled();
    });

    it('rejects a non-string name', async () => {
      const req = { body: { name: 123, categoryIds: [1] } };

      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects a missing categoryIds field', async () => {
      const req = { body: { name: 'Main' } };

      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
      expect(savedChartsRepository.create).not.toHaveBeenCalled();
    });

    it('wraps a scalar categoryIds into a one-element int array', async () => {
      savedChartsRepository.create.mockResolvedValue({ id: 10 });

      const req = { body: { name: 'Scalar', categoryIds: '5' } };
      await routeHandlers['post:/'](req, mockResponse());

      expect(savedChartsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ categoryIds: [5] }),
      );
    });

    it('normalizes recipientIds and rejects invalid entries', async () => {
      savedChartsRepository.create.mockResolvedValue({ id: 11 });

      await routeHandlers['post:/']({ body: { name: 'R', categoryIds: [], recipientIds: ['2', 3] } }, mockResponse());
      expect(savedChartsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ recipientIds: [2, 3] }),
      );

      await expect(
        routeHandlers['post:/']({ body: { name: 'R', categoryIds: [], recipientIds: [0] } }, mockResponse()),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects an unknown chartVariant', async () => {
      const req = { body: { name: 'Main', categoryIds: [1], chartVariant: 'wavy' } };

      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects an unknown timeBucket', async () => {
      const req = { body: { name: 'Main', categoryIds: [1], timeBucket: 'weekly' } };

      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects a null chartType (only undefined may fall back to the default)', async () => {
      const req = { body: { name: 'Main', categoryIds: [1], chartType: null } };

      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('passes a yearly timeBucket through', async () => {
      savedChartsRepository.create.mockResolvedValue({ id: 12 });

      const req = { body: { name: 'Yearly', categoryIds: [1], timeBucket: 'yearly' } };
      await routeHandlers['post:/'](req, mockResponse());

      expect(savedChartsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ timeBucket: 'yearly' }),
      );
    });

    // Full INVALID_COMBINATIONS coverage: the variant defaults interact with the
    // cross-field rule, so pin every illegal (chartType, chartVariant) pair.
    it.each([
      ['line', 'stacked'],
      ['line', 'grouped'],
      ['line', 'ranked'],
      ['area', 'grouped'],
      ['area', 'ranked'],
    ])('rejects the illegal combination %s:%s', async (chartType, chartVariant) => {
      const req = { body: { name: 'Combo', categoryIds: [1], chartType, chartVariant } };

      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
      expect(savedChartsRepository.create).not.toHaveBeenCalled();
    });

    it('rejects a variant that is illegal against the DEFAULT line chartType', async () => {
      // No chartType in the body: the default 'line' must still participate in
      // the combination rule, so a bare stacked variant is rejected.
      const req = { body: { name: 'Combo', categoryIds: [1], chartVariant: 'stacked' } };

      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it.each([
      ['bar', 'stacked'],
      ['bar', 'grouped'],
      ['area', 'stacked'],
    ])('accepts the legal combination %s:%s', async (chartType, chartVariant) => {
      savedChartsRepository.create.mockResolvedValue({ id: 13 });

      const req = { body: { name: 'Combo', categoryIds: [1], chartType, chartVariant } };
      await routeHandlers['post:/'](req, mockResponse());

      expect(savedChartsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ chartType, chartVariant }),
      );
    });

    it('rejects an unparsable dateRangeStart', async () => {
      const req = { body: { name: 'Dated', categoryIds: [1], dateRangeStart: 'not-a-date' } };

      await expect(routeHandlers['post:/'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('passes a valid dateRangeStart through unchanged and maps empty string to null', async () => {
      savedChartsRepository.create.mockResolvedValue({ id: 14 });

      const req = { body: { name: 'Dated', categoryIds: [1], dateRangeStart: '2025-01-01', dateRangeEnd: '' } };
      await routeHandlers['post:/'](req, mockResponse());

      expect(savedChartsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ dateRangeStart: '2025-01-01', dateRangeEnd: null }),
      );
    });
  });

  describe('PATCH /:id', () => {
    it('throws ValidationError when id is not a number', async () => {
      const req = { params: { id: 'abc' }, body: {} };
      const res = mockResponse();

      await expect(routeHandlers['patch:/:id'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError when name is blank after trimming', async () => {
      const req = { params: { id: '1' }, body: { name: '   ' } };
      const res = mockResponse();

      await expect(routeHandlers['patch:/:id'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError when categoryIds is invalid', async () => {
      const req = { params: { id: '1' }, body: { categoryIds: [1, 'bad-id'] } };
      const res = mockResponse();

      await expect(routeHandlers['patch:/:id'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws NotFoundError when chart does not exist', async () => {
      savedChartsRepository.update.mockResolvedValue(null);

      const req = { params: { id: '9' }, body: { name: 'Updated' } };
      const res = mockResponse();

      await expect(routeHandlers['patch:/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('updates chart and normalizes categoryIds when provided', async () => {
      savedChartsRepository.update.mockResolvedValue({ id: 9, name: 'Updated' });

      const req = { params: { id: '9' }, body: { categoryIds: ['3', 4], chartType: 'bar' } };
      const res = mockResponse();

      await routeHandlers['patch:/:id'](req, res);

      expect(savedChartsRepository.update).toHaveBeenCalledWith(9, {
        name: undefined,
        chartType: 'bar',
        categoryIds: [3, 4],
      });
      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { id: 9, name: 'Updated' } });
    });

    it('normalizes tagIds when provided', async () => {
      savedChartsRepository.update.mockResolvedValue({ id: 9, name: 'Updated' });

      const req = { params: { id: '9' }, body: { tagIds: ['7', 8] } };
      const res = mockResponse();

      await routeHandlers['patch:/:id'](req, res);

      expect(savedChartsRepository.update).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ tagIds: [7, 8] }),
      );
    });

    it('throws ValidationError when tagIds is invalid', async () => {
      const req = { params: { id: '1' }, body: { tagIds: [1, 'bad-id'] } };
      const res = mockResponse();

      await expect(routeHandlers['patch:/:id'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('updates all-source flags when provided', async () => {
      savedChartsRepository.update.mockResolvedValue({ id: 9 });

      const req = { params: { id: '9' }, body: { allRecipients: true } };
      const res = mockResponse();
      await routeHandlers['patch:/:id'](req, res);

      expect(savedChartsRepository.update).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ allRecipients: true }),
      );
    });

    it('throws ValidationError when an all-source flag is not a boolean', async () => {
      const req = { params: { id: '1' }, body: { allCategories: 1 } };
      const res = mockResponse();

      await expect(routeHandlers['patch:/:id'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('trims the name before updating', async () => {
      savedChartsRepository.update.mockResolvedValue({ id: 9 });

      const req = { params: { id: '9' }, body: { name: '  Renamed  ' } };
      await routeHandlers['patch:/:id'](req, mockResponse());

      expect(savedChartsRepository.update).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ name: 'Renamed' }),
      );
    });

    it('rejects a non-string name', async () => {
      const req = { params: { id: '1' }, body: { name: 42 } };

      await expect(routeHandlers['patch:/:id'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects an unknown chartVariant', async () => {
      const req = { params: { id: '1' }, body: { chartVariant: 'wavy' } };

      await expect(routeHandlers['patch:/:id'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects an unknown timeBucket', async () => {
      const req = { params: { id: '1' }, body: { timeBucket: 'daily' } };

      await expect(routeHandlers['patch:/:id'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects an illegal chartType/chartVariant pair when both are provided', async () => {
      const req = { params: { id: '1' }, body: { chartType: 'line', chartVariant: 'stacked' } };

      await expect(routeHandlers['patch:/:id'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
      expect(savedChartsRepository.update).not.toHaveBeenCalled();
    });

    it('allows chartType alone without cross-checking the stored variant', async () => {
      // The combination rule only fires when BOTH fields are in the PATCH body —
      // a lone chartType change never consults the persisted variant.
      savedChartsRepository.update.mockResolvedValue({ id: 9 });

      const req = { params: { id: '9' }, body: { chartType: 'line' } };
      await routeHandlers['patch:/:id'](req, mockResponse());

      expect(savedChartsRepository.update).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ chartType: 'line' }),
      );
    });

    it('allows chartVariant alone without cross-checking the stored type', async () => {
      savedChartsRepository.update.mockResolvedValue({ id: 9 });

      const req = { params: { id: '9' }, body: { chartVariant: 'ranked' } };
      await routeHandlers['patch:/:id'](req, mockResponse());

      expect(savedChartsRepository.update).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ chartVariant: 'ranked' }),
      );
    });

    it('rejects an unparsable dateRangeEnd', async () => {
      const req = { params: { id: '1' }, body: { dateRangeEnd: 'yesterdayish' } };

      await expect(routeHandlers['patch:/:id'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('maps an empty-string date to null (clear) on update', async () => {
      savedChartsRepository.update.mockResolvedValue({ id: 9 });

      const req = { params: { id: '9' }, body: { dateRangeEnd: '' } };
      await routeHandlers['patch:/:id'](req, mockResponse());

      expect(savedChartsRepository.update).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ dateRangeEnd: null }),
      );
    });

    it('rejects a zero chart id', async () => {
      const req = { params: { id: '0' }, body: { name: 'x' } };

      await expect(routeHandlers['patch:/:id'](req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
    });

    it('passes null through to CLEAR a date range (was silently coerced to undefined)', async () => {
      savedChartsRepository.update.mockResolvedValue({ id: 9 });

      const req = { params: { id: '9' }, body: { dateRangeStart: null } };
      const res = mockResponse();
      await routeHandlers['patch:/:id'](req, res);

      expect(savedChartsRepository.update).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ dateRangeStart: null }),
      );
    });
  });

  describe('DELETE /:id', () => {
    it('throws ValidationError for invalid chart id', async () => {
      const req = { params: { id: 'bad' } };
      const res = mockResponse();

      await expect(routeHandlers['delete:/:id'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws ValidationError for a negative chart id (was accepted as -5)', async () => {
      const req = { params: { id: '-5' } };
      const res = mockResponse();

      await expect(routeHandlers['delete:/:id'](req, res)).rejects.toBeInstanceOf(ValidationError);
      expect(savedChartsRepository.delete).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when delete misses', async () => {
      savedChartsRepository.delete.mockResolvedValue(false);

      const req = { params: { id: '8' } };
      const res = mockResponse();

      await expect(routeHandlers['delete:/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('returns 204 when delete succeeds', async () => {
      savedChartsRepository.delete.mockResolvedValue(true);

      const req = { params: { id: '8' } };
      const res = mockResponse();

      await routeHandlers['delete:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });
  });
});

function mockResponse() {
  return createMockResponse();
}
