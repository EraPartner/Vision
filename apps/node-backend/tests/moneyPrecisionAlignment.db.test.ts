/**
 * Real-database pins for migration 0088 (ADR-060 D7): NUMERIC(18,4) is the domain
 * precision for money columns, and every surviving (15,2) sibling of
 * transactions.amount is aligned to it. Later guarded contracts retired the
 * provider raw tables and accounts.statement_balance.
 *
 * What only a real database can verify here:
 *   1. The widened types themselves (the declared DECIMAL_TEXT(18,4) column types
 *      and their canonical-text CHECK, PostgreSQL's numeric(18,4) since ADR-263)
 *      — the whole point of the migration, and the assertion that catches an
 *      incomplete inventory or a re-narrowing regression.
 *   2. The finding's failure case, now possible: a 4-decimal transaction split
 *      EXACTLY into 4-decimal parts, with genuine decimal equality
 *      (dec_sum(splits) = dec_abs(amount), no 0.005-tolerance masking), surviving
 *      the 0019 sync-trigger path into agg_split_outstanding — whose locals
 *      0088 re-declared at (18,4) precisely so this stops rounding to cents.
 *   3. The 0062 split-guard trigger still guards after the retype.
 *   4. Planned→executed copies are precision-symmetric: a 4-dp planned amount
 *      round-trips into transactions.amount and compares equal in SQL.
 *   5. The repository guards moved to storage precision with the columns:
 *      sub-cent over-payment / over-allocation are REJECTED (pre-0088 they were
 *      admitted-then-rounded-away by (15,2) storage; with (18,4) storage a
 *      cent-precision cap would store the overshoot), auto-settle fires only on
 *      an exact 4-dp cover, and a settled split takes no further payments.
 *
 * Isolation: fixtures carry a unique memo/name marker; afterAll deletes only what
 * this suite created (transactions cascade to splits → payments → agg rows).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  getTestPool,
} from "./setup/db.ts";
import splitPersistence from "../src/repositories/splitRepository.ts";
import splitService from "../src/services/splitService.ts";
import { closePool } from "../src/database/connection.ts";
import {
  asRecipientId, type PlannedTransactionId, type RecipientId, type SplitId, type TransactionId } from "@vision/types/brands";
import { must } from "./helpers/must.ts";
import { stringMatching } from "./helpers/matchers.ts";

/** A result row whose columns the test reads without a fixed shape. */
type DbRow = Record<string, unknown>;

const pool = () => getTestPool();
const describeDb = describe;
const splitRepository = { ...splitPersistence, ...splitService };

const MARK = `_0088_precision_${process.pid}`;

/**
 * Surviving MONEY_COLUMNS from migration 0088. The guarded raw-provider and
 * statement-scalar contracts removed the omitted tables/column afterward.
 */
const WIDENED = [
  ["transactions", "balance"],
  ["planned_transactions", "amount"],
  ["planned_transactions", "loan_principal"],
  ["planned_transactions", "loan_regular_payment_amount"],
  ["planned_transaction_loan_schedule", "payment_amount"],
  ["planned_transaction_loan_schedule", "principal_amount"],
  ["planned_transaction_loan_schedule", "interest_amount"],
  ["planned_transaction_loan_schedule", "remaining_principal"],
  ["transaction_splits", "amount"],
  ["split_payments", "amount"],
  ["agg_split_outstanding", "original_amount"],
  ["agg_split_outstanding", "paid_amount"],
  ["agg_split_outstanding", "outstanding_amount"],
];

