import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeTestPool, getTestPool } from "./setup/db.ts";
import { closePool, getPoolStats, withTransaction } from "../src/database/connection.ts";
import { closeAccount } from "../src/services/accountCloseService.ts";
import transactionRepository from "../src/repositories/transactionRepository.ts";
import { accountRepository } from "../src/repositories/accountRepository.ts";
import {
  bulkDeleteTransactions,
  bulkUpdateTransactions,
} from "../src/services/transactionBulkService.ts";
import { rollbackBatch } from "../src/repositories/importBatchRepository.ts";
import { commitBatch } from "../src/services/importPipeline/commit.ts";
import {
  asAccountId,
  asTransactionId,
} from "@vision/types/brands";
import { firstRow, must } from "./helpers/must.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/**
 * Account lifecycle serialization (ADR-263). PostgreSQL serialized a close
 * against concurrent ledger writes with row locks on the account; SQLite runs
 * every write transaction on the single writer behind BEGIN IMMEDIATE, so the
 * second transaction waits for the database write lock instead, and its
 * eligibility read (lockAccountsForLedgerMutation / findActiveId) runs after
 * the first commits. Each test holds the first transaction open, proves the
 * second is queued on the write lock, then releases and checks the outcome.
 */
describe(
  "account lifecycle serialization (single writer)",
  () => {
    const accounts: number[] = [];
    const batches: number[] = [];
    const recipients: number[] = [];
    afterEach(async () => {
      await must(getTestPool(), "getTestPool()").query(
        "DELETE FROM transactions WHERE account_id IN (SELECT value FROM json_each($1))",
        [accounts],
      );
      await must(getTestPool(), "getTestPool()").query(
        "DELETE FROM import_staging_rows WHERE batch_id IN (SELECT value FROM json_each($1))",
        [batches],
      );
      await must(getTestPool(), "getTestPool()").query(
        "DELETE FROM import_batches WHERE id IN (SELECT value FROM json_each($1))",
        [batches.splice(0)],
      );
      await must(getTestPool(), "getTestPool()").query(
        "DELETE FROM recipients WHERE id IN (SELECT value FROM json_each($1))",
        [recipients.splice(0)],
      );
      await must(getTestPool(), "getTestPool()").query(
        "DELETE FROM accounts WHERE id IN (SELECT value FROM json_each($1))",
        [accounts.splice(0)],
      );
    });
    afterAll(async () => {
      await closeTestPool();
      await closePool();
    });
    async function fixture() {
      const pool = must(getTestPool(), "getTestPool()");
      const result = await pool.query<{ id: number }>(
        "INSERT INTO accounts (name) VALUES ($1) RETURNING id",
        [`lifecycle-${crypto.randomUUID()}`],
      );
      const accountId = must(result.rows[0], "row").id;
      accounts.push(accountId);
      const name = `lifecycle-recipient-${crypto.randomUUID()}`;
      const recipientId = firstRow(
        await pool.query<{ id: number }>(
          "INSERT INTO recipients(name,normalized_name) VALUES ($1,$1) RETURNING id",
          [name],
        ),
      ).id;
      recipients.push(recipientId);
      const transaction = await pool.query<{ id: number }>(
        "INSERT INTO transactions (date, amount, currency, account_id, recipient_id) VALUES ('2026-01-01', vision_numeric('100', 18, 4), 'EUR', $1, $2) RETURNING id",
        [accountId, recipientId],
      );
      return {
        accountId,
        recipientId,
        transactionId: must(transaction.rows[0], "row").id,
      };
    }
    /** Wait until a second write transaction is queued on the write lock. */
    async function waitForBlockedLedgerWrite() {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (getPoolStats().waitingCount > 0) return;
        await new Promise((done) => setTimeout(done, 10));
      }
      throw new Error("Expected a write-lock waiter");
    }
    it("rejects an edit after a concurrent close commits", async () => {
      const { accountId, transactionId } = await fixture();
      const closed = deferred();
      const release = deferred();
      const closing = withTransaction(async () => {
        await closeAccount(asAccountId(accountId), { balance_handling: "adjustment" });
        closed.resolve();
        await release.promise;
      });
      await Promise.race([closed.promise, closing]);
      const editing = transactionRepository.update(asTransactionId(transactionId), {
        amount: 150,
      });
      const outcome = editing.then(
        () => "unexpected success",
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );
      try {
        await waitForBlockedLedgerWrite();
      } finally {
        release.resolve();
      }
      await closing;
      expect(await outcome).toContain("Reopen the account");
      const { rows } = await must(getTestPool(), "getTestPool()").query<{ balance: string }>(
        "SELECT dec_sum(amount) AS balance FROM transactions WHERE account_id=$1",
        [accountId],
      );
      expect(Number(must(rows[0], "row").balance)).toBe(0);
    });
    it("holds a create eligibility lock until commit, so close includes the write", async () => {
      const { accountId, recipientId } = await fixture();
      const written = deferred();
      const release = deferred();
      const writing = withTransaction(async (client) => {
        expect(
          await accountRepository.findActiveId(accountId, { client }),
        ).toBe(accountId);
        await client.query(
          "INSERT INTO transactions (date, amount, currency, account_id, recipient_id) VALUES ('2026-01-02', vision_numeric('25', 18, 4), 'EUR', $1, $2)",
          [accountId, recipientId],
        );
        written.resolve();
        await release.promise;
      });
      await Promise.race([written.promise, writing]);
      const closing = closeAccount(asAccountId(accountId), {
        balance_handling: "adjustment",
      });
      try {
        await waitForBlockedLedgerWrite();
      } finally {
        release.resolve();
      }
      await writing;
      await closing;
      const { rows } = await must(getTestPool(), "getTestPool()").query<{ balance: string }>(
        "SELECT dec_sum(amount) AS balance FROM transactions WHERE account_id=$1",
        [accountId],
      );
      expect(Number(must(rows[0], "row").balance)).toBe(0);
    });

    it("zeros an exact-decimal balance on close (100 + 0.1 + 0.2 is 100.3)", async () => {
      const { accountId, recipientId } = await fixture();
      for (const amount of ["0.1", "0.2"]) {
        await must(getTestPool(), "getTestPool()").query(
          "INSERT INTO transactions (date, amount, currency, account_id, recipient_id) VALUES ('2026-01-31', vision_numeric($1, 18, 4), 'EUR', $2, $3)",
          [amount, accountId, recipientId],
        );
      }
      await closeAccount(asAccountId(accountId), { balance_handling: "adjustment" });
      const adjustments = await must(getTestPool(), "getTestPool()").query(
        "SELECT amount, currency FROM transactions WHERE account_id=$1 AND transfer_source='adjustment'",
        [accountId],
      );
      expect(adjustments.rows).toEqual([{ amount: "-100.3000", currency: "EUR" }]);
      const persisted = await must(getTestPool(), "getTestPool()").query(
        "SELECT dec_sum(amount) AS balance FROM transactions WHERE account_id=$1 AND is_active",
        [accountId],
      );
      expect(persisted.rows).toEqual([{ balance: "0.0000" }]);
    });

    async function importFixture(accountId: number) {
      const pool = must(getTestPool(), "getTestPool()");
      const batchId = firstRow(
        await pool.query<{ id: number }>(
          "INSERT INTO import_batches(adapter_name,status) VALUES ('belfius','awaiting_review') RETURNING id",
        ),
      ).id;
      batches.push(batchId);
      const recipientId = firstRow(
        await pool.query<{ id: number }>(
          "INSERT INTO recipients(name,normalized_name) VALUES ($1,$1) RETURNING id",
          [`lifecycle-${crypto.randomUUID()}`],
        ),
      ).id;
      recipients.push(recipientId);
      await pool.query(
        `INSERT INTO import_staging_rows(batch_id,row_index,status,tx_date,bank_account,amount,currency,memo,resolved_recipient_id,dedup_fingerprint,dedup_fingerprint_version,dedup_occurrence)
      SELECT $1,0,'matched','2026-01-02',name,vision_numeric('25', 20, 4),'EUR','Lifecycle import',$3,$4,1,1 FROM accounts WHERE id=$2`,
        [
          batchId,
          accountId,
          recipientId,
          crypto.randomUUID().replaceAll("-", "").repeat(2),
        ],
      );
      return batchId;
    }

    it.each(["delete", "deactivate", "rollback", "import"] as const)(
      "rejects %s after waiting for a close, preserving its zero balance",
      async (operation) => {
        const { accountId, transactionId } = await fixture();
        const batchId = await importFixture(accountId);
        if (operation === "rollback") {
          await must(getTestPool(), "getTestPool()").query(
            "UPDATE transactions SET import_batch_id=$1 WHERE id=$2",
            [batchId, transactionId],
          );
        }
        const closed = deferred();
        const release = deferred();
        const closing = withTransaction(async () => {
          await closeAccount(asAccountId(accountId), { balance_handling: "adjustment" });
          closed.resolve();
          await release.promise;
        });
        await Promise.race([closed.promise, closing]);
        const writing =
          operation === "delete"
            ? bulkDeleteTransactions({ ids: [transactionId] })
            : operation === "deactivate"
              ? bulkUpdateTransactions({
                  ids: [transactionId],
                  fields: { is_active: false },
                })
              : operation === "rollback"
                ? rollbackBatch(batchId)
                : commitBatch({ batchId });
        const observed = Promise.allSettled([writing]);
        try {
          await waitForBlockedLedgerWrite();
        } finally {
          release.resolve();
        }
        await closing;
        expect(await observed).toMatchObject([{ status: "rejected" }]);
        const persisted = await must(getTestPool(), "getTestPool()").query(
          "SELECT a.is_active, COALESCE(dec_sum(t.amount) FILTER (WHERE t.is_active),0) AS balance, COUNT(t.id) AS count FROM accounts a LEFT JOIN transactions t ON t.account_id=a.id WHERE a.id=$1 GROUP BY a.id",
          [accountId],
        );
        expect(persisted.rows).toEqual([
          { is_active: false, balance: "0.0000", count: 2 },
        ]);
        const original = await must(getTestPool(), "getTestPool()").query(
          "SELECT is_active, amount FROM transactions WHERE id=$1",
          [transactionId],
        );
        expect(original.rows).toEqual([
          { is_active: true, amount: "100.0000" },
        ]);
      },
    );

    it.each(["delete", "deactivate", "import"] as const)(
      "close waits for an admitted %s and accounts for its committed balance",
      async (operation) => {
        const { accountId, transactionId } = await fixture();
        const batchId = await importFixture(accountId);
        const written = deferred();
        const release = deferred();
        const writing = withTransaction(async () => {
          if (operation === "delete")
            await bulkDeleteTransactions({ ids: [transactionId] });
          else if (operation === "deactivate")
            await bulkUpdateTransactions({
              ids: [transactionId],
              fields: { is_active: false },
            });
          else expect((await commitBatch({ batchId })).imported).toBe(1);
          written.resolve();
          await release.promise;
        });
        await Promise.race([written.promise, writing]);
        const closing = closeAccount(asAccountId(accountId), {
          balance_handling: "adjustment",
        });
        const observed = Promise.allSettled([closing]);
        try {
          await waitForBlockedLedgerWrite();
        } finally {
          release.resolve();
        }
        await writing;
        expect(await observed).toMatchObject([{ status: "fulfilled" }]);
        const persisted = await must(getTestPool(), "getTestPool()").query<{ is_active: boolean; balance: string }>(
          "SELECT a.is_active, COALESCE(dec_sum(t.amount) FILTER (WHERE t.is_active),0) AS balance FROM accounts a LEFT JOIN transactions t ON t.account_id=a.id WHERE a.id=$1 GROUP BY a.id",
          [accountId],
        );
        expect(must(persisted.rows[0], "row").is_active).toBe(false);
        expect(Number(must(persisted.rows[0], "row").balance)).toBe(0);
        const adjustments = await must(getTestPool(), "getTestPool()").query(
          "SELECT amount FROM transactions WHERE account_id=$1 AND transfer_source='adjustment'",
          [accountId],
        );
        expect(adjustments.rows).toEqual(
          operation === "import" ? [{ amount: "-125.0000" }] : [],
        );
      },
    );
  },
);
