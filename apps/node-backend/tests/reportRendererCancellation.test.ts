import { afterEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  pdf: vi.fn(),
  closePage: vi.fn(),
  setContent: vi.fn(),
  newPage: vi.fn(),
  closeBrowser: vi.fn(),
}));
vi.mock("puppeteer", () => ({
  default: {
    launch: vi.fn(async () => ({
      connected: true,
      newPage: fake.newPage,
      close: fake.closeBrowser,
    })),
  },
}));
import {
  renderHtmlToPdf,
  closeBrowser,
} from "../src/services/reports/puppeteerRenderer.ts";
import { withReportSlot } from "../src/services/reports/reportConcurrency.ts";
afterEach(async () => {
  await closeBrowser();
  vi.clearAllMocks();
});
it("closes an actively rendering page on abort and retains report capacity until rendering settles", async () => {
  let rejectPdf!: (error: Error) => void;
  let pdfStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    pdfStarted = resolve;
  });
  fake.pdf.mockImplementation(() => {
    pdfStarted();
    return new Promise((_resolve, reject) => {
      rejectPdf = reject;
    });
  });
  fake.closePage.mockResolvedValue(undefined);
  fake.setContent.mockResolvedValue(undefined);
  fake.newPage.mockResolvedValue({
    pdf: fake.pdf,
    close: fake.closePage,
    setContent: fake.setContent,
  });
  const controller = new AbortController();
  let finished = false;
  const operation = withReportSlot(
    () => renderHtmlToPdf("<html/>", { signal: controller.signal }),
    controller.signal,
  );
  const result = operation.finally(() => {
    finished = true;
  });
  const rejection = expect(result).rejects.toMatchObject({
    name: "AbortError",
  });
  await started;
  controller.abort();
  await Promise.resolve();
  expect(fake.closePage).toHaveBeenCalledOnce();
  expect(finished).toBe(false);
  let releaseOther!: () => void;
  const other = withReportSlot(
    () =>
      new Promise<void>((resolve) => {
        releaseOther = resolve;
      }),
  );
  let queuedStarted = false;
  const queued = withReportSlot(async () => {
    queuedStarted = true;
  });
  await Promise.resolve();
  expect(queuedStarted).toBe(false);
  rejectPdf(new Error("Target closed"));
  await rejection;
  await queued;
  releaseOther();
  await other;
  expect(fake.closePage).toHaveBeenCalledOnce();
});
