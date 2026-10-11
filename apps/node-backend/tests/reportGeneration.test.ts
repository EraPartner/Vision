import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/reports/puppeteerRenderer.ts', () => ({
  renderHtmlToPdf: vi.fn(),
}));

vi.mock('../src/services/reports/dataFetcher.ts', () => ({
  fetchFinancialData: vi.fn().mockResolvedValue({}),
}));

import { renderHtmlToPdf as rawRenderHtmlToPdf } from '../src/services/reports/puppeteerRenderer.ts';
import { generateReport } from '../src/services/reports/index.ts';

const renderHtmlToPdf = vi.mocked(rawRenderHtmlToPdf);

describe('generateReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the rendered PDF and filename without requiring an HTTP response', async () => {
    const pdf = Buffer.from('pdf');
    renderHtmlToPdf.mockResolvedValue(pdf);

    const result = await generateReport({
      type: 'financial',
      currency: 'EUR',
      period: { kind: 'year', year: 2026 },
      sections: ['not-a-section'],
      theme: { mode: 'light' },
    });

    expect(result.pdf).toBe(pdf);
    expect(result.filename).toBe('vision-financial-2026-08-26.pdf');
    expect(renderHtmlToPdf).toHaveBeenCalledOnce();
  });

  it('ignores section ids that only exist on Object.prototype', async () => {
    renderHtmlToPdf.mockResolvedValue(Buffer.from('pdf'));

    await generateReport({
      type: 'financial',
      currency: 'EUR',
      period: { kind: 'year', year: 2026 },
      sections: ['constructor', 'toString', '__proto__'],
      theme: { mode: 'light' },
    });

    const html = renderHtmlToPdf.mock.calls[0]?.[0];
    expect(html).toContain('No sections selected');
    expect(html).not.toContain('[object Object]');
  });
});
