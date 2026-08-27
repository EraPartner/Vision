import { beforeEach, describe, expect, it, vi } from 'vitest';

const recipientPivotSpy = vi.fn(async () => ({ data: {}, meta: {} }));
const tagPivotSpy = vi.fn(async () => ({ data: {}, meta: {} }));

vi.mock('../../src/services/calculations/aggregation/recipientPivot.js', () => ({
  computeRecipientPivot: (...args) => recipientPivotSpy(...args),
}));
vi.mock('../../src/services/calculations/aggregation/tagPivot.js', () => ({
  computeTagPivot: (...args) => tagPivotSpy(...args),
}));

const { default: aggregationsRouter } = await import('../../src/routes/aggregations.js');

function getHandler(path) {
  const layer = aggregationsRouter.stack.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods.get,
  );
  return layer.route.stack.at(-1).handle;
}

const routes = [
  ['/recipient-pivot', recipientPivotSpy],
  ['/tag-pivot', tagPivotSpy],
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(routes)('GET %s date-range query params', (path, computeSpy) => {
  const handler = getHandler(path);

  async function invoke(query) {
    const response = { ok: vi.fn() };
    await handler({ query }, response);
    return response;
  }

  it('accepts and forwards the canonical start_date/end_date pair', async () => {
    await invoke({ start_date: '2025-01-01', end_date: '2025-12-31' });
    expect(computeSpy.mock.calls[0][0]).toMatchObject({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
    });
  });

  it('keeps the legacy start/end aliases backward compatible', async () => {
    await invoke({ start: '2024-01-01', end: '2024-12-31' });
    expect(computeSpy.mock.calls[0][0]).toMatchObject({
      startDate: '2024-01-01',
      endDate: '2024-12-31',
    });
  });

  it('gives the canonical spelling precedence when both are present', async () => {
    await invoke({
      start_date: '2025-02-03',
      start: '2020-01-01',
      end_date: '2025-04-05',
      end: '2020-12-31',
    });
    expect(computeSpy.mock.calls[0][0]).toMatchObject({
      startDate: '2025-02-03',
      endDate: '2025-04-05',
    });
  });

  it('treats an explicitly empty canonical value as authoritative over a legacy bound', async () => {
    await invoke({
      start_date: '',
      start: '2020-01-01',
      end_date: '',
      end: '2020-12-31',
    });
    expect(computeSpy.mock.calls[0][0]).toMatchObject({
      startDate: null,
      endDate: null,
    });
  });

  it.each([
    { start_date: '2025-02-30x' },
    { end_date: 'not-a-date' },
    { start: '2025/01/01' },
  ])('rejects malformed dates before computing the pivot (%j)', async (query) => {
    await expect(invoke(query)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(computeSpy).not.toHaveBeenCalled();
  });
});
