import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { mockLogger } from "./helpers/mockLogger.ts";
import { mockTxConnection } from "./helpers/repoMocks.ts";
import { loose } from "./helpers/partial.ts";
import { parse as parseVision } from "../src/services/importPipeline/adapters/vision.ts";
import { useTempCSV } from "./helpers/tempFile.ts";

const writeTempCSV = useTempCSV("staging-rejected");

const {
  clientQuery,
  getAdapter,
  genericParseWithConfig,
  portfolioParseWithConfig,
} = vi.hoisted(() => ({
  clientQuery: vi.fn().mockResolvedValue({ rows: [] }),
  getAdapter: vi.fn<(name: string) => unknown>(),
  genericParseWithConfig: vi
    .fn<(...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue([]),
  portfolioParseWithConfig: vi
    .fn<(...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue([]),
}));

vi.mock("../src/database/connection.ts", () =>
  mockTxConnection(
    { query: clientQuery },
    { query: vi.fn().mockResolvedValue({ rows: [] }) },
  ),
);

vi.mock("../src/config/logger.ts", () => ({
  logger: mockLogger(),
}));

vi.mock("../src/services/importPipeline/adapters/index.ts", () => ({
  getAdapter: (name: string) => getAdapter(name),
}));

vi.mock(
  "../src/services/portfolioImportPipeline/portfolioGenericAdapter.ts",
  () => ({
    parseWithConfig: (...args: unknown[]) => portfolioParseWithConfig(...args),
  }),
);

import {
  stageBatch,
  createBatch,
} from "../src/services/importPipeline/stage.ts";
import {
  createBatch as createPortfolioBatch,
  stageBatch as stagePortfolioBatch,
} from "../src/services/portfolioImportPipeline/stage.ts";
import { query as rawQuery } from "../src/database/connection.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import type { CustomTransactionParserConfig } from "../src/services/importPipeline/adapters/generic.ts";
import type { PortfolioParserConfig } from "../src/services/portfolioImportPipeline/portfolioGenericAdapter.ts";
import { must } from "./helpers/must.ts";
import { valueAt } from "./helpers/responseBody.ts";

const query = rawQuery as unknown as Mock<
  (
    sql: string,
    params?: readonly unknown[],
  ) => Promise<Partial<PgQueryResult>>
>;

/** Parsed rows as an adapter returns them: the array carries its skip count. */
type ParsedRows<T> = T[] & { skipped?: number; excluded?: number };

// loose: an opaque placeholder. Both parsers are mocked, so the tests only
// check that the config is forwarded untouched, not that it is well formed.
/** Bank staging-row INSERTs issued on either the pool or a transaction client. */
function stagingInserts(): number {
  return [...query.mock.calls, ...clientQuery.mock.calls].filter(([sql]) =>
    /insert into "?import_staging_rows"?/i.test(String(sql)),
  ).length;
}

const CONFIG = loose<CustomTransactionParserConfig & PortfolioParserConfig>({
  dateColumn: "D",
  recipientColumn: "R",
  amountColumn: "A",
});

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

  it("falls back to the registry's generic adapter when a named custom adapter is not in the registry", async () => {
    // "My Bank" is not a registered adapter. The fallback must come from the
    // registry, whose adapters carry the output contract (ADR-193).
    getAdapter.mockImplementation((name: string) =>
      name === "generic"
        ? {
            name: "generic",
            parse: vi.fn(),
            parseWithConfig: (...args: unknown[]) =>
              genericParseWithConfig(...args),
          }
        : null,
    );

    await stageBatch({
      batchId: 1,
      filePath: "/tmp/x.csv",
      adapterName: "My Bank",
      customConfig: CONFIG,
    });

    expect(getAdapter).toHaveBeenCalledWith("generic");
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

  it("rejects a mixed Vision file before inserting even its valid row", async () => {
    getAdapter.mockReturnValue({ parse: parseVision });
    const filePath =
      writeTempCSV(`Date,Bank Account,Recipient,Memo,Amount,Currency
2026-03-01,Main Account,John Doe,Dinner,-45.20,EUR
INVALID_DATE,Main Account,Skip Date,Note,-10.00,EUR
2026-03-02,Main Account,Skip Amount,Note,INVALID,EUR
`);
    const rejection = await stageBatch({
      batchId: 7,
      filePath,
      adapterName: "vision",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      details: { rejected_rows: 2, parsed_rows: 1 },
    });
    expect(valueAt(rejection, "message")).toMatch(/2 source row\(s\)/);
    expect(stagingInserts()).toBe(0);
    expect(query.mock.calls.some(([sql]) => sql.includes("rows_total"))).toBe(
      false,
    );
  });

  it("rejects an entirely invalid custom file instead of reporting zero-row success", async () => {
    const rows = Object.assign([], { skipped: 2 });
    getAdapter.mockReturnValue({
      parseWithConfig: vi.fn().mockResolvedValue(rows),
    });
    await expect(
      stageBatch({
        batchId: 8,
        filePath: "/tmp/custom.csv",
        adapterName: "generic",
        customConfig: CONFIG,
      }),
    ).rejects.toMatchObject({
      status: 400,
      details: { rejected_rows: 2, parsed_rows: 0 },
    });
    expect(stagingInserts()).toBe(0);
  });

  it("shares zero-row and 500-row chunk progress across both stage pipelines", async () => {
    const bankRows: ParsedRows<{
      date: Date;
      amount: number;
      currency: string;
    }> = Array.from({ length: 501 }, (_, index) => ({
      date: new Date("2026-01-01T00:00:00Z"),
      amount: index + 1,
      currency: "EUR",
    }));
    bankRows.skipped = 2;
    bankRows.excluded = 2;
    getAdapter.mockReturnValue({ parse: vi.fn().mockResolvedValue(bankRows) });
    const bankProgress: unknown[] = [];

    const bankResult = await stageBatch({
      batchId: 3,
      filePath: "/tmp/bank.csv",
      adapterName: "vision",
      onProgress: (event) => bankProgress.push(event.current),
    });

    expect(bankResult).toEqual({ rowsTotal: 501, rowsSkipped: 2 });
    expect(bankProgress).toEqual([0, 500, 501]);
    expect(stagingInserts()).toBe(2);

    clientQuery.mockClear();
    const portfolioRows: ParsedRows<{
      date: Date;
      amount: number;
      currency: string;
    }> = Array.from({ length: 501 }, (_, index) => ({
      date: new Date("2026-01-01T00:00:00Z"),
      amount: index + 1,
      currency: "EUR",
    }));
    portfolioRows.skipped = 3;
    portfolioParseWithConfig.mockResolvedValue(portfolioRows);
    const portfolioProgress: unknown[] = [];

    const portfolioResult = await stagePortfolioBatch({
      batchId: 4,
      filePath: "/tmp/portfolio.csv",
      customConfig: CONFIG,
      onProgress: (event) => portfolioProgress.push(event.current),
    });

    expect(portfolioResult).toEqual({ rowsTotal: 501, rowsSkipped: 3 });
    expect(portfolioProgress).toEqual([0, 500, 501]);
    expect(
      [...query.mock.calls, ...clientQuery.mock.calls].filter(([sql]) =>
        /insert into "?portfolio_import_staging_rows"?/i.test(String(sql)),
      ),
    ).toHaveLength(2);
  });

  it("persists and reports the zero-row lifecycle without opening a chunk transaction", async () => {
    const emptyBankRows: ParsedRows<unknown> = [];
    emptyBankRows.skipped = 7;
    emptyBankRows.excluded = 7;
    getAdapter.mockReturnValue({
      parse: vi.fn().mockResolvedValue(emptyBankRows),
    });
    const bankProgress: unknown[] = [];

    const bankResult = await stageBatch({
      batchId: 5,
      filePath: "/tmp/empty-bank.csv",
      adapterName: "vision",
      onProgress: (event) => bankProgress.push(event),
    });

    expect(bankResult).toEqual({ rowsTotal: 0, rowsSkipped: 7 });
    expect(bankProgress).toEqual([{ phase: "staging", current: 0, total: 0 }]);
    expect(stagingInserts()).toBe(0);
    expect(
      query.mock.calls.some(
        ([sql, params]) =>
          /update "?import_batches"? set "?rows_total"?/i.test(sql) &&
          must(params, "params")[0] === 0,
      ),
    ).toBe(true);

    vi.clearAllMocks();
    const emptyPortfolioRows: ParsedRows<unknown> = [];
    emptyPortfolioRows.skipped = 8;
    portfolioParseWithConfig.mockResolvedValue(emptyPortfolioRows);
    const portfolioProgress: unknown[] = [];
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
          /update "?portfolio_import_batches"? set "?rows_total"?/i.test(sql) &&
          must(params, "params")[0] === 0,
      ),
    ).toBe(true);
  });
});
