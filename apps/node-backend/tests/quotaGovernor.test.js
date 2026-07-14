import { describe, it, expect } from 'vitest';
import { createQuotaGovernor } from '../src/services/research/quotaGovernor.js';

describe('createQuotaGovernor — dayMirror eviction', () => {
  it('drops stale-day mirror entries when the clock crosses a UTC day boundary', async () => {
    let now = Date.parse('2026-01-01T12:00:00Z');
    const gov = createQuotaGovernor({
      limits: { fmp: { perDay: 250 } },
      now: () => now,
    });

    await gov.spend('fmp');
    expect(gov.snapshot().day['fmp:2026-01-01']).toBe(1);

    // Advance two days; the next spend must evict the 2026-01-01 entry.
    now = Date.parse('2026-01-03T12:00:00Z');
    await gov.spend('fmp');

    const { day } = gov.snapshot();
    expect(day['fmp:2026-01-03']).toBe(1);
    expect(day['fmp:2026-01-01']).toBeUndefined();
    expect(Object.keys(day)).toHaveLength(1);
  });

  it('stays bounded across many days instead of leaking one entry per day', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z');
    const gov = createQuotaGovernor({ limits: { fmp: { perDay: 250 } }, now: () => now });

    for (let i = 0; i < 30; i += 1) {
      await gov.canSpend('fmp');
      await gov.spend('fmp');
      now += 24 * 60 * 60 * 1000;
    }

    // At most today's single entry remains, not 30 accumulated days.
    expect(Object.keys(gov.snapshot().day).length).toBeLessThanOrEqual(1);
  });
});
