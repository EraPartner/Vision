import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool, withTransaction } from "../src/database/connection.ts";
import { closeAccount } from "../src/services/accountCloseService.ts";
import transactionRepository from "../src/repositories/transactionRepository.ts";
import { accountRepository } from "../src/repositories/accountRepository.ts";
import {
  bulkDeleteTransactions,
  bulkUpdateTransactions,
} from "../src/services/transactionBulkService.ts";
import { rollbackBatch } from "../src/repositories/importBatchRepository.ts";
import { commitBatch } from "../src/services/importPipeline/commit.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe.skipIf(!hasTestDatabase())(
  "account lifecycle locks (PostgreSQL)",
  () => {
    const accounts: number[] = [];
    const batches: number[] = [];
    const recipients: number[] = [];
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180_000);
    afterEach(async () => {
      await getTestPool()!.query(
        "DELETE FROM transactions WHERE account_id = ANY($1::int[])",
        [accounts],
      );
      await getTestPool()!.query(
        "DELETE FROM import_staging_rows WHERE batch_id = ANY($1::bigint[])",
        [batches],
      );
      await getTestPool()!.query(
        "DELETE FROM import_batches WHERE id = ANY($1::bigint[])",
        [batches.splice(0)],
      );
      await getTestPool()!.query(
        "DELETE FROM recipients WHERE id = ANY($1::int[])",
        [recipients.splice(0)],
      );
      await getTestPool()!.query(
        "DELETE FROM accounts WHERE id = ANY($1::int[])",
        [accounts.splice(0)],
      );
    });
    afterAll(async () => {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    });
    async function fixture() {
      const pool = getTestPool()!;
      const result = await pool.query(
        "INSERT INTO accounts (name) VALUES ($1) RETURNING id",
        [`lifecycle-${crypto.randomUUID()}`],
      );
      const accountId = result.rows[0].id as number;
      accounts.push(accountId);
      const name = `lifecycle-recipient-${crypto.randomUUID()}`;
      const recipientId = (
        await pool.query(
          "INSERT INTO recipients(name,normalized_name) VALUES ($1,$1) RETURNING id",
          [name],
        )
      ).rows[0].id as number;
      recipients.push(recipientId);
      const transaction = await pool.query(
        "INSERT INTO transactions (date, amount, currency, account_id, recipient_id) VALUES ('2026-01-01', 100, 'EUR', $1, $2) RETURNING id",
        [accountId, recipientId],
      );
      return {
        accountId,
        recipientId,
        transactionId: transaction.rows[0].id as number,
      };
    }
    async function waitForBlockedLedgerWrite() {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const { rows } = await getTestPool()!.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%accounts%'",
        );
        if (rows[0].n > 0) return;
        await new Promise((done) => setTimeout(done, 10));
      }
      throw new Error("Expected an account lock waiter");
    }
    it("rejects an edit after a concurrent close commits", async () => {
      const { accountId, transactionId } = await fixture();
      const closed = deferred();
      const release = deferred();
      const closing = withTransaction(async () => {
        await closeAccount(accountId, { balance_handling: "adjustment" });
        closed.resolve();
        await release.promise;
      });
      await Promise.race([closed.promise, closing]);
      const editing = transactionRepository.update(transactionId, {
        amount: 150,
      });
      const outcome = editing.then(
        () => "unexpected success",
        (error: Error) => error.message,
      );
      try {
        await waitForBlockedLedgerWrite();
      } finally {
        release.resolve();
      }
      await closing;
      expect(await outcome).toContain("Reopen the account");
      const { rows } = await getTestPool()!.query(
        "SELECT SUM(amount)::numeric AS balance FROM transactions WHERE account_id=$1",
        [accountId],
      );
      expect(Number(rows[0].balance)).toBe(0);
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
          "INSERT INTO transactions (date, amount, currency, account_id, recipient_id) VALUES ('2026-01-02', 25, 'EUR', $1, $2)",
          [accountId, recipientId],
        );
        written.resolve();
        await release.promise;
      });
      await Promise.race([written.promise, writing]);
      const closing = closeAccount(accountId, {
        balance_handling: "adjustment",
      });
      try {
        await waitForBlockedLedgerWrite();
      } finally {
        release.resolve();
      }
      await writing;
      await closing;
      const { rows } = await getTestPool()!.query(
        "SELECT SUM(amount)::numeric AS balance FROM transactions WHERE account_id=$1",
        [accountId],
      );
      expect(Number(rows[0].balance)).toBe(0);
    });

    async function importFixture(accountId: number) {
      const pool = getTestPool()!;
      const batchId = Number(
        (
          await pool.query(
            "INSERT INTO import_batches(adapter_name,status) VALUES ('belfius','awaiting_review') RETURNING id",
          )
        ).rows[0].id,
      );
      batches.push(batchId);
      const recipientId = (
        await pool.query(
          "INSERT INTO recipients(name,normalized_name) VALUES ($1,$1) RETURNING id",
          [`lifecycle-${crypto.randomUUID()}`],
        )
      ).rows[0].id as number;
      recipients.push(recipientId);
      await pool.query(
        `INSERT INTO import_staging_rows(batch_id,row_index,status,tx_date,bank_account,amount,currency,memo,resolved_recipient_id,dedup_fingerprint,dedup_fingerprint_version,dedup_occurrence)
      SELECT $1,0,'matched','2026-01-02',name,25,'EUR','Lifecycle import',$3,$4,1,1 FROM accounts WHERE id=$2`,
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
          await getTestPool()!.query(
            "UPDATE transactions SET import_batch_id=$1 WHERE id=$2",
            [batchId, transactionId],
          );
        }
        const closed = deferred();
        const release = deferred();
        const closing = withTransaction(async () => {
          await closeAccount(accountId, { balance_handling: "adjustment" });
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
        const persisted = await getTestPool()!.query(
          "SELECT a.is_active, COALESCE(SUM(t.amount) FILTER (WHERE t.is_active),0)::numeric AS balance, COUNT(t.id)::int AS count FROM accounts a LEFT JOIN transactions t ON t.account_id=a.id WHERE a.id=$1 GROUP BY a.id",
          [accountId],
        );
        expect(persisted.rows).toEqual([
          { is_active: false, balance: "0.0000", count: 2 },
        ]);
        const original = await getTestPool()!.query(
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
        const closing = closeAccount(accountId, {
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
        const persisted = await getTestPool()!.query(
          "SELECT a.is_active, COALESCE(SUM(t.amount) FILTER (WHERE t.is_active),0)::numeric AS balance FROM accounts a LEFT JOIN transactions t ON t.account_id=a.id WHERE a.id=$1 GROUP BY a.id",
          [accountId],
        );
        expect(persisted.rows[0].is_active).toBe(false);
        expect(Number(persisted.rows[0].balance)).toBe(0);
        const adjustments = await getTestPool()!.query(
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
