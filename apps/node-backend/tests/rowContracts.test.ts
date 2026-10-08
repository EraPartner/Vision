/**
 * Runtime row contracts (ADR-193): strict mode throws with column paths,
 * production mode logs and passes rows through, and no message ever carries a
 * row value.
 */
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Mock } from "vitest";
import { z } from "zod";
import { mockConnection } from "./helpers/repoMocks.ts";
import { mockLogger } from "./helpers/mockLogger.ts";
import { accountBalanceRow, txRow } from "./helpers/pgRows.ts";

vi.mock("../src/database/connection.ts", () => mockConnection());
vi.mock("../src/config/logger.ts", () => ({ logger: mockLogger() }));

import { query as rawQuery } from "../src/database/connection.ts";
import { logger } from "../src/config/logger.ts";
import {
  RowContractError,
  checkRows,
  queryOne,
  queryRows,
} from "../src/database/rowContracts.ts";
import {
  accountBalanceQueryRowSchema,
  countRowSchema,
  enrichedTransactionDbRowSchema,
  transactionRowSchema,
} from "../src/database/rowSchemas.ts";
import type {
  AccountBalanceQueryRow,
  TransactionRow,
} from "../src/types/rows.ts";

const query = rawQuery as unknown as Mock<
  (text: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>
>;
const warn = logger.warn as Mock;

// Distinctive values that must never surface in an error or log line.
const SECRET_MEMO = "SALARY ACME BE71096123456769";
const SECRET_AMOUNT = 4321.98;

/** A row whose NUMERIC and DATE columns came back with the wrong JS type. */
const brokenRow = () => ({
  ...txRow({ id: 2, memo: SECRET_MEMO }),
  amount: SECRET_AMOUNT,
  date: "2026-01-15",
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkRows in throw mode", () => {
  it("throws RowContractError naming the row, the columns and the types", () => {
    const rows = [txRow({ id: 1 }), brokenRow(), txRow({ id: 3 })];
    let caught: unknown;
    try {
      checkRows(transactionRowSchema, rows, { mode: "throw" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RowContractError);
    const error = caught as RowContractError;
    expect(error.message).toContain("(transactions row) at row 2 of 3");
    expect(error.issues).toEqual([
      "date: expected date, received string",
      "amount: expected string, received number",
    ]);
  });

  it("never puts row values in the message", () => {
    expect(() =>
      checkRows(transactionRowSchema, [brokenRow()], { mode: "throw" }),
    ).toThrow(RowContractError);
    try {
      checkRows(transactionRowSchema, [brokenRow()], { mode: "throw" });
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(SECRET_MEMO);
      expect(message).not.toContain(String(SECRET_AMOUNT));
      expect(message).not.toContain("2026-01-15");
    }
  });

  it("reports enum and nested JSON paths without values", () => {
    expect(() =>
      checkRows(
        transactionRowSchema,
        [
          txRow({
            transfer_source: "sideways" as TransactionRow["transfer_source"],
          }),
        ],
        { mode: "throw" },
      ),
    ).toThrow(
      "transfer_source: expected one of auto|manual|opening|adjustment|brokerage",
    );
    expect(() =>
      checkRows(
        accountBalanceQueryRowSchema,
        [
          accountBalanceRow({
            statement_balances: [
              // json_build_object emits NUMERIC as a JSON number, never a string
              {
                currency: "EUR",
                balance: "12.34" as unknown as number,
                balance_date: "2026-07-01",
              },
            ],
          }),
        ],
        { mode: "throw" },
      ),
    ).toThrow("statement_balances.0.balance: expected number, received string");
  });

  it("names a row that is not an object at all", () => {
    expect(() => checkRows(countRowSchema, [null], { mode: "throw" })).toThrow(
      "(row): expected object, received null",
    );
  });
});

describe("checkRows in log mode (production default)", () => {
  it("warns with paths only and passes the very same rows through", () => {
    const rows = [txRow({ id: 1 }), brokenRow()];
    const result = checkRows(transactionRowSchema, rows, { mode: "log" });

    expect(result).toBe(rows);
    expect(result[1]).toBe(rows[1]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [line, ...extra] = warn.mock.calls[0];
    expect(extra).toEqual([]);
    expect(line).toContain("(transactions row) at row 2 of 2");
    expect(line).toContain("amount: expected string, received number");
    expect(line).not.toContain(SECRET_MEMO);
    expect(line).not.toContain(String(SECRET_AMOUNT));
  });

  it("stops at the first failing row so a systematic mismatch logs once", () => {
    checkRows(transactionRowSchema, [brokenRow(), brokenRow(), brokenRow()], {
      mode: "log",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("at row 1 of 3");
  });
});

describe("checkRows on valid rows", () => {
  it("returns pg's own objects, extra columns included, and logs nothing", () => {
    const row = { ...txRow({ id: 5 }), tx_hash: "legacy column" };
    const result = checkRows(transactionRowSchema, [row], { mode: "throw" });
    expect(result[0]).toBe(row);
    expect(result[0]).toHaveProperty("tx_hash", "legacy column");
    expect(warn).not.toHaveBeenCalled();
  });

  it("defaults to throw mode under Vitest", () => {
    expect(() => checkRows(transactionRowSchema, [brokenRow()])).toThrow(
      RowContractError,
    );
  });
});

describe("queryRows / queryOne", () => {
  it("runs on the pool query and checks every row", async () => {
    query.mockResolvedValueOnce({ rows: [{ count: "3" }] });
    await expect(
      queryRows(countRowSchema, "SELECT COUNT(*) FROM t WHERE x = $1", [1]),
    ).resolves.toEqual([{ count: "3" }]);
    expect(query).toHaveBeenCalledWith(
      "SELECT COUNT(*) FROM t WHERE x = $1",
      [1],
    );

    // COUNT(*) is BIGINT: a number here means the SQL or the schema is wrong.
    query.mockResolvedValueOnce({ rows: [{ count: 3 }] });
    await expect(
      queryRows(countRowSchema, "SELECT COUNT(*) FROM t", []),
    ).rejects.toThrow("(count row) at row 1 of 1: count: expected string");
  });

  it("runs on an explicit client instead of the pool", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [txRow()] }) };
    const rows = await queryRows(
      enrichedTransactionDbRowSchema,
      "SELECT 1",
      [7],
      client,
    );
    expect(rows).toHaveLength(1);
    expect(client.query).toHaveBeenCalledWith("SELECT 1", [7]);
    expect(query).not.toHaveBeenCalled();
  });

  it("labels an undescribed schema with the head of its SQL", async () => {
    query.mockResolvedValueOnce({ rows: [{ n: "1" }] });
    await expect(
      queryRows(z.object({ n: z.int() }), "SELECT\n  n   FROM widgets"),
    ).rejects.toThrow("(SELECT n FROM widgets) at row 1 of 1");
  });

  it("queryOne returns the first row or undefined", async () => {
    query.mockResolvedValueOnce({ rows: [{ count: "1" }] });
    await expect(queryOne(countRowSchema, "SELECT 1")).resolves.toEqual({
      count: "1",
    });
    query.mockResolvedValueOnce({ rows: [] });
    await expect(queryOne(countRowSchema, "SELECT 1")).resolves.toBeUndefined();
  });
});

describe("row types derived from the schemas", () => {
  it("keep pg's string NUMERIC/BIGINT and Date DATE shapes", () => {
    expectTypeOf<TransactionRow["amount"]>().toEqualTypeOf<string>();
    expectTypeOf<TransactionRow["date"]>().toEqualTypeOf<Date>();
    expectTypeOf<TransactionRow["import_batch_id"]>().toEqualTypeOf<
      string | null | undefined
    >();
    expectTypeOf<
      NonNullable<
        AccountBalanceQueryRow["statement_balances"]
      >[number]["balance"]
    >().toEqualTypeOf<number>();
  });
});
