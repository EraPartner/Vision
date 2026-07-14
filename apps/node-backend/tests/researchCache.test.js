import { describe, it, expect, vi, afterEach } from 'vitest';
import { createResearchCache } from '../src/services/research/researchCache.js';

describe('createResearchCache — per-instance self-sweep', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a factory instance sweeps its own expired entries on the 5-min timer', () => {
    // Fake timers must be installed before the factory so its setInterval and the
    // default Date.now()-based clock advance together.
    vi.useFakeTimers();
    const cache = createResearchCache();

    cache.set('k', 'v', 1000); // expires 1s from now
    expect(cache.size()).toBe(1);

    // Cross the 5-minute sweep interval: the entry is now expired and swept.
    vi.advanceTimersByTime(5 * 60_000);
    expect(cache.size()).toBe(0);
  });

  it('keeps live entries and only evicts expired ones on sweep', () => {
    vi.useFakeTimers();
    const cache = createResearchCache();

    cache.set('short', 'v', 1000); // expires before the sweep
    cache.set('long', 'v', 60 * 60_000); // still live at sweep time
    expect(cache.size()).toBe(2);

    vi.advanceTimersByTime(5 * 60_000);
    expect(cache.size()).toBe(1);
    expect(cache.get('long')).toBe('v');
  });
});
