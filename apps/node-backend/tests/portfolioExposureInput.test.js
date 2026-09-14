import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  listExposureTargets: vi.fn(),
  upsertExposureBundle: vi.fn(),
}));

vi.mock("../src/repositories/portfolioExposureRepository.js", () => repository);
vi.mock("../src/services/portfolio/portfolioSummaryService.js", () => ({
  getPortfolioSummary: vi.fn(),
}));

const { upsertPortfolioExposureBundle } =
  await import("../src/services/portfolio/portfolioExposureService.js");

const fundDocument = {
  contractVersion: 1,
  fund: {
    name: "Demo fund",
    identifiers: [{ type: "proprietary", value: "demo-fund" }],
  },
  shareClass: {
    name: "Demo EUR",
    identifiers: [{ type: "isin", value: "IE00B4L5Y983" }],
    currency: "EUR",
  },
  source: {
    kind: "user-supplied-file",
    fileName: "demo.csv",
    asOfDate: "2026-09-01",
    retrievedAt: "2026-09-02T00:00:00Z",
    license: { status: "user-provided", redistribution: "forbidden" },
  },
  holdings: [
    {
      provenance: { rowNumber: 2 },
      name: "Cash",
      identifiers: [],
      instrumentType: "cash",
      exposureKind: "cash",
      exposureStatus: "supported",
      weightPercent: "100",
      currency: "EUR",
    },
  ],
  coverage: {
    status: "complete",
    reportedWeightPercent: "100",
    supportedWeightPercent: "100",
    unsupportedWeightPercent: "0",
    missingWeightPercent: "0",
  },
  staleness: {
    evaluatedAt: "2026-09-14",
    maximumAgeDays: 30,
    ageDays: 13,
    status: "current",
  },
};

const bundle = {
  classifications: [],
  fundDocuments: [
    {
      investmentId: 7,
      shareClassIdentifier: { type: "isin", value: "IE00B4L5Y983" },
      document: fundDocument,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.listExposureTargets.mockResolvedValue([
    { id: 7, assetClass: "etf" },
  ]);
  repository.upsertExposureBundle.mockResolvedValue({
    classifications: [],
    documents: [],
  });
});

describe("portfolio exposure source input", () => {
  it("accepts an exact share-class match for an existing ETF", async () => {
    await upsertPortfolioExposureBundle(bundle);
    expect(repository.listExposureTargets).toHaveBeenCalledWith([7]);
    expect(repository.upsertExposureBundle).toHaveBeenCalledOnce();
  });

  it("rejects missing investments and non-ETF fund attachments", async () => {
    repository.listExposureTargets.mockResolvedValueOnce([]);
    await expect(upsertPortfolioExposureBundle(bundle)).rejects.toMatchObject({
      code: "INVALID_PORTFOLIO_EXPOSURE_SOURCE",
    });

    repository.listExposureTargets.mockResolvedValueOnce([
      { id: 7, assetClass: "stock" },
    ]);
    await expect(upsertPortfolioExposureBundle(bundle)).rejects.toThrow(
      /only ETF investments/,
    );
  });

  it("rejects exchange qualifiers on non-ticker identifiers", async () => {
    const invalid = structuredClone(bundle);
    invalid.fundDocuments[0].shareClassIdentifier.exchange = "XAMS";
    await expect(upsertPortfolioExposureBundle(invalid)).rejects.toThrow(
      /invalid/,
    );
    expect(repository.listExposureTargets).not.toHaveBeenCalled();
  });
});
