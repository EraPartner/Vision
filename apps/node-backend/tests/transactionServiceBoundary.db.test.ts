/**
 * Real-PostgreSQL behaviour of the transaction service's manual-create and
 * PATCH paths, plus the uncategorised bulk selection. Replaces
 * services/transactionService.test.ts (eleven mocked collaborators and
 * call-order assertions) and the SQL-text cases of
 * services/bulkSelectionFilter.test.ts.
 *
 * Planned-payment auto-linking and the background transfer reconcile are
 * stubbed exactly as manualDedupSavepoint.db.test.ts does: they are separate
 * features with their own DB suites, and the reconcile runs detached.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { accountRepository } from "../src/repositories/accountRepository.ts";
import { createCategoryNode } from "../src/repositories/categoryHierarchyRepository.ts";
import recipientRepository from "../src/repositories/recipientRepository.ts";
import { resolveBulkSelection } from "../src/services/bulkSelection.ts";

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

const MARK = `txsvc${process.pid}`;
const ACCOUNT = `TXSVC ACCOUNT ${process.pid}`;
const created = { categoryIds: [] as number[], recipientIds: [] as number[] };

async function insertRecipient(
  name: string,
  defaultCategoryId: number | null = null,
  primaryId: number | null = null,
): Promise<number> {
  const { rows } = await getTestPool()!.query(
    `INSERT INTO recipients (name, normalized_name, default_category_id, primary_recipient_id)
     VALUES (upper($1), lower($1), $2, $3) RETURNING id`,
    [name, defaultCategoryId, primaryId],
  );
  created.recipientIds.push(rows[0].id);
  return rows[0].id;
}

describe.skipIf(!hasTestDatabase())("transaction service (real DB)", () => {
  let accountId: number;
  let shopId: number;
  let categoryId: number;

  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
    await acquireDbSuiteLock();
    accountId = (await accountRepository.resolveOrCreateByName(ACCOUNT))!;
    const root = await createCategoryNode({ name: `FOOD${MARK}` });
    const leaf = await createCategoryNode({
      name: "GROCERIES",
      parentId: root!.id,
    });
    created.categoryIds.push(root!.id, leaf!.id);
    categoryId = leaf!.id;
    shopId = await insertRecipient(`shop ${MARK}`);
  }, 180_000);

  afterAll(async () => {
    try {
      const db = getTestPool()!;
      await db.query(
        `DELETE FROM manual_transaction_dedup_claims m USING transactions t
          WHERE m.transaction_id = t.id AND t.account_id = $1`,
        [accountId],
      );
      await db.query("DELETE FROM transactions WHERE account_id = $1", [
        accountId,
      ]);
      await db.query("DELETE FROM accounts WHERE id = $1", [accountId]);
      await db.query(
        "UPDATE recipients SET primary_recipient_id = NULL WHERE id = ANY($1)",
        [created.recipientIds],
      );
      await db.query("DELETE FROM recipients WHERE id = ANY($1)", [
        created.recipientIds,
      ]);
      for (const id of [...created.categoryIds].reverse()) {
        await db.query("DELETE FROM categories WHERE id = $1", [id]);
      }
    } finally {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    }
  });

  it("blocks a matching manual transaction unless the duplicate is explicitly allowed", async () => {
    const input = {
      transaction_date: "1902-03-04",
      account_id: accountId,
      recipient_id: shopId,
      amount: -12.5,
      memo: `${MARK} duplicate probe`,
    };
    const first = await transactionService.createManualTransaction(input);
    await expect(
      transactionService.createManualTransaction(input),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Duplicate transaction detected",
    });
    const second = await transactionService.createManualTransaction({
      ...input,
      allow_duplicate: true,
    });
    expect(second.transaction.id).not.toBe(first.transaction.id);
    const { rows } = await getTestPool()!.query(
      "SELECT count(*)::int AS n FROM transactions WHERE account_id = $1 AND date = '1902-03-04'",
      [accountId],
    );
    expect(rows[0].n).toBe(2);
  });

  it("resolves PATCH recipient and category names and keeps explicit ids", async () => {
    const { transaction } = await transactionService.createManualTransaction({
      transaction_date: "1902-03-05",
      account_id: accountId,
      recipient_id: shopId,
      amount: -3,
      memo: `${MARK} patch probe`,
    });
    const other = await recipientRepository.createOrGet({
      name: `other ${MARK}`,
    });
    const otherId = other.recipient!.id;
    created.recipientIds.push(otherId);

    const renamed = await transactionService.update(transaction.id, {
      recipient_name: `Other ${MARK}`,
      category_name: `FOOD${MARK}:GROCERIES`,
      comment: "weekly",
    });
    expect(renamed).toMatchObject({
      id: transaction.id,
      recipient_id: otherId,
      category_id: categoryId,
      comment: "weekly",
    });

    const explicit = await transactionService.update(transaction.id, {
      recipient_id: shopId,
      recipient_name: `Other ${MARK}`,
      category_id: null,
    });
    expect(explicit).toMatchObject({ recipient_id: shopId, category_id: null });

    await expect(
      transactionService.update(transaction.id, {
        recipient_name: `missing ${MARK}`,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(
      await transactionService.update(2_000_000_000, { memo: "missing" }),
    ).toBeNull();
  });

  it("selects only rows with no three-level effective category for the uncategorised bulk filter", async () => {
    const primary = await insertRecipient(`primary ${MARK}`, categoryId);
    const alias = await insertRecipient(`alias ${MARK}`, null, primary);
    const plain = await insertRecipient(`plain ${MARK}`);
    const insert = async (recipientId: number, ownCategory: number | null) => {
      const { rows } = await getTestPool()!.query(
        `INSERT INTO transactions (date, amount, currency, recipient_id, category_id, account_id, memo)
         VALUES ('1902-04-01', '-1.0000', 'EUR', $1, $2, $3, $4) RETURNING id`,
        [recipientId, ownCategory, accountId, `${MARK} bulk`],
      );
      return rows[0].id as number;
    };
    await insert(primary, null); // category via recipient default
    await insert(alias, null); // category via the PRIMARY's default
    await insert(plain, categoryId); // own category
    const uncategorised = await insert(plain, null);

    expect(
      await resolveBulkSelection({
        filter: { uncategorised: true, search: `${MARK} bulk` },
      }),
    ).toEqual([uncategorised]);
    expect(
      await resolveBulkSelection({
        filter: { uncategorised: false, search: `${MARK} bulk` },
      }),
    ).toHaveLength(4);
  });
});
