import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/reports/dataFetcher.ts', () => ({
  fetchFinancialData: vi.fn().mockResolvedValue({}),
}));

import { generateReport } from '../src/services/reports/index.ts';

describe('generateReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a print-ready document, footer and PDF filename without requiring an HTTP response', async () => {
    const result = await generateReport({
      type: 'financial',
      currency: 'EUR',
      period: { kind: 'year', year: 2026 },
      sections: ['not-a-section'],
      theme: { mode: 'light', primary: '158 62% 32%' },
    });

    expect(result.filename).toBe('vision-financial-2026-08-26.pdf');
    expect(result.html).toMatch(/^<!DOCTYPE html>/);
    expect(result.html).toContain('Financial Report');
    // The document is printed with JavaScript disabled: it must not need any.
    expect(result.html).not.toMatch(/<script/i);
    expect(result.footerTemplate).toContain('class="pageNumber"');
    expect(result.footerTemplate).toContain('class="totalPages"');
    expect(result.footerTemplate).toContain('hsl(158 62% 32%)');
  });

  it('ignores section ids that only exist on Object.prototype', async () => {
    const { html } = await generateReport({
      type: 'financial',
      currency: 'EUR',
      period: { kind: 'year', year: 2026 },
      sections: ['constructor', 'toString', '__proto__'],
      theme: { mode: 'light' },
    });

    expect(html).toContain('No sections selected');
    expect(html).not.toContain('[object Object]');
  });
});
