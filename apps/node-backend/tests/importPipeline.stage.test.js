import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockLogger } from "./helpers/mockLogger.js";

const clientQuery = vi.fn().mockResolvedValue({ rows: [] });

vi.mock("../src/database/connection.js", () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  withTransaction: vi.fn(async (cb) => cb({ query: clientQuery })),
}));

vi.mock("../src/config/logger.js", () => ({
  logger: mockLogger(),
}));

const getAdapter = vi.fn();
vi.mock("../src/services/importPipeline/adapters/index.js", () => ({
  getAdapter: (...args) => getAdapter(...args),
}));

const genericParseWithConfig = vi.fn().mockResolvedValue([]);
vi.mock("../src/services/importPipeline/adapters/generic.js", () => ({
  default: {
    name: "generic",
    parseWithConfig: (...args) => genericParseWithConfig(...args),
  },
}));

const portfolioParseWithConfig = vi.fn().mockResolvedValue([]);
vi.mock(
  "../src/services/portfolioImportPipeline/portfolioGenericAdapter.js",
  () => ({
    parseWithConfig: (...args) => portfolioParseWithConfig(...args),
  }),
);

import {
  stageBatch,
  createBatch,
} from "../src/services/importPipeline/stage.js";
import {
  createBatch as createPortfolioBatch,
  stageBatch as stagePortfolioBatch,
} from "../src/services/portfolioImportPipeline/stage.js";
import { query } from "../src/database/connection.js";

const CONFIG = { dateColumn: "D", recipientColumn: "R", amountColumn: "A" };

/**
 * The single boundary where a batch id enters the application. `import_batches.id`
 * is BIGSERIAL and node-postgres emits BIGINT as a STRING, so without this
 * normalization POST /api/import/csv answered `batch_id: "12"` while the
 * review-commit route (routes/importRoutes.js:570), which reads the id back off
 * the URL through `coercedIdSchema`, answered `batch_id: 12`.
 */
describe("createBatch normalizes the BIGSERIAL id to a number", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a NUMBER even though pg hands back a string", async () => {
    query.mockResolvedValue({ rows: [{ id: "12" }] });

    const id = await createBatch({ adapterName: "vision" });

    expect(id).toBe(12);
    expect(typeof id).toBe("number");
  });

  it("does the same in the portfolio pipeline, so both agree on the wire", async () => {
    query.mockResolvedValue({ rows: [{ id: "12" }] });

    const id = await createPortfolioBatch({ adapterName: "generic" });

    expect(id).toBe(12);
    expect(typeof id).toBe("number");
  });

  it("is exact for ids up to Number.MAX_SAFE_INTEGER (the documented ceiling)", async () => {
    query.mockResolvedValue({
      rows: [{ id: String(Number.MAX_SAFE_INTEGER) }],
    });

    expect(await createBatch({ adapterName: "vision" })).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});

