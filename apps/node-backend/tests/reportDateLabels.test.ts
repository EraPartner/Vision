import { afterEach, describe, expect, it, vi } from 'vitest';

// A zone west of UTC, where a 'YYYY-MM-DD' string read as UTC midnight falls
// on the previous calendar day.
vi.mock('../src/lib/timezone.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  APP_TIMEZONE: 'America/New_York',
}));

vi.mock('../src/services/reports/puppeteerRenderer.ts', () => ({
  renderHtmlToPdf: vi.fn(),
}));

import { renderHtmlToPdf as rawRenderHtmlToPdf } from '../src/services/reports/puppeteerRenderer.ts';
import { generateReport } from '../src/services/reports/index.ts';
import { fmtDate } from '../src/services/reports/sectionHelpers.ts';

const renderHtmlToPdf = vi.mocked(rawRenderHtmlToPdf);

describe('report date labels west of UTC', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('labels a custom period with its own calendar dates', async () => {
    renderHtmlToPdf.mockResolvedValue(Buffer.from('pdf'));

    await generateReport({
      type: 'financial',
      currency: 'EUR',
      period: { kind: 'custom', from: '2025-01-01', to: '2025-03-31' },
      sections: ['not-a-section'],
      theme: { mode: 'light' },
    });

    const html = renderHtmlToPdf.mock.calls[0]![0];
    expect(html).toContain('Jan 1, 2025 – Mar 31, 2025');
  });

  it('formats a date-only string as that calendar day on a host west of UTC', () => {
    process.env.TZ = 'America/New_York';
    expect(fmtDate('2026-11-01')).toBe('1 Nov 2026');
    expect(fmtDate(new Date(2026, 10, 1))).toBe('1 Nov 2026');
  });
});
