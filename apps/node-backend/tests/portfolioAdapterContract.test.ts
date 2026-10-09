/**
 * The portfolio adapter output contract (ParsedPortfolioRow, ADR-193): the zod
 * schema, and the single check in portfolioGenericAdapter.parseWithConfig that
 * covers the generic mapper and every specialized format.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockLogger } from "./helpers/mockLogger.ts";

vi.mock("../src/config/logger.ts", () => ({ logger: mockLogger() }));
// The funding adapter pulls in the xlsx reader; it is not under test here.
vi.mock(
  "../src/services/portfolioImportPipeline/ibkrFundingHistoryAdapter.ts",
  () => ({ parseIbkrFundingHistory: vi.fn() }),
);
vi.mock(
  "../src/services/portfolioImportPipeline/saxoTransactionHistoryAdapter.ts",
  () => ({ parseSaxoTransactionHistory: vi.fn() }),
);

import { logger } from "../src/config/logger.ts";
import { parseSaxoTransactionHistory } from "../src/services/portfolioImportPipeline/saxoTransactionHistoryAdapter.ts";
import {
  parsedPortfolioRowSchema,
  parseWithConfig,
  type ParsedPortfolioRow,
  type ParsedPortfolioRows,
} from "../src/services/portfolioImportPipeline/portfolioGenericAdapter.ts";

const saxo = vi.mocked(parseSaxoTransactionHistory);
const SAXO = { format: "saxo_transaction_history" as const };

function row(overrides: Record<string, unknown> = {}): ParsedPortfolioRow {
  return {
    date: new Date(Date.UTC(2024, 2, 1)),
    typeRaw: "Buy",
    symbolRaw: "VWCE",
    nameRaw: "",
    units: 2,
    pricePerUnit: 100,
    amount: 200,
    fees: null,
    taxes: null,
    currency: "EUR",
    fxRateToEur: null,
    note: "",
    rawData: "2024-03-01,Buy,VWCE,2,100",
    sourceAccountIdentity: null,
    sourceId: null,
    ...overrides,
  } as ParsedPortfolioRow;
}

function result(rows: ParsedPortfolioRow[], skipped = 0): ParsedPortfolioRows {
  return Object.assign(rows, { skipped });
}

describe("parsedPortfolioRowSchema", () => {
  it("accepts a contract row, including the null date validate rejects later", () => {
    expect(parsedPortfolioRowSchema.safeParse(row()).success).toBe(true);
    expect(
      parsedPortfolioRowSchema.safeParse(row({ date: null })).success,
    ).toBe(true);
    expect(
      parsedPortfolioRowSchema.safeParse(
        row({
          typeRaw: "AssetTransfer",
          assetTransfer: {
            direction: "in",
            basisStatus: "carried",
            receivedUnits: "1.5",
          },
        }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ["NaN units", { units: NaN }, "units"],
    [
      "a date that is not UTC midnight",
      { date: new Date(Date.UTC(2024, 2, 1, 9, 30)) },
      "date",
    ],
    ["a numeric string amount", { amount: "200" }, "amount"],
    ["a missing note", { note: undefined }, "note"],
    ["an unknown key", { isin: "IE00BK5BQT80" }, ""],
    [
      "an unknown transfer direction",
      { assetTransfer: { direction: "sideways", basisStatus: "carried" } },
      "assetTransfer.direction",
    ],
  ])("rejects %s", (_label, overrides, path) => {
    const parsed = parsedPortfolioRowSchema.safeParse(row(overrides));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      path,
    ]);
  });
});

describe("parseWithConfig output contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns a specialized format's valid result unchanged", async () => {
    const parsed = result([row()], 2);
    saxo.mockResolvedValue(parsed);
    expect(await parseWithConfig("/tmp/saxo.csv", SAXO)).toBe(parsed);
    expect(saxo).toHaveBeenCalledWith("/tmp/saxo.csv", SAXO);
  });

  it("throws on a bad row in tests/development, naming the format and path", async () => {
    saxo.mockResolvedValue(result([row(), row({ units: NaN })]));
    await expect(parseWithConfig("/tmp/saxo.csv", SAXO)).rejects.toThrow(
      'Data contract violated: portfolio adapter "saxo_transaction_history" output at rows.1.units (invalid_type)',
    );
  });

  it("blocks a bad row in production too, naming paths but not values", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("ENVIRONMENT", "production");
    saxo.mockResolvedValue(
      result([row({ units: NaN, symbolRaw: "SECRETCO" })]),
    );

    const error = await parseWithConfig("/tmp/saxo.csv", SAXO).catch(
      (err: unknown) => err,
    );
    expect(String(error)).toContain(
      'portfolio adapter "saxo_transaction_history" output at rows.0.units (invalid_type)',
    );
    expect(String(error)).not.toContain("SECRETCO");
  });
});
