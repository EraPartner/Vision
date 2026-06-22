/**
 * @vitest-environment jsdom
 *
 * Report download helpers POST a body assembled from theme tokens + period +
 * section flags, then stream a binary PDF to downloadBlob. We assert the
 * request body assembly (defaults + optional fields) and the failure path.
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
vi.mock("@/lib/timezone", () => ({ todayYmd: () => "2026-06-22" }));

import { downloadBlob } from "@/lib/downloadBlob";

function mockFetchOk() {
  const blob = new Blob(["%PDF-1.4"], { type: "application/pdf" });
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    blob: () => Promise.resolve(blob),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("report download helpers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("downloadFinancialReport posts to the financial route with default body", async () => {
    const fetchMock = mockFetchOk();

    await downloadFinancialReport();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/reports/financial");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.currency).toBe("EUR");
    expect(body.period).toEqual({ kind: "rolling", months: 12 });
    expect(body.sections).toEqual([]);
    expect(body.theme).toEqual({ resolved: true });
    expect(body.excludedCategoryIds).toEqual([]);
    expect(body.excludedRecipientIds).toEqual([]);
    // Optional fields are omitted when absent.
    expect("taxProfile" in body).toBe(false);
    expect("precomputedPIT" in body).toBe(false);
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "vision-financial-2026-06-22.pdf");
  });

  it("downloadPortfolioReport forwards overrides and includes optional fields", async () => {
    const fetchMock = mockFetchOk();

    await downloadPortfolioReport({
      currency: "USD",
      period: { kind: "year", year: 2025 },
      sections: ["holdings"],
      theme: { custom: 1 } as never,
      excludedCategoryIds: [1],
      excludedRecipientIds: [2],
      taxProfile: { region: "BE" },
      precomputedPIT: { totalTax: 100 },
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/reports/portfolio");
    const body = JSON.parse(init.body as string);
    expect(body.currency).toBe("USD");
    expect(body.period).toEqual({ kind: "year", year: 2025 });
    expect(body.sections).toEqual(["holdings"]);
    expect(body.theme).toEqual({ custom: 1 });
    expect(body.excludedCategoryIds).toEqual([1]);
    expect(body.taxProfile).toEqual({ region: "BE" });
    expect(body.precomputedPIT).toEqual({ totalTax: 100 });
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "vision-portfolio-2026-06-22.pdf");
  });

  it("downloadTaxReport names the file with the tax type", async () => {
    mockFetchOk();
    await downloadTaxReport();
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "vision-tax-2026-06-22.pdf");
  });

  it("throws a descriptive error on a non-ok response and does not download", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Server Error" }),
    );

    await expect(downloadFinancialReport()).rejects.toThrow(/Report download failed: 500 Server Error/);
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
