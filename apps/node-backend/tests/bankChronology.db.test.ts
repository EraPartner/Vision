import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeTestPool, getTestPool } from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import transactionRepository from "../src/repositories/transactionRepository.ts";
import {
  computedBalanceByCurrencyLateral,
  computedBalanceSeriesCtes,
} from "../src/repositories/accountBalanceSql.ts";
import { bankChronologySql } from "../src/repositories/bankChronologySql.ts";
import { sql } from "kysely";
import { compileQuery } from "../src/database/db.ts";
import {
  asAccountId,
  asCurrencyCode,
  asRecipientId,
} from "@vision/types/brands";
import { firstRow, must } from "./helpers/must.ts";

describe("bank chronology (real DB)", () => {
  let accountId: number;
  let recipientId: number;
  beforeAll(async () => {
    recipientId = firstRow(
      await getTestPool().query<{ id: number }>(
        "INSERT INTO recipients (name, normalized_name) VALUES ($1, $1) RETURNING id",
        [`chronology-recipient-${crypto.randomUUID()}`],
      ),
    ).id;
  });
  afterEach(async () => {
    await getTestPool().query("DELETE FROM transactions WHERE account_id = $1", [accountId]);
    await getTestPool().query("DELETE FROM accounts WHERE id = $1", [accountId]);
  });
  afterAll(async () => {
    await getTestPool().query("DELETE FROM recipients WHERE id = $1", [recipientId]);
    await closeTestPool();
    await closePool();
  });
  async function createAccount() {
    const account = await getTestPool().query<{ id: number }>(
      "INSERT INTO accounts (name, type, currency) VALUES ('Chronology fixture', 'checking', 'EUR') RETURNING id",
    );
    accountId = firstRow(account).id;
  }
  async function insert(
    sequence: string | null,
    amount: number | string,
    balance: number | string | null,
    date = "2026-07-01",
  ) {
    const id = await transactionRepository.insertImportedRow({
      date,
      accountId: asAccountId(accountId),
      recipientId: asRecipientId(recipientId),
      categoryId: null,
      amount,
      balance,
      bankSequence: sequence,
      currency: asCurrencyCode("EUR"),
      memo: "Chronology fixture",
      comment: null,
      importBatchId: null,
      matchedPatternId: null,
    });
    return must(id, "inserted transaction id");
  }
  /** The current balance, then the series for 2026-07-01 and 2026-07-02, as decimal text. */
  async function balances(): Promise<string[]> {
    const current = compileQuery(
      sql`SELECT bal.balance FROM accounts a ${computedBalanceByCurrencyLateral({ account: sql`a.id`, asOfDate: sql`'2026-07-02'` })} WHERE a.id = ${accountId}`,
    );
    const series = compileQuery(
      sql`WITH account_list AS (SELECT ${accountId} AS account_id), days AS (SELECT '2026-07-01' AS day UNION ALL SELECT '2026-07-02'), ${computedBalanceSeriesCtes({ byCurrency: true })} SELECT balance FROM balance_series ORDER BY day`,
    );
    const currentRows = await getTestPool().query<{ balance: string }>(current.sql, [
      ...current.parameters,
    ]);
    const seriesRows = await getTestPool().query<{ balance: string }>(series.sql, [
      ...series.parameters,
    ]);
    return [
      firstRow(currentRows).balance,
      ...seriesRows.rows.map((row) => row.balance),
    ];
  }
  /** The account's transaction ids in bank chronology (date, chronology key, id). */
  async function chronologicalIds(): Promise<number[]> {
    const ordered = compileQuery(
      sql`SELECT t.id FROM transactions t WHERE t.account_id = ${accountId}
          ORDER BY t.date, ${bankChronologySql("t")}, t.id`,
    );
    const rows = await getTestPool().query<{ id: number }>(ordered.sql, [
      ...ordered.parameters,
    ]);
    return rows.rows.map((row) => row.id);
  }

  it.each([
    ["ascending", [0, 1, 2]],
    ["descending", [2, 1, 0]],
  ] as const)(
    "selects the bank closing anchor for %s imports and later older rows",
    async (_label, order) => {
      await createAccount();
      const rows = [
        ["10000000050", 100, 1070],
        ["10000000051", -50, 1020],
        ["10000000052", -20, 1000],
      ] as const;
      for (const index of order) { const row = rows[index]; await insert(row[0], row[1], row[2]); }
      expect(await balances()).toEqual(["1000.0000", "1000.0000", "1000.0000"]);
      // An older same-day row arrives in a later import and gets the largest ID.
      await insert("10000000049", 5, 970);
      expect(await balances()).toEqual(["1000.0000", "1000.0000", "1000.0000"]);
      await insert(null, -10, null);
      expect(await balances()).toEqual(["990.0000", "990.0000", "990.0000"]);
      const list = await transactionRepository.getAll({
        accountId: asAccountId(accountId),
        includeBalance: true,
      });
      const lastBankRow = list.find((row) => row.balance === "1000.0000");
      expect(lastBankRow?.running_balance).toBe("1000.0000");
    },
  );

  it("orders a manual row after every bank-sequenced row of its day, even when it was inserted first", async () => {
    await createAccount();
    // The manual row has the SMALLEST id; a numeric id order would put it first.
    const manual = await insert(null, "-10.0001", null);
    const first = await insert("7", "100.0000", "1100.0000");
    const last = await insert("8", "-0.0001", "1099.9999");
    expect(await chronologicalIds()).toEqual([first, last, manual]);
    // The anchor is the last bank row; the manual row is a post-statement delta
    // (exact decimal: 1099.9999 - 10.0001 = 1089.9998).
    expect(await balances()).toEqual(["1089.9998", "1089.9998", "1089.9998"]);
    const list = await transactionRepository.getAll({
      accountId: asAccountId(accountId),
      includeBalance: true,
    });
    const byId = new Map(list.map((row) => [row.id, row.running_balance]));
    expect(byId.get(last)).toBe("1099.9999");
    expect(byId.get(manual)).toBe("1089.9998");
  });

  it("orders bank sequences numerically up to 10^18 - 1 and keeps manual rows after them", async () => {
    await createAccount();
    // Inserted out of order. As text, '9' > '10' and '999…' > '1…'; the key must
    // order them as numbers.
    const s10 = await insert("10", "1", "51");
    const sMax = await insert("999999999999999999", "4", "60");
    const s9 = await insert("9", "50", "50");
    const manual = await insert(null, "-1", null);
    const sMaxMinus1 = await insert("999999999999999998", "5", "56");
    expect(await chronologicalIds()).toEqual([s9, s10, sMaxMinus1, sMax, manual]);
    // Anchor = sequence 999999999999999999 (balance 60), then the manual -1.
    expect(await balances()).toEqual(["59.0000", "59.0000", "59.0000"]);
  });

  it("puts an earlier day's manual row before a later day's bank rows", async () => {
    await createAccount();
    const laterBank = await insert("1", "5", "105", "2026-07-02");
    const earlierManual = await insert(null, "100", null, "2026-07-01");
    expect(await chronologicalIds()).toEqual([earlierManual, laterBank]);
    // The 07-01 series day is the manual sum alone; 07-02 anchors on the stamp.
    const [current, day1, day2] = await balances();
    expect([current, day1, day2]).toEqual(["105.0000", "100.0000", "105.0000"]);
  });
});
