import { describe, expect, it, vi } from "vitest";
import { mockConnection } from "../helpers/repoMocks.js";
import { mockLogger } from "../helpers/mockLogger.js";
import { routeAgent } from "../helpers/routeApp.js";

vi.mock("../../src/services/portfolioImportPipeline/index.ts", () => ({
  runPortfolioImportPipeline: vi.fn(),
}));
vi.mock("../../src/services/portfolioImportCommitService.ts", () => ({
  commitReviewedPortfolioImport: vi.fn(),
  commitReviewedPortfolioImports: vi.fn(),
}));
vi.mock("../../src/services/portfolioImportReconciliationService.ts", () => ({
  previewPortfolioImportReconciliation: vi.fn(),
}));
vi.mock("../../src/services/portfolioImportBatchService.ts", () => ({
  listBatches: vi.fn(),
  getBatch: vi.fn(),
  getPortfolioImportBatchPreview: vi.fn(),
  overrideInvestment: vi.fn(),
  createInvestmentForRow: vi.fn(),
  resolveInvestmentRows: vi.fn(),
  rollbackBatch: vi.fn(),
}));
vi.mock("../../src/services/accountService.ts", () => ({
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
import router from "../../src/routes/portfolioImportRoutes.ts";

const api = routeAgent(router, { mountPath: "/api/portfolio/import" });
const endpoint = "/api/portfolio/import/reconciliation/reference";

describe("Removed Portfolio Performance XML upload", () => {
  it("does not expose the former reference endpoint", async () => {
    await api
      .post(endpoint)
      .send({ batch_ids: [4], placeholder_basis_policy: "zero" })
      .expect(404);
  });

  it("does not accept an XML multipart upload", async () => {
    await api
      .post(endpoint)
      .field("batch_ids", "[4]")
      .attach("file", Buffer.from("<client><version>1</version></client>"), {
        filename: "reference.xml",
        contentType: "application/xml",
      })
      .expect(404);
  });
});
