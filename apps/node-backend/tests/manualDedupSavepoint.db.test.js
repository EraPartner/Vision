/**
 * Real-PostgreSQL proof that rolling deployment without migration 0108 does
 * not poison the surrounding manual-create transaction. PostgreSQL marks a
 * transaction failed after 42P01, so this behavior cannot be represented by a
 * plain rejected-promise mock; the savepoint rollback is the contract.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { closePool, withTransaction } from "../src/database/connection.js";
import {
  isManualDuplicate,
  recordManualTransactionDedupClaim,
} from "../src/services/deduplication.js";
import { accountRepository } from "../src/repositories/accountRepository.js";

vi.mock("../src/services/plannedMatchService.js", () => ({
  autoLinkTransactions: vi.fn().mockResolvedValue({
    autoLinkedCount: 0,
    links: [],
  }),
}));
vi.mock("../src/services/transferReconciliationService.js", () => ({
  scheduleReconcile: vi.fn(),
  getTransferSuggestions: vi.fn(),
  markTransfer: vi.fn(),
  unmarkTransfer: vi.fn(),
}));

const { default: transactionService } =
  await import("../src/services/transactionService.js");

const describeDb = hasTestDatabase() ? describe : describe.skip;
const originalTable = "manual_transaction_dedup_claims";
const hiddenTable = "manual_transaction_dedup_claims_savepoint_test";

describeDb("manual dedup rolling-deployment savepoints (real DB)", () => {
  beforeAll(async () => {
    expect(
      process.env.DATABASE_URL,
      "DATABASE_URL must equal TEST_DATABASE_URL for this suite",
    ).toBe(process.env.TEST_DATABASE_URL);
    await acquireDbSuiteLock();
  }, 180_000);

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  afterEach(async () => {
    const pool = getTestPool();
    await pool.query(
      `DELETE FROM manual_transaction_dedup_claims m
        USING transactions t
        WHERE m.transaction_id = t.id
          AND t.memo = 'MIXED REPRESENTATION LOCK PROBE'`,
    );
    await pool.query(
      "DELETE FROM transactions WHERE memo = 'MIXED REPRESENTATION LOCK PROBE'",
    );
    await pool.query(
      "DELETE FROM recipients WHERE normalized_name = 'mixed representation recipient'",
    );
    await pool.query(
      "DELETE FROM accounts WHERE lower(btrim(name)) = 'mixed representation account'",
    );
  });

  it("recovers from missing claim-table reads and writes inside one transaction", async () => {
    await withTransaction(async (client) => {
      await client.query(
        `ALTER TABLE ${originalTable} RENAME TO ${hiddenTable}`,
      );
      try {
        await expect(
          isManualDuplicate({
            date: "1901-01-01",
            amount: -987654.32,
            recipientId: -1,
            memo: "savepoint compatibility probe",
            accountId: -1,
          }),
        ).resolves.toEqual({
          isDuplicate: false,
          existingTransactionId: null,
        });

        await expect(
          recordManualTransactionDedupClaim({
            date: "1901-01-01",
            amount: -987654.32,
            recipientId: -1,
            memo: "savepoint compatibility probe",
            accountId: -1,
            transactionId: -1,
          }),
        ).resolves.toBeUndefined();

        await expect(client.query("SELECT 1 AS usable")).resolves.toMatchObject(
          {
            rows: [{ usable: 1 }],
          },
        );
      } finally {
        await client.query(
          `ALTER TABLE ${hiddenTable} RENAME TO ${originalTable}`,
        );
      }
    });
  });

  it("serializes concurrent legacy-label and canonical-id creates", async () => {
    const pool = getTestPool();
    const { rows: recipientRows } = await pool.query(
      `INSERT INTO recipients (name, normalized_name)
       VALUES ('Mixed Representation Recipient', 'mixed representation recipient')
       RETURNING id`,
    );
    const accountId = await accountRepository.resolveOrCreateByName(
      "Mixed Representation Account",
    );
    const common = {
      transaction_date: "1901-01-02",
      recipient_id: recipientRows[0].id,
      amount: -987653.21,
      memo: "mixed representation lock probe",
      currency: "EUR",
    };

    const results = await Promise.allSettled([
      transactionService.createManualTransaction({
        ...common,
        bank_account: "Mixed Representation Account",
      }),
      transactionService.createManualTransaction({
        ...common,
        account_id: accountId,
      }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "CONFLICT" }),
    });
    const { rows } = await pool.query(
      `SELECT count(*)::integer AS count
         FROM transactions
        WHERE memo = 'MIXED REPRESENTATION LOCK PROBE'`,
    );
    expect(rows[0].count).toBe(1);
  });
});
