import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "../helpers/repoMocks.js";
import { mockLogger } from "../helpers/mockLogger.js";
import { routeAgent } from "../helpers/routeApp.js";
import {
  writeSyntheticWorkbook,
  syntheticSaxoWorkbook,
} from "../helpers/saxoWorkbook.js";

vi.mock("../../src/services/portfolioImportPipeline/index.js", () => ({
  runPortfolioImportPipeline: vi.fn(),
}));
vi.mock("../../src/services/portfolioImportCommitService.js", () => ({
  commitReviewedPortfolioImport: vi.fn(),
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
vi.mock("../../src/repositories/customParserConfigRepository.js", () => ({
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

import { runPortfolioImportPipeline } from "../../src/services/portfolioImportPipeline/index.js";
import accountService from "../../src/services/accountService.js";
import router from "../../src/routes/portfolioImportRoutes.js";
const BASE = "/api/portfolio/import";
const api = routeAgent(router, { mountPath: BASE });
const MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
let directory;
let file;
beforeEach(async () => {
  vi.clearAllMocks();
  accountService.get.mockResolvedValue({
    id: 7,
    type: "brokerage",
    is_active: true,
  });
  runPortfolioImportPipeline.mockResolvedValue({
    batchId: 12,
    total: 4,
    skipped: 0,
    requiresReview: true,
    matchSourceCounts: { symbol: 2 },
  });
  directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "vision-workbook-upload-test-"),
  );
  file = path.join(directory, "fixture.xlsx");
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});
function request(
  endpoint = "/csv/custom",
  format = "saxo_transaction_history",
) {
  const req = api
    .post(`${BASE}${endpoint}`)
    .field("date_column", "Transactiedatum")
    .field("symbol_column", "Instrumentsymbool")
    .field("default_asset_class", "stock")
    .field("is_brokerage", "true")
    .field("account_id", "7");
  if (format) req.field("portfolio_format", format);
  return req.attach("file", file, {
    filename: "history.xlsx",
    contentType: MIME,
  });
}

describe("portfolio workbook multipart boundary", () => {
  it("accepts a complete Saxo workbook and passes its original filename to the pipeline", async () => {
    await writeSyntheticWorkbook(file);
    await request().expect(202);
    expect(runPortfolioImportPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "history.xlsx",
        customConfig: expect.objectContaining({
          format: "saxo_transaction_history",
        }),
        accountId: 7,
      }),
    );
  });
  it.each(["/csv/custom", "/csv/stream"])(
    "rejects an unsupported workbook before %s stages a batch or starts SSE",
    async (endpoint) => {
      await writeSyntheticWorkbook(file, [
        { sheet: "Other", headers: ["Name"], records: [{ Name: "Example" }] },
      ]);
      const response = await request(endpoint).expect(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.headers["content-type"]).toContain("application/json");
      expect(runPortfolioImportPipeline).not.toHaveBeenCalled();
    },
  );
  it("rejects incomplete financial joins before creating a batch", async () => {
    const sheets = syntheticSaxoWorkbook();
    sheets[2].records.shift();
    await writeSyntheticWorkbook(file, sheets);
    const response = await request().expect(400);
    expect(response.body.error.message).toContain("do not reconcile");
    expect(runPortfolioImportPipeline).not.toHaveBeenCalled();
  });
  it("rejects workbook with an unrelated selected parser and rejects legacy Excel uploads", async () => {
    await writeSyntheticWorkbook(file);
    await request("/csv/custom", "nexo_transaction_history").expect(400);
    expect(runPortfolioImportPipeline).not.toHaveBeenCalled();
    const rejected = await api
      .post(`${BASE}/csv/custom`)
      .attach("file", file, {
        filename: "history.xls",
        contentType: "application/vnd.ms-excel",
      })
      .expect(400);
    expect(rejected.body.error.message).toContain("CSV or XLSX");
  });
});
