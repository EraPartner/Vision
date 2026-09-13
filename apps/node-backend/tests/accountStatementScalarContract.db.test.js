/** Contract-phase smoke with accounts.statement_balance* absent. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "../src/database/connection.js";
import { accountRepository } from "../src/repositories/accountRepository.js";
import { accountService } from "../src/services/accountService.js";
import { transactionRepository } from "../src/repositories/transactionRepository.js";
import { reconcileAccount } from "../src/services/reconcileService.js";
import { closeTestPool, getTestPool, hasTestDatabase } from "./setup/db.js";

const describeDb =
  hasTestDatabase() && process.env.VISION_TEST_DB_TASK === "statement-contract"
    ? describe
    : describe.skip;
const pool = getTestPool();

describeDb("account statement scalar contract schema", () => {
  beforeAll(async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'accounts'
          AND column_name IN ('statement_balance', 'statement_balance_date')`,
    );
    expect(rows).toHaveLength(0);
  });

  afterAll(async () => {
    await pool.query(
      "DELETE FROM transactions WHERE memo = 'STATEMENT CONTRACT'",
    );
    await pool.query(
      "DELETE FROM accounts WHERE name = 'Statement Contract Account'",
    );
    await pool.query(
      "DELETE FROM recipients WHERE normalized_name = 'statement contract recipient'",
    );
    await closeTestPool();
    await closePool();
  });

  it("creates, reads, and reconciles through the currency collection only", async () => {
    const account = await accountRepository.create({
      name: "Statement Contract Account",
      display_name: "Statement Contract Account",
      currency: "EUR",
    });
    const { rows: recipients } = await pool.query(
      `INSERT INTO recipients (name, normalized_name)
       VALUES ('Statement Contract Recipient', 'statement contract recipient')
       RETURNING id`,
    );
    await transactionRepository.create({
      transaction_date: "2026-09-01",
      account_id: account.id,
      recipient_id: recipients[0].id,
      amount: 100,
      currency: "EUR",
      memo: "STATEMENT CONTRACT",
    });
    await accountService.setStatementBalance(account.id, "EUR", {
      balance: 120,
      date: "2026-09-01",
    });

    const listed = await accountService.list({ active: null });
    const row = listed.items.find((item) => item.id === account.id);
    expect(row).toMatchObject({
      statement_balances: [
        { currency: "EUR", balance: 120, balance_date: "2026-09-01" },
      ],
      reconcilable_balance: 100,
      reconcilable_currency: "EUR",
      drift: 20,
    });

    await expect(
      accountService.update(account.id, { statement_balance: 1 }),
    ).rejects.toThrow(/statement_balance/);
    await expect(
      reconcileAccount(account.id, { mode: "accept" }),
    ).resolves.toMatchObject({
      statement_balance: 100,
      computed_balance: 100,
      drift: 0,
    });
  });
});
