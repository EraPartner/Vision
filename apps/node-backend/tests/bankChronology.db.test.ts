import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import transactionRepository from "../src/repositories/transactionRepository.ts";
import {
  computedBalanceByCurrencyLateral,
  computedBalanceSeriesCtes,
} from "../src/repositories/accountBalanceSql.ts";
import { sql } from "kysely";
import { compileQuery } from "../src/database/db.ts";
import {
  asAccountId,
  asCurrencyCode,
  asRecipientId,
} from "@vision/types/brands";

describe.skipIf(!hasTestDatabase())("bank chronology (real PostgreSQL)", () => {
  let accountId: number;
  let recipientId: number;
  beforeAll(async () => {
    await acquireDbSuiteLock();
    recipientId = (
      await getTestPool()!.query(
        "INSERT INTO recipients (name, normalized_name) VALUES ($1, $1) RETURNING id",
        [`chronology-recipient-${crypto.randomUUID()}`],
      )
    ).rows[0].id;
  });
  afterEach(async () => {
    await getTestPool()!.query(
      "DELETE FROM transactions WHERE account_id = $1",
      [accountId],
    );
    await getTestPool()!.query("DELETE FROM accounts WHERE id = $1", [
      accountId,
    ]);
  });
  afterAll(async () => {
    await getTestPool()!.query("DELETE FROM recipients WHERE id = $1", [
      recipientId,
    ]);
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });
  async function insert(
    sequence: string | null,
    amount: number,
    balance: number | null,
  ) {
    return transactionRepository.insertImportedRow({
      date: "2026-07-01",
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
  }
  async function balances() {
    const current = compileQuery(
      sql`SELECT bal.balance FROM accounts a ${computedBalanceByCurrencyLateral({ account: sql`a.id`, asOfDate: sql`DATE '2026-07-02'` })} WHERE a.id = ${accountId}`,
    );
    const series = compileQuery(
      sql`WITH account_list AS (SELECT ${accountId}::integer AS account_id), days AS (SELECT DATE '2026-07-01' AS day UNION ALL SELECT DATE '2026-07-02'), ${computedBalanceSeriesCtes({ byCurrency: true })} SELECT balance FROM balance_series ORDER BY day`,
    );
    const currentRows = await getTestPool()!.query(current.sql, [
      ...current.parameters,
    ]);
    const seriesRows = await getTestPool()!.query(series.sql, [
      ...series.parameters,
    ]);
    return [
      Number(currentRows.rows[0].balance),
      ...seriesRows.rows.map((row) => Number(row.balance)),
    ];
  }
  it.each([
    ["ascending", [0, 1, 2]],
    ["descending", [2, 1, 0]],
  ] as const)(
    "selects the bank closing anchor for %s imports and later older rows",
    async (_label, order) => {
      const account = await getTestPool()!.query(
        "INSERT INTO accounts (name, type, currency) VALUES ('Chronology fixture', 'checking', 'EUR') RETURNING id",
      );
      accountId = account.rows[0].id;
      const rows = [
        ["10000000050", 100, 1070],
        ["10000000051", -50, 1020],
        ["10000000052", -20, 1000],
      ] as const;
      for (const index of order) { const row = rows[index]; await insert(row[0], row[1], row[2]); }
      expect(await balances()).toEqual([1000, 1000, 1000]);
      // An older same-day row arrives in a later import and gets the largest ID.
      await insert("10000000049", 5, 970);
      expect(await balances()).toEqual([1000, 1000, 1000]);
      await insert(null, -10, null);
      expect(await balances()).toEqual([990, 990, 990]);
      const list = await transactionRepository.getAll({
        accountId: asAccountId(accountId),
        includeBalance: true,
      });
      const lastBankRow = list.find((row) => Number(row.balance) === 1000);
      expect(Number(lastBankRow?.running_balance)).toBe(1000);
    },
  );
});
