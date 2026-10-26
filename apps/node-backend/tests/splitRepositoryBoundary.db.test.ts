/**
 * Real-PostgreSQL wire shape of split reads and writes. Replaces the
 * mocked-pool splitRepository.test.ts, which choreographed query order and
 * asserted SQL fragments (LATERAL joins, CTE names): here the same outcomes —
 * real amount_paid / recipient_name on settle and getById, one payment shape
 * for POST and GET, remaining = amount - paid, opt-in pagination — are read
 * back from a migrated schema.
 *
 * Isolation: fixtures carry a per-process marker; afterAll deletes the
 * transactions (splits and payments cascade) and the recipient.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import splitPersistence from "../src/repositories/splitRepository.ts";
import splitService from "../src/services/splitService.ts";
import {
  asRecipientId,
  asSplitId,
  asTransactionId,
} from "@vision/types/brands";
import { must } from "./helpers/must.ts";
interface IdRow {
  id: number;
}

const splitRepository = { ...splitPersistence, ...splitService };
const MARK = `split_boundary_${process.pid}`;
const txIds: number[] = [];
let recipientId: number;
let payeeId: number;

async function insertTx(amount: string, date = "2026-03-01"): Promise<number> {
  const { rows } = await must(getTestPool(), "test pool").query<IdRow>(
    `INSERT INTO transactions (date, amount, memo, currency, recipient_id)
     VALUES ($1, $2, $3, 'EUR', $4) RETURNING id`,
    [date, amount, MARK, payeeId],
  );
  txIds.push(must(rows[0], "rows[0]").id);
  return must(rows[0], "rows[0]").id;
}

describe.skipIf(!hasTestDatabase())("split reads and writes (real DB)", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
    await acquireDbSuiteLock();
    const pool = must(getTestPool(), "test pool");
    const owes = await pool.query<IdRow>(
      `INSERT INTO recipients (name, normalized_name) VALUES ($1, $1) RETURNING id`,
      [`${MARK}_alice`],
    );
    recipientId = must(owes.rows[0], "owes.rows[0]").id;
    const payee = await pool.query<IdRow>(
      `INSERT INTO recipients (name, normalized_name) VALUES ($1, $1) RETURNING id`,
      [`${MARK}_shop`],
    );
    payeeId = must(payee.rows[0], "payee.rows[0]").id;
  }, 180_000);

  afterAll(async () => {
    try {
      const pool = getTestPool();
      if (pool) {
        if (txIds.length > 0)
          await pool.query("DELETE FROM transactions WHERE id = ANY($1)", [
            txIds,
          ]);
        await pool.query("DELETE FROM recipients WHERE normalized_name LIKE $1", [
          `${MARK}%`,
        ]);
      }
    } finally {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    }
  });

  it("returns one numeric payment shape from addPayment and getPayments", async () => {
    const txId = await insertTx("-60.0000");
    const split = await splitRepository.createSplitAtomic({
      transaction_id: asTransactionId(txId),
      recipient_id: asRecipientId(recipientId),
      amount: 30,
      note: null,
    });
    expect(split).toMatchObject({
      amount: 30,
      amount_paid: 0,
      recipient_name: `${MARK}_alice`,
    });
    expect(split).not.toHaveProperty("paid_amount");

    const posted = await splitRepository.addPayment({
      split_id: split.id,
      amount: 12.5,
      paid_at: "2026-03-04",
    });
    expect(posted).toMatchObject({ amount: 12.5, paid_at: "2026-03-04" });
    const [fetched] = await splitRepository.getPayments(split.id);
    expect(posted).toEqual(fetched);

    const [owed] = (await splitRepository.getOwedByRecipient(asRecipientId(recipientId))).filter(
      (row) => row.id === split.id,
    );
    expect(owed).toMatchObject({ amount: 30, amount_paid: 12.5, remaining: 17.5 });

    const exportRows = await splitRepository.getOwedExportRowsByRecipient(
      asRecipientId(recipientId),
    );
    expect(exportRows.map((row) => row.amount)).toContain(17.5);
  });

  it("settle and getById report the real paid total and recipient name", async () => {
    const txId = await insertTx("-30.0000");
    const split = await splitRepository.createSplitAtomic({
      transaction_id: asTransactionId(txId),
      recipient_id: asRecipientId(recipientId),
      amount: 30,
      note: "dinner",
    });
    await splitRepository.addPayment({ split_id: split.id, amount: 10 });

    expect(await splitRepository.getSplitById(split.id)).toMatchObject({
      amount: 30,
      amount_paid: 10,
      recipient_name: `${MARK}_alice`,
      note: "dinner",
      is_settled: false,
    });
    const settled = await splitPersistence.settleSplit(split.id);
    expect(settled).toMatchObject({
      amount: 30,
      amount_paid: 10,
      recipient_name: `${MARK}_alice`,
      is_settled: true,
    });
    expect(await splitPersistence.settleSplit(asSplitId(2_000_000_000))).toBeNull();
  });

  it("returns formatted rows for every split a batch creates", async () => {
    const txId = await insertTx("-30.0000");
    const created = await splitRepository.createSplitsBatchAtomic({
      transaction_id: asTransactionId(txId),
      splits: [
        { recipient_id: asRecipientId(recipientId), amount: 20 },
        { recipient_id: asRecipientId(payeeId), amount: 10, note: "half" },
      ],
    });
    expect(created.map((s) => s.amount)).toEqual([20, 10]);
    expect(created.map((s) => s.recipient_name)).toEqual([
      `${MARK}_alice`,
      `${MARK}_shop`,
    ]);
    expect(created.every((s) => s.amount_paid === 0)).toBe(true);
  });

  it("pages only when asked and counts as numbers", async () => {
    const txId = await insertTx("-90.0000", "2026-03-02");
    for (const amount of [10, 20, 30]) {
      await splitRepository.createSplitAtomic({
        transaction_id: asTransactionId(txId),
        recipient_id: asRecipientId(recipientId),
        amount,
        note: null,
      });
    }
    const all = await splitRepository.getSplitsByTransaction(asTransactionId(txId));
    expect(all.map((s) => s.amount)).toEqual([10, 20, 30]);
    expect(
      (
        await splitRepository.getSplitsByTransaction(asTransactionId(txId), {
          limit: 1,
          offset: 1,
        })
      ).map((s) => s.amount),
    ).toEqual([20]);
    expect(await splitRepository.countSplitsByTransaction(asTransactionId(txId))).toBe(3);

    const owedTotal = await splitRepository.countOwedByRecipient(asRecipientId(recipientId));
    expect(typeof owedTotal).toBe("number");
    expect(
      await splitRepository.getOwedByRecipient(asRecipientId(recipientId), { limit: 2 }),
    ).toHaveLength(Math.min(2, owedTotal));
    expect(await splitRepository.getOwedByRecipient(asRecipientId(recipientId))).toHaveLength(
      owedTotal,
    );

    const first = must(all[0], "all[0]");
    await splitRepository.addPayment({ split_id: first.id, amount: 1 });
    await splitRepository.addPayment({ split_id: first.id, amount: 2 });
    expect(await splitRepository.countPayments(first.id)).toBe(2);
    expect(
      await splitRepository.getPayments(first.id, { limit: 1 }),
    ).toHaveLength(1);
  });
});
