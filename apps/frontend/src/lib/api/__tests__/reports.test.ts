/**
 * @vitest-environment jsdom
 *
 * Report export helpers POST a body assembled from theme tokens + period +
 * section flags and receive a print-ready document (ADR-234). Inside Electron
 * the document is printed to PDF through the preload bridge and downloaded;
 * in a plain browser it opens the print dialog. We assert the request body
 * assembly (defaults + optional fields), both delivery paths and failures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadFinancialReport,
  downloadPortfolioReport,
  downloadTaxReport,
} from "@/lib/api/reports";

vi.mock("@/lib/downloadBlob", () => ({ downloadBlob: vi.fn() }));
vi.mock("@/lib/themeTokens", () => ({
  resolveActiveThemeTokens: () => ({ resolved: true }),
}));

import { downloadBlob } from "@/lib/downloadBlob";
import {
    asCategoryId,
    asCurrencyCode,
    asRecipientId,
} from "@vision/types/brands";
import { must } from "@/test/must";

const HTML = "<!DOCTYPE html><html><body>Report</body></html>";

function mockFetchOk(type = "financial") {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        ok: true,
        data: {
          filename: `vision-${type}-2026-06-22.pdf`,
          html: HTML,
          footerTemplate: "<div>footer</div>",
        },
      }),
  } as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function installPrinter(
  result: { success: boolean; pdf?: Uint8Array; error?: string } = {
    success: true,
    pdf: new Uint8Array([37, 80, 68, 70]),
  },
) {
  const printToPdf = vi.fn().mockResolvedValue(result);
  window.electronReports = { printToPdf };
  return printToPdf;
}

afterEach(() => {
  delete window.electronReports;
  document.querySelectorAll("iframe").forEach((frame) => frame.remove());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("report export helpers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("posts the default body and downloads the PDF Electron printed", async () => {
    const fetchMock = mockFetchOk();
    const printToPdf = installPrinter();

    await expect(downloadFinancialReport()).resolves.toBe("downloaded");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = must(fetchMock.mock.calls[0]);
    const init = must(requestInit);
    expect(url).toBe("/api/reports/financial");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.currency).toBe("EUR");
    expect(body.period).toEqual({ kind: "rolling", months: 12 });
    expect(body.sections).toEqual([]);
    expect(body.theme).toEqual({ resolved: true });
    expect(body.excludedCategoryIds).toEqual([]);
    expect(body.excludedRecipientIds).toEqual([]);
    // Optional fields are omitted when absent.
    expect("taxProfile" in body).toBe(false);
    expect("precomputedPIT" in body).toBe(false);
    expect(printToPdf).toHaveBeenCalledWith({
      html: HTML,
      footerTemplate: "<div>footer</div>",
    });
    const [blob, filename] = must(vi.mocked(downloadBlob).mock.calls[0]);
    expect(filename).toBe("vision-financial-2026-06-22.pdf");
    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBe(4);
  });

  it("downloadPortfolioReport forwards overrides and includes optional fields", async () => {
    const fetchMock = mockFetchOk("portfolio");
    installPrinter();

    await downloadPortfolioReport({
      currency: asCurrencyCode("USD"),
      period: { kind: "year", year: 2025 },
      sections: ["holdings"],
      theme: { custom: 1 } as never,
      excludedCategoryIds: [asCategoryId(1)],
      excludedRecipientIds: [asRecipientId(2)],
      taxProfile: { region: "BE" },
      precomputedPIT: { totalTax: 100 },
    });

    const [url, requestInit] = must(fetchMock.mock.calls[0]);
    const init = must(requestInit);
    expect(url).toBe("/api/reports/portfolio");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.currency).toBe("USD");
    expect(body.period).toEqual({ kind: "year", year: 2025 });
    expect(body.sections).toEqual(["holdings"]);
    expect(body.theme).toEqual({ custom: 1 });
    expect(body.excludedCategoryIds).toEqual([1]);
    expect(body.taxProfile).toEqual({ region: "BE" });
    expect(body.precomputedPIT).toEqual({ totalTax: 100 });
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "vision-portfolio-2026-06-22.pdf");
  });

  it("downloadTaxReport names the file with the server's filename", async () => {
    mockFetchOk("tax");
    installPrinter();
    await downloadTaxReport();
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "vision-tax-2026-06-22.pdf");
  });

  it("opens the browser print dialog on the document outside Electron", async () => {
    mockFetchOk();
    const print = vi.fn();
    const appendChild = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, "appendChild").mockImplementation((node) => {
      const appended = appendChild(node);
      if (node instanceof HTMLIFrameElement) {
        Object.defineProperty(must(node.contentWindow), "print", { value: print });
        Object.defineProperty(must(node.contentWindow), "focus", { value: vi.fn() });
        node.dispatchEvent(new Event("load"));
      }
      return appended;
    });

    await expect(downloadFinancialReport()).resolves.toBe("print-dialog");

    const frame = document.querySelector("iframe");
    expect(frame?.getAttribute("srcdoc")).toBe(HTML);
    expect(print).toHaveBeenCalledOnce();
    expect(downloadBlob).not.toHaveBeenCalled();
    frame?.contentWindow?.dispatchEvent(new Event("afterprint"));
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("throws when Electron cannot print and does not download", async () => {
    mockFetchOk();
    installPrinter({ success: false, error: "Report printing failed" });
    await expect(downloadFinancialReport()).rejects.toThrow("Report printing failed");
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("throws a descriptive error on a non-ok response and does not download", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Server Error" }),
    );
    installPrinter();

    await expect(downloadFinancialReport()).rejects.toThrow(/Report download failed: 500 Server Error/);
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
