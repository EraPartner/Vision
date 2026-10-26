import { must } from "./helpers/must.ts";
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
  return must(must(layer.route, "layer.route").stack.at(-1), "layer.route.stack.at(-1)").handle as unknown as DirectHandler;
}

function responseStub() {
  return {
    writableEnded: false,
    once: vi.fn(),
    removeListener: vi.fn(),
    ok: vi.fn(),
    setHeader: vi.fn(),
    end: vi.fn(),
  };
}

describe('report route response', () => {
  it('sends the print-ready document in the success envelope', async () => {
    const document = {
      filename: 'vision-financial-2026-08-26.pdf',
      html: '<!DOCTYPE html><html></html>',
      footerTemplate: '<div></div>',
    };
    generateReport.mockResolvedValue(document);
    const res = responseStub();

    await routeHandler('/financial')({ body: {} }, res);

    expect(generateReport).toHaveBeenCalledWith(expect.objectContaining({
      type: 'financial',
      currency: 'EUR',
    }));
    expect(must(generateReport.mock.calls[0], "generateReport.mock.calls[0]")[0]).not.toHaveProperty('res');
    expect(res.ok).toHaveBeenCalledWith(document);
    expect(res.end).not.toHaveBeenCalled();
  });
});


it('does not send a document or forward an error after the requesting client disconnects', async () => {
  let close!: () => void;
  const res = { ...responseStub(), once: vi.fn((_event: string, callback: () => void) => { close = callback; }) };
  generateReport.mockImplementationOnce((options) => {
    close();
    expect(options.signal?.aborted).toBe(true);
    return Promise.reject(new Error('Cancelled while fetching report data'));
  });
  await expect(routeHandler('/financial')({ body: {} }, res)).resolves.toBeUndefined();
  expect(res.ok).not.toHaveBeenCalled();
  expect(res.end).not.toHaveBeenCalled();
  expect(res.removeListener).toHaveBeenCalledWith('close', close);
});
