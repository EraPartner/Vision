/**
 * The bank-adapter output contract (ParsedBankTransaction, ADR-193): the zod
 * schema itself, and the registry seam that checks every adapter's result once.
 * A bad row is an adapter bug (adapters count unreadable rows as `skipped`), so
 * it follows data-contract mode rather than becoming a user-facing row error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockLogger } from "./helpers/mockLogger.ts";

vi.mock("../src/config/logger.ts", () => ({ logger: mockLogger() }));
vi.mock("../src/services/importPipeline/adapters/kbc.ts", () => ({
  default: {
    name: "kbc",
    bankName: "KBC",
    detect: vi.fn(() => true),
    parse: vi.fn(),
  },
}));
vi.mock(
  "../src/services/importPipeline/adapters/generic.ts",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../src/services/importPipeline/adapters/generic.ts")
      >();
    return {
      ...original,
      default: {
        ...original.default,
        parse: vi.fn(),
        parseWithConfig: vi.fn(),
      },
    };
  },
);

import { logger } from "../src/config/logger.ts";
import kbc from "../src/services/importPipeline/adapters/kbc.ts";
import generic from "../src/services/importPipeline/adapters/generic.ts";
import type { CustomTransactionParserConfig } from "../src/services/importPipeline/adapters/generic.ts";
import {
  createAdapter,
  detectBank,
  getAdapter,
} from "../src/services/importPipeline/adapters/index.ts";
import {
  parsedBankTransactionSchema,
  type ParsedBankTransaction,
  type ParsedBankTransactions,
} from "../src/services/importPipeline/adapters/_shared.ts";

const kbcParse = vi.mocked(kbc.parse);
const genericParse = vi.mocked(generic.parse);

function row(overrides: Record<string, unknown> = {}): ParsedBankTransaction {
  return {
    date: new Date(Date.UTC(2024, 0, 15)),
    bankAccount: "BE68539007547034",
    recipient: "SHOP",
    memo: "CARD PAYMENT",
    amount: -12.5,
    currency: "EUR",
    balance: null,
    recipientAccount: null,
    recipientAddress: null,
    recipientBankName: null,
    comment: null,
    rawData: "15/01/2024;-12,50;SHOP",
    sourceId: null,
    ...overrides,
  } as ParsedBankTransaction;
}

function result(
  rows: ParsedBankTransaction[],
  skipped = 0,
): ParsedBankTransactions {
  return Object.assign(rows, { skipped });
}

describe("parsedBankTransactionSchema", () => {
  it("accepts a contract row, with or without the optional sourceId", () => {
    expect(parsedBankTransactionSchema.safeParse(row()).success).toBe(true);
    const { sourceId: _sourceId, ...withoutSourceId } = row();
    expect(parsedBankTransactionSchema.safeParse(withoutSourceId).success).toBe(
      true,
    );
  });

  it.each([
    ["a NaN amount", { amount: NaN }, "amount"],
    ["an infinite balance", { balance: Infinity }, "balance"],
    ["an invalid date", { date: new Date("nope") }, "date"],
    [
      "a date that is not UTC midnight",
      { date: new Date(Date.UTC(2024, 0, 15, 23)) },
      "date",
    ],
    ["a date string", { date: "2024-01-15" }, "date"],
    ["a non-ISO currency", { currency: "eur" }, "currency"],
    ["an empty bank account", { bankAccount: "" }, "bankAccount"],
    ["an empty sourceId", { sourceId: "" }, "sourceId"],
    ["a missing rawData", { rawData: undefined }, "rawData"],
    ["a leaked belfius _seq", { _seq: [1, 2] }, ""],
  ])("rejects %s", (_label, overrides, path) => {
    const parsed = parsedBankTransactionSchema.safeParse(row(overrides));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      path,
    ]);
  });
});

describe("adapter registry output contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns a valid result unchanged, skipped counter included", async () => {
    const parsed = result([row()], 3);
    kbcParse.mockResolvedValue(parsed);
    const out = await getAdapter("kbc")!.parse("/tmp/kbc.csv");
    expect(out).toBe(parsed);
    expect(out.skipped).toBe(3);
    expect(kbcParse).toHaveBeenCalledWith("/tmp/kbc.csv", undefined);
  });

  it("throws on a bad adapter row in tests/development, naming the adapter and path", async () => {
    kbcParse.mockResolvedValue(result([row(), row({ amount: NaN })]));
    await expect(getAdapter("kbc")!.parse("/tmp/kbc.csv")).rejects.toThrow(
      'Data contract violated: bank adapter "kbc" output at rows.1.amount (invalid_type)',
    );
  });

  it("checks the skipped counter riding on the array", async () => {
    kbcParse.mockResolvedValue(result([row()], -1));
    await expect(getAdapter("kbc")!.parse("/tmp/kbc.csv")).rejects.toThrow(
      "at skipped (too_small)",
    );
  });

  it("checks the generic adapter behind createAdapter's custom-config path", async () => {
    const config = {
      bank_name: "My Bank",
      date_format: "%Y-%m-%d",
      column_mapping: { date: "D", recipient: "R", amount: "A" },
    } as CustomTransactionParserConfig;
    genericParse.mockResolvedValue(result([row({ currency: "euro" })]));
    await expect(
      createAdapter("My Bank", config)("/tmp/x.csv"),
    ).rejects.toThrow(
      'bank adapter "generic" output at rows.0.currency (invalid_format)',
    );
    expect(genericParse).toHaveBeenCalledWith("/tmp/x.csv", config);
  });

  it("logs paths only and passes the rows through in production", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("ENVIRONMENT", "production");
    const parsed = result([row({ amount: NaN, recipient: "SECRET PAYEE" })]);
    kbcParse.mockResolvedValue(parsed);

    expect(await getAdapter("kbc")!.parse("/tmp/kbc.csv")).toBe(parsed);
    expect(logger.warn).toHaveBeenCalledWith(
      '[data-contract] bank adapter "kbc" output does not match its schema',
      { issues: ["rows.0.amount (invalid_type)"], issueCount: 1 },
    );
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
      "SECRET",
    );
  });

  it("leaves detection untouched", () => {
    expect(detectBank("anything")).toBe("kbc");
    expect(kbc.detect).toHaveBeenCalledWith("anything");
  });
});
