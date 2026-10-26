import { must } from "./helpers/must.ts";
import { describe, expect, it, vi } from 'vitest';
import { wrapResponse } from '../src/middleware/envelope.ts';
import type { ExpressRequest, ExpressResponse } from '../src/types/express.ts';
import { partial } from './helpers/partial.ts';

describe('wrapResponse', () => {
  it('keeps route-specific metadata beside the generated requestId', () => {
    const json = vi.fn<ExpressResponse["json"]>(() => res);
    const req = partial<ExpressRequest>({ id: 'req-123' });
    const res: ExpressResponse = partial<ExpressResponse>({ json });
    const next = vi.fn();

    wrapResponse(req, res, next);
    must(res.ok, "res.ok")({ items: [] }, { provider: 'yahoo', source: 'live' });

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
