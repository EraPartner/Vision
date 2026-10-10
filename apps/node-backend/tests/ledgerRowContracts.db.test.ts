/**
 * Real-Postgres coverage for ledger row contracts (ADR-193) that no other DB
 * suite runs: bulk tagging, filter-mode bulk selection, the bulk export
 * snapshot, planned-transaction tags, batch split creation and the account
 * close adjustment. Each call below runs its query through the row schema in
 * `throw` mode, so a schema that disagrees with what node-postgres returns
 * fails here with a RowContractError.
 *
 * Isolation: targeted per-test DELETEs of the rows this suite seeds (same
 * reasoning as transferReconciliation.db.test.ts: the services open their own
 * transactions).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { bulkTagTransactions } from "../src/services/transactionBulkService.ts";
import { resolveBulkSelection } from "../src/services/bulkSelection.ts";
import { streamBulkTransactionExport } from "../src/services/transactionExport.ts";
import { create as createPlanned } from "../src/services/plannedTransactionService.ts";
import splitService from "../src/services/splitService.ts";
import {
  closeAccount,
  previewAccountPortfolioLots,
} from "../src/services/accountCloseService.ts";
import { loose } from "./helpers/partial.ts";
import type { ExpressResponse } from "../src/types/express.ts";

const MEMO = "LEDGER ROW CONTRACT FIXTURE";

let recipientId: number;
let otherRecipientId: number;
let accountId: number;
const txIds: number[] = [];

async function seed() {
  const pool = getTestPool()!;
  const rec = await pool.query(
    `INSERT INTO recipients (name, normalized_name)
     VALUES ('Ledger Contract A', 'ledger contract a'), ('Ledger Contract B', 'ledger contract b')
     RETURNING id`,
  );
  recipientId = rec.rows[0].id;
  otherRecipientId = rec.rows[1].id;
  const acct = await pool.query(
    `INSERT INTO accounts (name, display_name) VALUES ('Ledger Contract', 'Ledger Contract')
     RETURNING id`,
  );
  accountId = acct.rows[0].id;
  const tx = await pool.query(
    `INSERT INTO transactions (date, amount, currency, memo, account_id, recipient_id, is_active)
     VALUES ('2024-03-01', -40.25, 'EUR', $1, $2, $3, true),
            ('2024-03-02', 12.5, 'EUR', $1, $2, $3, true)
     RETURNING id`,
    [MEMO, accountId, recipientId],
  );
  txIds.splice(0, txIds.length, ...tx.rows.map((r: { id: number }) => r.id));
  await pool.query(
    `INSERT INTO tags (slug, color) VALUES ('ledger-contract-a', '#112233'), ('ledger-contract-b', NULL)`,
  );
}

async function wipe() {
  const pool = getTestPool()!;
  await pool.query(`DELETE FROM planned_transactions WHERE memo = $1`, [MEMO]);
  await pool.query(
    `DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE name = 'Ledger Contract')`,
  );
  await pool.query(`DELETE FROM accounts WHERE name = 'Ledger Contract'`);
  await pool.query(
    `DELETE FROM recipients WHERE normalized_name IN ('ledger contract a', 'ledger contract b')`,
  );
  await pool.query(
    `DELETE FROM tags WHERE slug IN ('ledger-contract-a', 'ledger-contract-b')`,
  );
}

/** The response members the export stream touches. */
function fakeResponse() {
  const chunks: string[] = [];
  const headers: Record<string, string | number> = {};
  const res = {
    chunks,
    headers,
    headersSent: false,
    setHeader(name: string, value: string | number) {
      headers[name] = value;
    },
    write(chunk: string) {
      res.headersSent = true;
      chunks.push(chunk);
      return true;
    },
    end() {},
  };
  return loose<ExpressResponse & typeof res>(res);
}

describe.skipIf(!hasTestDatabase())("ledger row contracts (real DB)", () => {
  beforeAll(async () => {
    expect(
      process.env.DATABASE_URL,
      "DATABASE_URL must equal TEST_DATABASE_URL for this suite",
    ).toBe(process.env.TEST_DATABASE_URL);
    await acquireDbSuiteLock();
  }, 180_000);

  afterEach(async () => {
    await wipe();
  });

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it("bulk-tags and untags through the checked tag and junction rows", async () => {
    await seed();
    const added = await bulkTagTransactions({
      transactionIds: txIds,
      addSlugs: ["ledger-contract-a", "ledger-contract-b"],
      removeSlugs: [],
    });
    expect(added).toEqual({ added: 4, removed: 0, transactions_affected: 2 });

    const removed = await bulkTagTransactions({
      transactionIds: [txIds[0]],
      addSlugs: [],
      removeSlugs: ["ledger-contract-b"],
    });
    expect(removed).toEqual({ added: 0, removed: 1, transactions_affected: 1 });
  });

  it("resolves a filter-mode bulk selection through the checked count and id rows", async () => {
    await seed();
    const ids = await resolveBulkSelection({
      filter: { account_id: accountId },
    });
    expect(ids).toEqual([...txIds].sort((a, b) => a - b));
  });

  it("streams a bulk export through the checked count and chunk rows", async () => {
    await seed();
    await bulkTagTransactions({
      transactionIds: [txIds[0]],
      addSlugs: ["ledger-contract-a"],
      removeSlugs: [],
    });
    const res = fakeResponse();
    await streamBulkTransactionExport(res, { ids: txIds, format: "json" });

    expect(res.headers["X-Exported-Count"]).toBe("2");
    const lines = res.chunks.map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      date: "2024-03-01",
      amount: "-40.2500",
      tags: ["ledger-contract-a"],
    });
    expect(lines[1]).toMatchObject({ date: "2024-03-02", tags: [] });
  });

  it("creates a tagged planned transaction through the checked insert and tag rows", async () => {
    await seed();
    const planned = await createPlanned({
      planned_date: "2024-04-01",
      account_id: accountId,
      recipient_id: recipientId,
      amount: -15,
      memo: MEMO,
      tags: ["ledger-contract-a"],
    });
    expect(planned?.tags.map((tag) => tag.slug)).toEqual(["ledger-contract-a"]);
  });

  it("creates a split batch through the checked totals, insert and audit rows", async () => {
    await seed();
    const splits = await splitService.createSplitsBatchAtomic({
      transaction_id: txIds[0]!,
      splits: [
        { recipient_id: otherRecipientId, amount: 20 },
        { recipient_id: recipientId, amount: "10.25", note: "half" },
      ],
    });
    expect(splits.map((split) => [split.amount, split.amount_paid])).toEqual([
      [20, 0],
      [10.25, 0],
    ]);
    expect(splits.map((split) => split.recipient_name)).toEqual([
      "Ledger Contract B",
      "Ledger Contract A",
    ]);
  });

  it("closes an account with an adjustment through the checked lock, balance and insert rows", async () => {
    await seed();
    await expect(previewAccountPortfolioLots(accountId)).resolves.toMatchObject(
      { eligible_count: 0, transaction_ids: [] },
    );

    const result = await closeAccount(accountId, {
      balance_handling: "adjustment",
    });
    expect(result.already_closed).toBe(false);
    // -40.25 + 12.50 = -27.75, zeroed by a +27.75 adjustment.
    expect(result.adjustments).toEqual([
      expect.objectContaining({
        currency: "EUR",
        amount: 27.75,
        transfer_source: "adjustment",
      }),
    ]);

    const again = await closeAccount(accountId, {
      balance_handling: "adjustment",
    });
    expect(again.already_closed).toBe(true);
  });
});
