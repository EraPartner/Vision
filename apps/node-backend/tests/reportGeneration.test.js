import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/reports/puppeteerRenderer.js', () => ({
  renderHtmlToPdf: vi.fn(),
}));

import { renderHtmlToPdf } from '../src/services/reports/puppeteerRenderer.js';
import { generateReport } from '../src/services/reports/index.js';

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
});
