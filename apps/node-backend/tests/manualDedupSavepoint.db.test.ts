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
} from "./setup/db.ts";
import { closePool, withTransaction } from "../src/database/connection.ts";
import {
  isManualDuplicate,
  recordManualTransactionDedupClaim,
} from "../src/services/deduplication.ts";
import { accountRepository } from "../src/repositories/accountRepository.ts";

vi.mock("../src/services/plannedMatchService.ts", () => ({
  autoLinkTransactions: vi.fn().mockResolvedValue({
    autoLinkedCount: 0,
    links: [],
  }),
}));
vi.mock("../src/services/transferReconciliationService.ts", () => ({
  scheduleReconcile: vi.fn(),
  getTransferSuggestions: vi.fn(),
  markTransfer: vi.fn(),
  unmarkTransfer: vi.fn(),
}));

const { default: transactionService } =
  await import("../src/services/transactionService.ts");

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
    const pool = getTestPool()!;
    await pool.query(
      `DELETE FROM manual_transaction_dedup_claims m
        USING transactions t
        WHERE m.transaction_id = t.id
          AND t.account_id IN (SELECT id FROM accounts
            WHERE lower(btrim(name)) = 'mixed representation account')`,
    );
    await pool.query(
      `DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts
         WHERE lower(btrim(name)) = 'mixed representation account')`,
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

  it("serializes concurrent canonical-account creates", async () => {
    const pool = getTestPool()!;
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
        account_id: accountId,
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

  it("validates claim fields after edits and separates currency identities", async () => {
    const accountId = await accountRepository.resolveOrCreateByName(
      "Mixed Representation Account",
    );
    const input = {
      transaction_date: "1901-01-02",
      account_id: accountId,
      amount: -50,
      memo: "mixed representation lock probe",
      currency: "EUR",
    };
    const first = await transactionService.createManualTransaction(input);
    await transactionService.update(first.transaction.id, { amount: -60 });
    const second = await transactionService.createManualTransaction(input);
    expect(second.transaction.id).not.toBe(first.transaction.id);
    const foreign = await transactionService.createManualTransaction({
      ...input,
      currency: "USD",
    });
    expect(foreign.transaction.currency).toBe("USD");
    await expect(
      transactionService.createManualTransaction(input),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      transactionService.createManualTransaction({ ...input, currency: "USD" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("recognizes existing rows without a current-version claim", async () => {
    const accountId = await accountRepository.resolveOrCreateByName(
      "Mixed Representation Account",
    );
    const input = {
      transaction_date: "1901-01-02",
      account_id: accountId,
      amount: -50,
      memo: "mixed representation lock probe",
      currency: "USD",
    };
    const first = await transactionService.createManualTransaction(input);
    await getTestPool()!.query(
      "UPDATE manual_transaction_dedup_claims SET deduplication_hash = $1 WHERE transaction_id = $2",
      ["legacy-v2-claim", first.transaction.id],
    );
    await expect(
      transactionService.createManualTransaction(input),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      transactionService.createManualTransaction({ ...input, currency: "EUR" }),
    ).resolves.toHaveProperty("transaction.currency", "EUR");
  });

  it("serializes equivalent amount/memo encodings, including absent recipients", async () => {
    const accountId = await accountRepository.resolveOrCreateByName(
      "Mixed Representation Account",
    );
    const input = {
      transaction_date: "1901-01-02",
      account_id: accountId,
      amount: -50,
      memo: "mixed representation lock probe",
      currency: "EUR",
    };
    const results = await Promise.allSettled([
      transactionService.createManualTransaction(input),
      transactionService.createManualTransaction({
        ...input,
        amount: "-50.00",
        memo: input.memo.toUpperCase(),
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toMatchObject([{ reason: { code: "CONFLICT" } }]);
  });

  it.each(["\t", "\n\r", "\u00a0", "\u2003", "\u2028\u2029", "\ufeff"])(
    "rejects duplicate live memos padded by %j with and without a versioned claim",
    async (padding) => {
      const accountId = await accountRepository.resolveOrCreateByName(
        "Mixed Representation Account",
      );
      const input = {
        transaction_date: "1901-01-02",
        account_id: accountId,
        amount: -50,
        memo: `${padding}mixed representation lock probe${padding}`,
        currency: "EUR",
      };
      const first = await transactionService.createManualTransaction(input);
      await expect(
        transactionService.createManualTransaction(input),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await getTestPool()!.query(
        "DELETE FROM manual_transaction_dedup_claims WHERE transaction_id = $1",
        [first.transaction.id],
      );
      await expect(
        transactionService.createManualTransaction({
          ...input,
          memo: "MIXED REPRESENTATION LOCK PROBE",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const { rows } = await getTestPool()!.query(
        "SELECT count(*)::integer AS count FROM transactions WHERE account_id = $1",
        [accountId],
      );
      expect(rows[0].count).toBe(1);
    },
  );

  it.each([
    ["1.00001", "1.00002", "1.0000"],
    ["-1.00005", "-1.0001", "-1.0001"],
  ])(
    "serializes amounts %s and %s that PostgreSQL stores identically",
    async (firstAmount, secondAmount, stored) => {
      const accountId = await accountRepository.resolveOrCreateByName(
        "Mixed Representation Account",
      );
      const input = {
        transaction_date: "1901-01-02",
        account_id: accountId,
        memo: "mixed representation lock probe",
        currency: "EUR",
      };
      const results = await Promise.allSettled([
        transactionService.createManualTransaction({
          ...input,
          amount: firstAmount,
        }),
        transactionService.createManualTransaction({
          ...input,
          amount: secondAmount,
        }),
      ]);
      expect(
        results.filter(({ status }) => status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter(({ status }) => status === "rejected"),
      ).toMatchObject([{ reason: { code: "CONFLICT" } }]);
      const { rows } = await getTestPool()!.query(
        "SELECT amount::text AS amount FROM transactions WHERE account_id = $1",
        [accountId],
      );
      expect(rows).toEqual([{ amount: stored }]);
    },
  );
});
