import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "../helpers/repoMocks.js";
import { mockLogger } from "../helpers/mockLogger.js";
import { routeAgent } from "../helpers/routeApp.js";

vi.mock("../../src/services/portfolioImportReferenceService.js", () => ({
  applyPortfolioImportReference: vi.fn(),
}));
vi.mock("../../src/services/portfolioImportPipeline/index.js", () => ({
  runPortfolioImportPipeline: vi.fn(),
}));
vi.mock("../../src/services/portfolioImportCommitService.js", () => ({
  commitReviewedPortfolioImport: vi.fn(),
  commitReviewedPortfolioImports: vi.fn(),
}));
vi.mock("../../src/services/portfolioImportReconciliationService.js", () => ({
  previewPortfolioImportReconciliation: vi.fn(),
}));
vi.mock("../../src/services/portfolioImportBatchService.js", () => ({
  listBatches: vi.fn(),
  getBatch: vi.fn(),
  getPortfolioImportBatchPreview: vi.fn(),
  overrideInvestment: vi.fn(),
  createInvestmentForRow: vi.fn(),
  resolveInvestmentRows: vi.fn(),
  rollbackBatch: vi.fn(),
}));
vi.mock("../../src/services/accountService.js", () => ({
  default: { get: vi.fn() },
}));
vi.mock("../../src/repositories/customParserConfigRepository.ts", () => ({
  default: {
    getAll: vi.fn(),
    getById: vi.fn(),
    getByName: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("../../src/database/connection.ts", () => mockConnection());
vi.mock("../../src/config/logger.ts", () => ({ logger: mockLogger() }));
vi.mock("../../src/lib/csvUpload.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, cleanup: vi.fn(actual.cleanup) };
});

import { applyPortfolioImportReference } from "../../src/services/portfolioImportReferenceService.js";
import { commitReviewedPortfolioImports } from "../../src/services/portfolioImportCommitService.js";
import { cleanup } from "../../src/lib/csvUpload.ts";
import { ConflictError } from "../../src/middleware/errorHandler.ts";
import router from "../../src/routes/portfolioImportRoutes.js";

const api = routeAgent(router, { mountPath: "/api/portfolio/import" });
const endpoint = "/api/portfolio/import/reconciliation/reference";
const xml = Buffer.from(
  "<?xml version='1.0'?><client><version>1</version></client>",
);
function upload(
  fields = { batch_ids: "[4,7]", placeholder_basis_policy: "zero" },
  file = xml,
  filename = "reference.xml",
  mime = "application/xml",
) {
  let request = api.post(endpoint);
  for (const [key, value] of Object.entries(fields))
    request = request.field(key, value);
  return request.attach("file", file, { filename, contentType: mime });
}

beforeEach(() => {
  vi.clearAllMocks();
  applyPortfolioImportReference.mockResolvedValue({
    batch_ids: [4, 7, 9],
    matched_reference_rows: 2,
    source_corrections: 1,
    replacement_batches: [],
    supplemental_batches: [
      {
        batch_id: 9,
        account_id: 3,
        adapter_name: "portfolio_performance_reference",
        source_filename: "reference.xml",
        status: "awaiting_review",
        rows_total: 1,
      },
    ],
    blockers: [{ reason: "reference_asset_unmatched", rowOrdinal: 3 }],
  });
});

describe("Portfolio Performance reference multipart boundary", () => {
  it("stages the explicit reference scope and returns supplemental metadata and blockers without committing", async () => {
    const response = await upload().expect(200);
    expect(response.body.data.batch_ids).toEqual([4, 7, 9]);
    expect(response.body.data.supplemental_batches).toHaveLength(1);
    expect(response.body.data.blockers).toHaveLength(1);
    expect(applyPortfolioImportReference).toHaveBeenCalledWith({
      batchIds: [4, 7],
      referencePath: expect.any(String),
      placeholderBasisPolicy: "zero",
    });
    expect(cleanup).toHaveBeenCalledWith(
      applyPortfolioImportReference.mock.calls[0][0].referencePath,
    );
    expect(commitReviewedPortfolioImports).not.toHaveBeenCalled();
  });
  it.each([
    { batch_ids: "broken", placeholder_basis_policy: "zero" },
    { batch_ids: "[]", placeholder_basis_policy: "zero" },
    { batch_ids: '["4"]', placeholder_basis_policy: "zero" },
    { batch_ids: "[9007199254740992]", placeholder_basis_policy: "zero" },
    { batch_ids: "[4]" },
    { batch_ids: "[4]", placeholder_basis_policy: "guess" },
    { batch_ids: "[4]", placeholder_basis_policy: "zero", unexpected: "value" },
  ])(
    "rejects invalid scope or missing explicit basis policy and cleans uploaded files: %j",
    async (fields) => {
      await upload(fields).expect(400);
      expect(applyPortfolioImportReference).not.toHaveBeenCalled();
      // Excess multipart fields are rejected by multer before the handler.
      if (!fields.unexpected) expect(cleanup).toHaveBeenCalledOnce();
    },
  );
  it("requires a reference file", async () => {
    await api
      .post(endpoint)
      .field("batch_ids", "[4]")
      .field("placeholder_basis_policy", "zero")
      .expect(400);
    expect(applyPortfolioImportReference).not.toHaveBeenCalled();
  });
  it.each([
    ["reference.csv", "text/csv"],
    ["reference.xml", "application/zip"],
  ])("rejects other file types before staging: %s", async (filename, mime) => {
    await upload(undefined, xml, filename, mime).expect(400);
    expect(applyPortfolioImportReference).not.toHaveBeenCalled();
  });
  it("enforces the XML size boundary before staging", async () => {
    const response = await upload(
      undefined,
      Buffer.alloc(10 * 1024 * 1024 + 1, 32),
    ).expect(400);
    expect(response.body.error.message).toContain("10MB");
    expect(applyPortfolioImportReference).not.toHaveBeenCalled();
  });
  it("retains a stale-reference conflict and cleans the uploaded file", async () => {
    applyPortfolioImportReference.mockRejectedValue(
      new ConflictError("Reference changed; restage the selected files"),
    );
    await upload().expect(409);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(commitReviewedPortfolioImports).not.toHaveBeenCalled();
  });
});
