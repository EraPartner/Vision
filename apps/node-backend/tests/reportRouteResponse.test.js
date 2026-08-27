import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/reports/index.js', () => ({
  generateReport: vi.fn(),
}));

import { generateReport } from '../src/services/reports/index.js';
import reportsRouter from '../src/routes/reports.js';

/** Find one Express route handler without binding a network listener. */
function routeHandler(path) {
  const layer = reportsRouter.stack.find((candidate) => candidate.route?.path === path);
  if (!layer) throw new Error(`Missing report route: ${path}`);
  return layer.route.stack.at(-1).handle;
}

describe('report route response', () => {
  it('owns the PDF download headers and sends the raw service buffer', async () => {
    const pdf = Buffer.from('pdf-bytes');
    generateReport.mockResolvedValue({ pdf, filename: 'vision-financial-2026-08-26.pdf' });
    const res = {
      setHeader: vi.fn(),
      end: vi.fn(),
    };

    await routeHandler('/financial')({ body: {} }, res);

    expect(generateReport).toHaveBeenCalledWith(expect.objectContaining({
      type: 'financial',
      currency: 'EUR',
    }));
    expect(generateReport.mock.calls[0][0]).not.toHaveProperty('res');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="vision-financial-2026-08-26.pdf"',
    );
    expect(res.setHeader).toHaveBeenCalledWith('Content-Length', pdf.length);
    expect(res.end).toHaveBeenCalledWith(pdf);
  });
});
