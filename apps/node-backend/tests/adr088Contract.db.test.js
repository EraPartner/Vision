/**
 * ADR-088 contract-phase smoke against a schema where the legacy
 * transactions/planned_transactions.bank_account columns are absent.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { closePool } from "../src/database/connection.js";
import { accountRepository } from "../src/repositories/accountRepository.js";
import { transactionRepository } from "../src/repositories/transactionRepository.js";
import plannedTransactionRepository from "../src/repositories/plannedTransactionRepository.js";
import * as plannedTransactionService from "../src/services/plannedTransactionService.js";
import { commitBatch } from "../src/services/importPipeline/commit.js";
import { isManualDuplicate } from "../src/services/deduplication.js";

vi.mock("../src/services/plannedMatchService.js", () => ({
  autoLinkTransactions: vi.fn().mockResolvedValue({ autoLinkedCount: 0 }),
}));

const describeDb =
  hasTestDatabase() && process.env.VISION_TEST_DB_TASK === "adr088-contract"
    ? describe
    : describe.skip;
const pool = getTestPool();

describeDb("ADR-088 contract schema", () => {
  beforeAll(async () => {
    await acquireDbSuiteLock();
    const { rows } = await pool.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('transactions', 'planned_transactions')
          AND column_name = 'bank_account'`,
    );
    expect(rows.length).toBe(0);
  }, 180_000);

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it("creates, updates, imports, renames, and repoints through account_id only", async () => {
    const { rows: recipientRows } = await pool.query(
      `INSERT INTO recipients (name, normalized_name)
       VALUES ('ADR088 CONTRACT RECIPIENT', 'adr088 contract recipient')
       RETURNING id`,
    );
    const recipientId = recipientRows[0].id;

    const transaction = await transactionRepository.create({
      transaction_date: "2026-09-08",
      bank_account: "Contract Cash",
      recipient_id: recipientId,
      amount: -12.34,
      memo: "contract create",
      currency: "eur",
    });
    expect(transaction.bank_account).toBe("CONTRACT CASH");
    expect(transaction.account_id).toEqual(expect.any(Number));
    await expect(
      isManualDuplicate({
        date: "2026-09-08",
        amount: -12.34,
        recipientId,
        // create() normalizes memo to uppercase; use the stored form so this
        // assertion isolates the contract-schema account lookup.
        memo: "CONTRACT CREATE",
        bankAccount: "Contract Cash",
      }),
    ).resolves.toEqual({
      isDuplicate: true,
      existingTransactionId: transaction.id,
    });

    const moved = await transactionRepository.update(transaction.id, {
      bank_account: "Contract Moved",
    });
    expect(moved.bank_account).toBe("Contract Moved");
    expect(moved.account_id).not.toBe(transaction.account_id);

    const detached = await transactionRepository.create({
      transaction_date: "2026-09-08",
      bank_account: "Contract Detach",
      recipient_id: recipientId,
      amount: -1,
      currency: "EUR",
    });
    expect(
      await transactionRepository.update(detached.id, { bank_account: null }),
    ).toMatchObject({ account_id: null, bank_account: null });

    const planned = await plannedTransactionService.create({
      planned_date: "2026-10-01",
      bank_account: "Contract Planned",
      recipient_id: recipientId,
      amount: -25,
      memo: "contract planned",
      currency: "eur",
    });
    expect(planned.bank_account).toBe("CONTRACT PLANNED");
    const plannedMoved = await plannedTransactionService.update(planned.id, {
      bank_account: "Contract Planned Moved",
    });
    expect(plannedMoved.bank_account).toBe("Contract Planned Moved");

    const { rows: batchRows } = await pool.query(
      `INSERT INTO import_batches (adapter_name, status, rows_total)
       VALUES ('belfius', 'awaiting_review', 1)
       RETURNING id`,
    );
    const batchId = batchRows[0].id;
    await pool.query(
      `INSERT INTO import_staging_rows
         (batch_id, row_index, status, tx_date, bank_account, recipient_raw,
          memo, amount, currency, balance, resolved_recipient_id)
       VALUES ($1, 0, 'matched', '2026-09-09', 'Contract Imported',
               'ADR088 CONTRACT RECIPIENT', 'contract import', -10, 'EUR',
               90, $2)`,
      [batchId, recipientId],
    );
    await expect(commitBatch({ batchId })).resolves.toMatchObject({
      imported: 1,
      errors: 0,
    });
    const { rows: importedRows } = await pool.query(
      `SELECT t.account_id, a.name
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE t.import_batch_id = $1`,
      [batchId],
    );
    expect(importedRows).toEqual([
      expect.objectContaining({
        account_id: expect.any(Number),
        name: "Contract Imported",
      }),
    ]);

    const targetId =
      await accountRepository.resolveOrCreateByName("Contract Survivor");
    await transactionRepository.repointAccount(targetId, [moved.account_id]);
    await plannedTransactionRepository.repointAccount(targetId, [
      plannedMoved.account_id,
    ]);
    await accountRepository.update(targetId, { name: "Contract Renamed" });

    expect(
      (await transactionRepository.getById(transaction.id)).bank_account,
    ).toBe("Contract Renamed");
    expect(
      (await plannedTransactionRepository.getById(planned.id)).bank_account,
    ).toBe("Contract Renamed");
  });
});
