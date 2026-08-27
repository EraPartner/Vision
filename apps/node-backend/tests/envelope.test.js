import { describe, expect, it, vi } from 'vitest';
import { wrapResponse } from '../src/middleware/envelope.js';

describe('wrapResponse', () => {
  it('keeps route-specific metadata beside the generated requestId', () => {
    const json = vi.fn((body) => body);
    const req = { id: 'req-123' };
    const res = { json };
    const next = vi.fn();

    wrapResponse(req, res, next);
    res.ok({ items: [] }, { provider: 'yahoo', source: 'live' });

    expect(next).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledWith({
      ok: true,
      data: { items: [] },
      meta: {
        requestId: 'req-123',
        provider: 'yahoo',
        source: 'live',
      },
    });
  });
});
