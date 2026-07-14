import { describe, it, expect, vi, beforeEach } from 'vitest';

// yahoo-finance2 is imported lazily (deferred off the pre-listen boot graph) via
// a shared module-cached accessor. Assert it constructs on first use and caches.

const ctor = vi.fn(function MockYahoo() {});
vi.mock('yahoo-finance2', () => ({ default: ctor }));

import { getYahooClient, __resetYahooClientForTests } from '../src/services/prices/yahooClient.js';

beforeEach(() => {
  __resetYahooClientForTests();
  ctor.mockClear();
});

describe('getYahooClient', () => {
  it('lazily constructs a client and returns the same cached instance', async () => {
    const a = await getYahooClient();
    const b = await getYahooClient();
    expect(a).toBe(b);
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor).toHaveBeenCalledWith({ suppressNotices: ['yahooSurvey'] });
  });
});
