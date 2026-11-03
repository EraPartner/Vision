/**
 * Owed-split dates at the HTTP boundary, against a real database, with the
 * backend running east of UTC.
 *
 * Regression: GET /api/splits/owed/:id sent `transaction_date` as the raw pg
 * `Date`, which JSON-serializes as the previous day's UTC timestamp
 * (2025-11-03T23:00:00.000Z for a 2025-11-04 transaction), so the Owes detail
 * showed every date one day early. The CSV export wrote `Date.toString()`
 * ("Tue Nov 04 2025 00:00:00 GMT+0100 …") in its Date column.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  getTestPool,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import splitService from "../src/services/splitService.ts";
import splitsRouter from "../src/routes/splits.ts";
import { routeAgent } from "./helpers/routeApp.ts";
import { bodyAt } from "./helpers/responseBody.ts";
import { asRecipientId, type RecipientId, type TransactionId } from "@vision/types/brands";
import { OwedDetailListSchema } from "@vision/types/contracts";
import { must } from "./helpers/must.ts";

const describeDb = describe;
const MARK = `owed_dates_${process.pid}`;

describeDb("owed split dates are calendar days (real DB, Europe/Brussels)", () => {
  const api = routeAgent(splitsRouter, { mountPath: "/api/splits" });
  const previousTz = process.env.TZ;
  let recipientId: number;
  let dstRecipientId: number;
  // Europe/Brussels switches to summer time on 2026-03-29 and back on
  // 2025-10-26: those local days are 23 and 25 hours long, so a day computed
  // from a millisecond offset (or read as a shifted Date) lands on a neighbour.
  const DST_DAYS = ["2025-10-26", "2026-03-29"];

  beforeAll(async () => {
    // The driver reads DATE as a local-midnight Date (as pg did); east of UTC
    // that is the previous day in UTC, which is what exposed the bug.
    process.env.TZ = "Europe/Brussels";
    const pool = must(getTestPool(), "getTestPool()");
    const { rows: recipients } = await pool.query<{ id: RecipientId }>(
      `INSERT INTO recipients (name, normalized_name) VALUES ($1, $1) RETURNING id`,
      [`${MARK}_debtor`],
    );
    recipientId = must(recipients[0], "recipients[0]").id;
    const { rows: transactions } = await pool.query<{ id: TransactionId }>(
      `INSERT INTO transactions (date, amount, memo, currency, recipient_id)
       VALUES ('2025-11-04', vision_numeric('-40', 18, 4), $1, 'EUR', $2) RETURNING id`,
      [MARK, recipientId],
    );
    await splitService.createSplitAtomic({
      transaction_id: must(transactions[0], "transactions[0]").id,
      recipient_id: asRecipientId(recipientId),
      amount: 40,
      note: null,
    });
    const { rows: dstRecipients } = await pool.query<{ id: RecipientId }>(
      `INSERT INTO recipients (name, normalized_name) VALUES ($1, $1) RETURNING id`,
      [`${MARK}_dst`],
    );
    dstRecipientId = must(dstRecipients[0], "dstRecipients[0]").id;
    for (const day of DST_DAYS) {
      const { rows } = await pool.query<{ id: TransactionId }>(
        `INSERT INTO transactions (date, amount, memo, currency, recipient_id)
         VALUES ($1, vision_numeric('-12.3456', 18, 4), $2, 'EUR', $3) RETURNING id`,
        [day, MARK, recipientId],
      );
      await splitService.createSplitAtomic({
        transaction_id: must(rows[0], "rows[0]").id,
        recipient_id: asRecipientId(dstRecipientId),
        amount: 12.3456,
        note: null,
      });
    }
  });

  afterAll(async () => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
    try {
      const pool = getTestPool();
      await pool.query("DELETE FROM transactions WHERE memo = $1", [MARK]);
      await pool.query("DELETE FROM recipients WHERE normalized_name LIKE $1", [
        `${MARK}%`,
      ]);
    } finally {
      await closeTestPool();
      await closePool();
    }
  });

  it("sends the owed detail's transaction_date as the transaction's own day", async () => {
    const res = await api.get(`/api/splits/owed/${recipientId}`);

    expect(res.status).toBe(200);
    expect(bodyAt(res, "data", "items", 0, "transaction_date")).toBe(
      "2025-11-04",
    );
    expect(OwedDetailListSchema.safeParse(bodyAt(res, "data")).success).toBe(
      true,
    );
  });

  it("writes YYYY-MM-DD in the owed CSV export's Date column", async () => {
    const res = await api.get(`/api/splits/owed/${recipientId}/export/csv`);

    expect(res.status).toBe(200);
    const [header, row] = res.text.split("\n");
    expect(header).toBe(
      "Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment",
    );
    expect(row?.split(",")[0]).toBe("2025-11-04");
  });

  it("keeps DST switch days as their own calendar day in the detail and the CSV", async () => {
    const detail = await api.get(`/api/splits/owed/${dstRecipientId}`);
    expect(detail.status).toBe(200);
    const items = bodyAt(detail, "data", "items") as { transaction_date: string; remaining: number }[];
    expect(items.map((item) => item.transaction_date).sort()).toEqual(DST_DAYS);
    // The 4-dp amount survives exactly.
    expect(items.map((item) => item.remaining)).toEqual([12.3456, 12.3456]);

    const csv = await api.get(`/api/splits/owed/${dstRecipientId}/export/csv`);
    expect(csv.status).toBe(200);
    const days = csv.text
      .split("\n")
      .slice(1)
      .filter((line) => line.length > 0)
      .map((line) => line.split(",")[0] ?? "")
      .sort();
    expect(days).toEqual(DST_DAYS);
  });
});
