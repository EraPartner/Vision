import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

import { mockLogger } from "./helpers/mockLogger.ts";
import { mockConnection } from "./helpers/repoMocks.ts";
// Zero-row import guard (TODO E9): a bad column mapping (nonexistent date
// column, wrong date format) null-parses every row — the adapter skips them
// all and the batch used to auto-complete {imported: 0, errors: 0} with a
// success toast. The pipeline also dropped the adapter's `skipped` count, so
// a partially unparseable file looked fully imported.

vi.mock("../src/config/logger.ts", () => ({
  logger: mockLogger(),
}));
vi.mock("../src/database/connection.ts", () =>
  mockConnection({
    query: vi.fn().mockResolvedValue({ rows: [{ is_brokerage: false }] }),
  }),
);
vi.mock("../src/services/info/cache.ts", () => ({
  invalidatePortfolioCaches: vi.fn(),
}));
vi.mock("../src/services/portfolioImportPipeline/stage.ts", () => ({
  createBatch: vi.fn().mockResolvedValue(42),
  stageBatch: vi.fn(),
}));
vi.mock("../src/services/portfolioImportPipeline/validate.ts", () => ({
  validateBatch: vi.fn().mockResolvedValue({ errors: 0 }),
}));
vi.mock("../src/services/portfolioImportPipeline/matchInvestments.ts", () => ({
  matchBatch: vi
    .fn()
    .mockResolvedValue({ matchSourceCounts: { symbol: 5 }, unresolved: 0 }),
}));
vi.mock("../src/services/portfolioImportPipeline/commit.ts", () => ({
  commitBatch: vi
    .fn()
    .mockResolvedValue({ imported: 5, duplicates: 0, errors: 0 }),
}));

import { query as rawQuery } from "../src/database/connection.ts";
import { stageBatch as rawStageBatch } from "../src/services/portfolioImportPipeline/stage.ts";
import { validateBatch as rawValidateBatch } from "../src/services/portfolioImportPipeline/validate.ts";
import { matchBatch as rawMatchBatch } from "../src/services/portfolioImportPipeline/matchInvestments.ts";
import { ValidationError } from "../src/middleware/errorHandler.ts";
import {
  prepareImport,
  runPortfolioImportPipeline,
} from "../src/services/portfolioImportPipeline/index.ts";
import { partial } from "./helpers/partial.ts";

/** The structural slice of pg's query surface these fakes implement. */
type FakeQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[] }>;
const query = rawQuery as unknown as Mock<FakeQuery>;
const stageBatch = vi.mocked(rawStageBatch);
const validateBatch = vi.mocked(rawValidateBatch);
const matchBatch = vi.mocked(rawMatchBatch);
type ValidateResult = Awaited<ReturnType<typeof rawValidateBatch>>;
type MatchResult = Awaited<ReturnType<typeof rawMatchBatch>>;

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [{ is_brokerage: false }] });
  validateBatch.mockResolvedValue(partial<ValidateResult>({ errors: 0 }));
  matchBatch.mockResolvedValue(
    partial<MatchResult>({
      matchSourceCounts: { symbol: 5 },
      unresolved: 0,
    }),
  );
});

describe("portfolio import zero-row guard", () => {
  it("rejects a batch where every row failed to parse, before validation runs", async () => {
    stageBatch.mockResolvedValue({ rowsTotal: 0, rowsSkipped: 7 });

    await expect(
      prepareImport({ batchId: 42, filePath: "/tmp/f.csv", customConfig: {} }),
    ).rejects.toThrowError(/all 7 data rows failed to parse/);
    await expect(
      prepareImport({ batchId: 42, filePath: "/tmp/f.csv", customConfig: {} }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(validateBatch).not.toHaveBeenCalled();
  });

  it("rejects an empty file with a distinct message", async () => {
    stageBatch.mockResolvedValue({ rowsTotal: 0, rowsSkipped: 0 });

    await expect(
      prepareImport({ batchId: 42, filePath: "/tmp/f.csv", customConfig: {} }),
    ).rejects.toThrowError(/No importable rows found/);
  });

  it("marks the batch failed when the full pipeline hits the guard", async () => {
    stageBatch.mockResolvedValue({ rowsTotal: 0, rowsSkipped: 3 });

    await expect(
      runPortfolioImportPipeline({
        filePath: "/tmp/f.csv",
        adapterName: "x",
        customConfig: {},
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const failedUpdate = query.mock.calls.find(([sql]) =>
      /SET status = 'failed'/.test(sql),
    );
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate![1]![0]).toBe(42);
    expect(failedUpdate![1]![1]).toMatch(/failed to parse/);
  });
});

describe("portfolio import skipped-count propagation", () => {
  it("returns the skipped count on the auto-commit path", async () => {
    stageBatch.mockResolvedValue({ rowsTotal: 5, rowsSkipped: 3 });

    const result = await runPortfolioImportPipeline({
      filePath: "/tmp/f.csv",
      adapterName: "x",
      customConfig: {},
    });

    expect(result).toMatchObject({
      total: 5,
      skipped: 3,
      imported: 5,
      requiresReview: false,
    });
  });

  it("returns the skipped count on the review path", async () => {
    stageBatch.mockResolvedValue({ rowsTotal: 5, rowsSkipped: 2 });
    matchBatch.mockResolvedValue(
      partial<MatchResult>({
        matchSourceCounts: { symbol: 3 },
        unresolved: 2,
      }),
    );

    const result = await runPortfolioImportPipeline({
      filePath: "/tmp/f.csv",
      adapterName: "x",
      customConfig: {},
    });

    expect(result).toMatchObject({
      total: 5,
      skipped: 2,
      requiresReview: true,
    });
  });
});
