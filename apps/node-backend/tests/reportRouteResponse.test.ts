import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/reports/index.ts', () => ({
  generateReport: vi.fn(),
}));

import { generateReport as rawGenerateReport } from '../src/services/reports/index.ts';
import reportsRouter from '../src/routes/reports.ts';

const generateReport = vi.mocked(rawGenerateReport);

/** The route's terminal handler, invoked directly with hand-built req/res stubs. */
type DirectHandler = (req: unknown, res: unknown) => unknown;

/** Find one Express route handler without binding a network listener. */
function routeHandler(path: string): DirectHandler {
  const layer = reportsRouter.stack.find((candidate) => candidate.route?.path === path);
  if (!layer) throw new Error(`Missing report route: ${path}`);
  return layer.route!.stack.at(-1)!.handle as unknown as DirectHandler;
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
    expect(generateReport.mock.calls[0]![0]).not.toHaveProperty('res');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="vision-financial-2026-08-26.pdf"',
    );
    expect(res.setHeader).toHaveBeenCalledWith('Content-Length', pdf.length);
    expect(res.end).toHaveBeenCalledWith(pdf);
  });
});


it('does not send a PDF or forward an error after the requesting client disconnects', async () => {
  let close!: () => void;
  const res = { writableEnded: false, once: vi.fn((_event, callback) => { close = callback; }), removeListener: vi.fn(), setHeader: vi.fn(), end: vi.fn() };
  generateReport.mockImplementationOnce(async (options) => {
    close();
    expect(options.signal?.aborted).toBe(true);
    throw new Error('Page closed on cancellation');
  });
  await expect(routeHandler('/financial')({ body: {} }, res)).resolves.toBeUndefined();
  expect(res.end).not.toHaveBeenCalled();
  expect(res.setHeader).not.toHaveBeenCalled();
  expect(res.removeListener).toHaveBeenCalledWith('close', close);
});