describeDb("migration 0088: money columns aligned to NUMERIC(18,4)", () => {
  let recipientId: number | undefined;
  const txIds: number[] = [];
  const plannedIds: number[] = [];

  beforeAll(async () => {
    const { rows } = await pool().query<{ id: RecipientId }>(
      `INSERT INTO recipients (name, normalized_name) VALUES ($1, $1) RETURNING id`,
      [MARK],
    );
    recipientId = must(rows[0], "rows[0]").id;
  }, 180_000);

  afterAll(async () => {
    // transactions → transaction_splits → split_payments / agg_split_outstanding
    // all cascade; planned rows and the recipient are deleted directly.
    if (txIds.length > 0)
      await pool().query<DbRow>(
        `DELETE FROM transactions WHERE id IN (SELECT value FROM json_each($1))`,
        [JSON.stringify(txIds)],
      );
    if (plannedIds.length > 0) {
      await pool().query(
        `DELETE FROM planned_transactions WHERE id IN (SELECT value FROM json_each($1))`,
        [JSON.stringify(plannedIds)],
      );
    }
    if (recipientId !== undefined)
      await pool().query<DbRow>(`DELETE FROM recipients WHERE id = $1`, [recipientId]);
    await closeTestPool();
    // The repository guards below go through the backend's own connections.
    await closePool();
  });

  async function insertTx(amount: string, balance: string | null = null) {
    const { rows } = await pool().query<{ id: TransactionId }>(
      `INSERT INTO transactions (date, amount, balance, memo, currency, recipient_id)
       VALUES ('2026-08-01', vision_numeric($1, 18, 4), vision_numeric($2, 18, 4), $3, 'EUR', $4) RETURNING id`,
      [amount, balance, MARK, recipientId],
    );
    txIds.push(must(rows[0], "rows[0]").id);
    return must(rows[0], "rows[0]").id;
  }

  /** Every table column with its declared type (SQLite's information_schema). */
  async function declaredColumns() {
    const { rows } = await pool().query<{
      table_name: string;
      column_name: string;
      type: string;
    }>(`
      SELECT m.name AS table_name, c.name AS column_name, c.type
      FROM sqlite_schema m, pragma_table_info(m.name) c
      WHERE m.type = 'table'
    `);
    return rows;
  }

  it("pins every D7 column at DECIMAL_TEXT(18,4) (numeric(18,4))", async () => {
    const rows = (await declaredColumns()).filter((r) => r.type === "DECIMAL_TEXT(18,4)");
    const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const missing = WIDENED.filter(([t, c]) => !have.has(`${t}.${c}`));
    expect(missing).toEqual([]);
    // 0025's original column kept its type; nothing regressed it.
    expect(have.has("transactions.amount")).toBe(true);
  });

  it("enforces the (18,4) canonical text on writes that bypass vision_numeric()", async () => {
    // A hand-written write of a 5-dp or 2-dp text is refused by the column's
    // CHECK, as PostgreSQL's numeric(18,4) would have rounded it; nothing can
    // store an off-scale value that a text comparison would then mis-order.
    for (const amount of ["1.00001", "-99.99", "1e2"]) {
      await expect(
        pool().query(
          `INSERT INTO transactions (date, amount, memo, currency, recipient_id)
           VALUES ('2026-08-01', $1, $2, 'EUR', $3)`,
          [amount, MARK, recipientId],
        ),
      ).rejects.toMatchObject({ code: "23514", constraint: "transactions_amount__vtype" });
    }
    // vision_numeric() rounds half away from zero to the column scale.
    const { rows } = await pool().query<DbRow>(
      `SELECT vision_numeric('1.00005', 18, 4) AS up, vision_numeric('-1.00005', 18, 4) AS down`,
    );
    expect(rows).toEqual([{ up: "1.0001", down: "-1.0001" }]);
  });

  it("leaves no numeric(15,2) money column behind, and import_staging_rows at (20,4)", async () => {
    const columns = await declaredColumns();
    expect(
      columns
        .filter((r) => r.type === "DECIMAL_TEXT(15,2)")
        .map((r) => `${r.table_name}.${r.column_name}`),
    ).toEqual([]);

    const staging = columns
      .filter(
        (r) =>
          r.table_name === "import_staging_rows" &&
          ["amount", "balance"].includes(r.column_name),
      )
      .map(({ column_name, type }) => ({ column_name, type }))
      .sort((a, b) => a.column_name.localeCompare(b.column_name));
    expect(staging).toEqual([
      { column_name: "amount", type: "DECIMAL_TEXT(20,4)" },
      { column_name: "balance", type: "DECIMAL_TEXT(20,4)" },
    ]);
  });

  it("splits a 4-decimal amount exactly — SUM(splits) = ABS(amount), no tolerance needed", async () => {
    const txId = await insertTx("-100.0001");
    await pool().query(
      `INSERT INTO transaction_splits (transaction_id, recipient_id, amount)
       VALUES ($1, $2, '50.0000'), ($1, $2, '50.0001')`,
      [txId, recipientId],
    );

    const { rows } = await pool().query<DbRow>(
      `SELECT dec_sum(ts.amount) AS split_sum,
              dec_eq(dec_sum(ts.amount), dec_abs(t.amount)) AS "exact::bool"
       FROM transactions t JOIN transaction_splits ts ON ts.transaction_id = t.id
       WHERE t.id = $1 GROUP BY t.id, t.amount`,
      [txId],
    );
    expect(must(rows[0], "rows[0]").split_sum).toBe("100.0001");
    expect(must(rows[0], "rows[0]").exact).toBe(true); // pre-0088 the 50.0001 split rounded to 50.00

    // The 0019 trigger chain kept all four decimals on its way into the aggregate
    // (0088 re-declared fn_agg_split_outstanding_sync's locals at (18,4)).
    const agg = await pool().query<DbRow>(
      `SELECT a.original_amount
       FROM agg_split_outstanding a
       JOIN transaction_splits ts ON ts.id = a.split_id
       WHERE ts.transaction_id = $1 ORDER BY a.original_amount`,
      [txId],
    );
    expect(agg.rows.map((r) => r.original_amount)).toEqual([
      "50.0000",
      "50.0001",
    ]);
  });

  it("tracks 4-decimal payments to an exact outstanding amount", async () => {
    const txId = await insertTx("-60.0001");
    const { rows: split } = await pool().query<{ id: SplitId }>(
      `INSERT INTO transaction_splits (transaction_id, recipient_id, amount)
       VALUES ($1, $2, '60.0001') RETURNING id`,
      [txId, recipientId],
    );
    await pool().query(
      `INSERT INTO split_payments (split_id, amount) VALUES ($1, '25.0001')`,
      [must(split[0], "split[0]").id],
    );
    const { rows } = await pool().query<DbRow>(
      `SELECT paid_amount, outstanding_amount FROM agg_split_outstanding WHERE split_id = $1`,
      [must(split[0], "split[0]").id],
    );
    expect(must(rows[0], "rows[0]").paid_amount).toBe("25.0001");
    expect(must(rows[0], "rows[0]").outstanding_amount).toBe("35.0000");
  });

  it("0062 split-guard still fires on a shrunk parent and passes an exact 4-dp cover", async () => {
    const txId = await insertTx("-100.0001");
    await pool().query(
      `INSERT INTO transaction_splits (transaction_id, recipient_id, amount)
       VALUES ($1, $2, '100.0001')`,
      [txId, recipientId],
    );

    // Shrinking the parent below the split total (beyond the 0.005 tolerance)
    // raises from the guard trigger (a canonical value, so not the column CHECK).
    await expect(
      pool().query<DbRow>(
        `UPDATE transactions SET amount = vision_numeric('-99.99', 18, 4) WHERE id = $1`,
        [txId],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      message: stringMatching(/below its split total 100\.0001/),
    });
    // Within the 0.005 tolerance passes (100.0001 - 0.005 < 99.9952).
    await pool().query<DbRow>(
      `UPDATE transactions SET amount = vision_numeric('-99.9952', 18, 4) WHERE id = $1`,
      [txId],
    );

    // An amount the splits cover exactly (equality, zero slack) passes.
    await pool().query<DbRow>(
      `UPDATE transactions SET amount = '-100.0001', balance = '1.2345' WHERE id = $1`,
      [txId],
    );
    const { rows } = await pool().query<DbRow>(
      `SELECT amount, balance FROM transactions WHERE id = $1`,
      [txId],
    );
    expect(must(rows[0], "rows[0]").amount).toBe("-100.0001");
    expect(must(rows[0], "rows[0]").balance).toBe("1.2345"); // transactions.balance holds 4 dp too now
  });

  it("planned→executed copies round-trip without a precision fork", async () => {
    const { rows: planned } = await pool().query<{ id: number; amount: string }>(
      `INSERT INTO planned_transactions (planned_date, amount, memo)
       VALUES ('2026-09-01', '123.4567', $1) RETURNING id, amount`,
      [MARK],
    );
    plannedIds.push(must(planned[0], "planned[0]").id);
    expect(must(planned[0], "planned[0]").amount).toBe("123.4567"); // stored, not rounded to 123.46

    // Copy the planned amount into a real transaction the way an execution does —
    // straight from the stored column — and compare in SQL, where NUMERIC equality
    // is exact.
    const txId = await insertTx(must(planned[0], "planned[0]").amount);
    const { rows } = await pool().query<DbRow>(
      `SELECT dec_eq(t.amount, pt.amount) AS "symmetric::bool"
       FROM transactions t, planned_transactions pt
       WHERE t.id = $1 AND pt.id = $2`,
      [txId, must(planned[0], "planned[0]").id],
    );
    expect(must(rows[0], "rows[0]").symmetric).toBe(true);
  });

  it("holds boundary magnitudes: 14 integer digits at 4 dp", async () => {
    const max = "99999999999999.9999"; // NUMERIC(18,4) upper bound
    const txId = await insertTx("-1.0000", max);
    const { rows } = await pool().query<DbRow>(
      `SELECT balance FROM transactions WHERE id = $1`,
      [txId],
    );
    expect(must(rows[0], "rows[0]").balance).toBe(max);

    const { rows: loan } = await pool().query<DbRow>(
      `INSERT INTO planned_transactions (planned_date, amount, memo, loan_principal)
       VALUES ('2026-09-01', '0.0001', $1, $2) RETURNING loan_principal`,
      [MARK, max],
    );
    const planned = await pool().query<{ id: PlannedTransactionId }>(
      `SELECT id FROM planned_transactions WHERE memo = $1`,
      [MARK],
    );
    for (const r of planned.rows)
      if (!plannedIds.includes(r.id)) plannedIds.push(r.id);
    expect(must(loan[0], "loan[0]").loan_principal).toBe(max);
  });

  // ── Repository guards at storage precision ────────────────────────────────
  // Storage stopped rounding to cents, so the validation/settle paths must
  // compare at the same 4-dp scale. Pre-0088 these three were masked by
  // (15,2) storage rounding the overshoot away; with (18,4) they were live
  // regressions until the guards moved to storage precision with the columns.
  describe("split guards validate at NUMERIC(18,4) storage precision", () => {
    it("rejects a sub-cent over-payment (two 25.0025 payments on a 50.00 split)", async () => {
      const txId = await insertTx("-50.0000");
      const { rows: split } = await pool().query<{ id: SplitId }>(
        `INSERT INTO transaction_splits (transaction_id, recipient_id, amount)
         VALUES ($1, $2, '50.0000') RETURNING id`,
        [txId, recipientId],
      );
      const splitId = must(split[0], "split[0]").id;

      await splitRepository.addPayment({ split_id: splitId, amount: 25.0025 });
      // Second identical payment projects 50.0050 > 50.0000 — a cent-precision
      // cap saw ROUND(50.0050, 2) = 50.00 and admitted it.
      await expect(
        splitRepository.addPayment({ split_id: splitId, amount: 25.0025 }),
      ).rejects.toThrow(/exceed split outstanding balance/);

      const { rows } = await pool().query<DbRow>(
        `SELECT COALESCE(dec_sum(amount), '0') AS paid FROM split_payments WHERE split_id = $1`,
        [splitId],
      );
      expect(must(rows[0], "rows[0]").paid).toBe("25.0025"); // only the first payment landed
    });

    it("rejects a sub-cent over-allocation on the single-split path", async () => {
      const txId = await insertTx("-100.0000");
      await splitRepository.createSplitAtomic({
        transaction_id: txId,
        recipient_id: asRecipientId(must(recipientId, "recipientId")),
        amount: 50.0,
        note: null,
      });
      // 50.0049 projects the split total to 100.0049 > 100.0000; the pre-fix
      // path validated AND stored the raw value while the batch path rounded
      // to cents — both now normalize to 4 dp and compare at 4 dp.
      await expect(
        splitRepository.createSplitAtomic({
          transaction_id: txId,
          recipient_id: asRecipientId(must(recipientId, "recipientId")),
          amount: 50.0049,
          note: null,
        }),
      ).rejects.toThrow(/exceeds transaction total/);

      const { rows } = await pool().query<DbRow>(
        `SELECT COALESCE(dec_sum(amount), '0') AS total FROM transaction_splits WHERE transaction_id = $1`,
        [txId],
      );
      expect(must(rows[0], "rows[0]").total).toBe("50.0000");
    });

    it("stores 4-dp batch splits verbatim (no cent rounding) and allocates a 4-dp parent exactly", async () => {
      const txId = await insertTx("-100.0001");
      const created = await splitRepository.createSplitsBatchAtomic({
        transaction_id: txId,
        splits: [
          { recipient_id: asRecipientId(must(recipientId, "recipientId")), amount: 50.0 },
          { recipient_id: asRecipientId(must(recipientId, "recipientId")), amount: 50.0001 },
        ],
      });
      expect(created.map((s) => s.amount)).toEqual([50, 50.0001]);
      const { rows } = await pool().query<DbRow>(
        `SELECT dec_eq(dec_sum(ts.amount), dec_abs(t.amount)) AS "exact::bool"
         FROM transactions t JOIN transaction_splits ts ON ts.transaction_id = t.id
         WHERE t.id = $1 GROUP BY t.id, t.amount`,
        [txId],
      );
      expect(must(rows[0], "rows[0]").exact).toBe(true); // the batch path used to round 50.0001 → 50.00
    });

    it("auto-settles only on an exact 4-dp cover, and a settled split takes no more payments", async () => {
      const txId = await insertTx("-50.0001");
      const { rows: split } = await pool().query<{ id: SplitId }>(
        `INSERT INTO transaction_splits (transaction_id, recipient_id, amount)
         VALUES ($1, $2, '50.0001') RETURNING id`,
        [txId, recipientId],
      );
      const splitId = must(split[0], "split[0]").id;

      // A cent-rounded cover (50.00 vs 50.0001) must NOT settle — the old
      // ROUND(…, 2) comparison froze the 0.0001 residue as "settled" forever.
      await splitRepository.addPayment({ split_id: splitId, amount: 50.0 });
      let state = await pool().query<DbRow>(
        `SELECT is_settled FROM transaction_splits WHERE id = $1`,
        [splitId],
      );
      expect(must(state.rows[0], "state.rows[0]").is_settled).toBe(false);

      // Paying off the residue reaches the exact amount and settles.
      await splitRepository.addPayment({ split_id: splitId, amount: 0.0001 });
      state = await pool().query<DbRow>(
        `SELECT is_settled FROM transaction_splits WHERE id = $1`,
        [splitId],
      );
      expect(must(state.rows[0], "state.rows[0]").is_settled).toBe(true);

      // Settled means closed: further payments are rejected (pre-0088 a 0.0001
      // payment died on the positive-amount CHECK by rounding to 0.00; at 4 dp
      // it would have been accepted silently).
      await expect(
        splitRepository.addPayment({ split_id: splitId, amount: 0.0001 }),
      ).rejects.toThrow(/already settled/);
    });
  });
});