describe("stageBatch adapter resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    genericParseWithConfig.mockResolvedValue([]);
    portfolioParseWithConfig.mockResolvedValue([]);
  });

  it("falls back to the generic adapter when a named custom adapter is not in the registry", async () => {
    getAdapter.mockReturnValue(null); // "My Bank" is not a registered adapter

    await stageBatch({
      batchId: 1,
      filePath: "/tmp/x.csv",
      adapterName: "My Bank",
      customConfig: CONFIG,
    });

    expect(genericParseWithConfig).toHaveBeenCalledWith("/tmp/x.csv", CONFIG);
  });

  it("uses a registered adapter's parseWithConfig when the name resolves", async () => {
    const adapterParseWithConfig = vi.fn().mockResolvedValue([]);
    getAdapter.mockReturnValue({
      name: "vision",
      parseWithConfig: adapterParseWithConfig,
      parse: vi.fn(),
    });

    await stageBatch({
      batchId: 2,
      filePath: "/tmp/y.csv",
      adapterName: "vision",
      customConfig: CONFIG,
    });

    expect(adapterParseWithConfig).toHaveBeenCalledWith("/tmp/y.csv", CONFIG);
    expect(genericParseWithConfig).not.toHaveBeenCalled();
  });

  it("throws for an unknown adapter when no customConfig is supplied", async () => {
    getAdapter.mockReturnValue(null);

    await expect(
      stageBatch({ batchId: 3, filePath: "/tmp/z.csv", adapterName: "Nope" }),
    ).rejects.toThrow(/Unknown adapter/);
  });

  it("shares zero-row and 500-row chunk progress across both stage pipelines", async () => {
    const bankRows = Array.from({ length: 501 }, (_, index) => ({
      date: new Date("2026-01-01T00:00:00Z"),
      amount: index + 1,
      currency: "EUR",
    }));
    bankRows.skipped = 2;
    getAdapter.mockReturnValue({ parse: vi.fn().mockResolvedValue(bankRows) });
    const bankProgress = [];

    const bankResult = await stageBatch({
      batchId: 3,
      filePath: "/tmp/bank.csv",
      adapterName: "vision",
      onProgress: (event) => bankProgress.push(event.current),
    });

    expect(bankResult).toEqual({ rowsTotal: 501, rowsSkipped: 2 });
    expect(bankProgress).toEqual([0, 500, 501]);
    expect(clientQuery).toHaveBeenCalledTimes(2);

    clientQuery.mockClear();
    const portfolioRows = Array.from({ length: 501 }, (_, index) => ({
      date: new Date("2026-01-01T00:00:00Z"),
      amount: index + 1,
      currency: "EUR",
    }));
    portfolioRows.skipped = 3;
    portfolioParseWithConfig.mockResolvedValue(portfolioRows);
    const portfolioProgress = [];

    const portfolioResult = await stagePortfolioBatch({
      batchId: 4,
      filePath: "/tmp/portfolio.csv",
      customConfig: CONFIG,
      onProgress: (event) => portfolioProgress.push(event.current),
    });

    expect(portfolioResult).toEqual({ rowsTotal: 501, rowsSkipped: 3 });
    expect(portfolioProgress).toEqual([0, 500, 501]);
    expect(clientQuery).toHaveBeenCalledTimes(2);
  });

  it("persists and reports the zero-row lifecycle without opening a chunk transaction", async () => {
    const emptyBankRows = [];
    emptyBankRows.skipped = 7;
    getAdapter.mockReturnValue({
      parse: vi.fn().mockResolvedValue(emptyBankRows),
    });
    const bankProgress = [];

    const bankResult = await stageBatch({
      batchId: 5,
      filePath: "/tmp/empty-bank.csv",
      adapterName: "vision",
      onProgress: (event) => bankProgress.push(event),
    });

    expect(bankResult).toEqual({ rowsTotal: 0, rowsSkipped: 7 });
    expect(bankProgress).toEqual([{ phase: "staging", current: 0, total: 0 }]);
    expect(clientQuery).not.toHaveBeenCalled();
    expect(
      query.mock.calls.some(
        ([sql, params]) =>
          /UPDATE import_batches SET rows_total/.test(sql) && params[0] === 0,
      ),
    ).toBe(true);

    vi.clearAllMocks();
    const emptyPortfolioRows = [];
    emptyPortfolioRows.skipped = 8;
    portfolioParseWithConfig.mockResolvedValue(emptyPortfolioRows);
    const portfolioProgress = [];
    const portfolioResult = await stagePortfolioBatch({
      batchId: 6,
      filePath: "/tmp/empty-portfolio.csv",
      customConfig: CONFIG,
      onProgress: (event) => portfolioProgress.push(event),
    });

    expect(portfolioResult).toEqual({ rowsTotal: 0, rowsSkipped: 8 });
    expect(portfolioProgress).toEqual([
      { phase: "staging", current: 0, total: 0 },
    ]);
    expect(clientQuery).not.toHaveBeenCalled();
    expect(
      query.mock.calls.some(
        ([sql, params]) =>
          /UPDATE portfolio_import_batches SET rows_total/.test(sql) &&
          params[0] === 0,
      ),
    ).toBe(true);
  });
});
