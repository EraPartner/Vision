/**
 * Owed-split dates at the HTTP boundary, against real PostgreSQL, with the
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
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import splitService from "../src/services/splitService.ts";
import splitsRouter from "../src/routes/splits.ts";
import { routeAgent } from "./helpers/routeApp.ts";
import { bodyAt } from "./helpers/responseBody.ts";
import { asRecipientId } from "@vision/types/brands";
import { OwedDetailListSchema } from "@vision/types/contracts";

const describeDb = hasTestDatabase() ? describe : describe.skip;
const MARK = `owed_dates_${process.pid}`;

describeDb("owed split dates are calendar days (real DB, Europe/Brussels)", () => {
  const api = routeAgent(splitsRouter, { mountPath: "/api/splits" });
  const previousTz = process.env.TZ;
  let recipientId: number;

  beforeAll(async () => {
    await acquireDbSuiteLock();
    // pg reads DATE as a local-midnight Date; east of UTC that is the
    // previous day in UTC, which is what exposed the bug.
    process.env.TZ = "Europe/Brussels";
    const pool = getTestPool()!;
    const { rows: recipients } = await pool.query(
      `INSERT INTO recipients (name, normalized_name) VALUES ($1, $1) RETURNING id`,
      [`${MARK}_debtor`],
    );
    recipientId = recipients[0].id;
    const { rows: transactions } = await pool.query(
      `INSERT INTO transactions (date, amount, memo, currency, recipient_id)
       VALUES ('2025-11-04', -40, $1, 'EUR', $2) RETURNING id`,
      [MARK, recipientId],
    );
    await splitService.createSplitAtomic({
      transaction_id: transactions[0].id,
      recipient_id: asRecipientId(recipientId),
      amount: 40,
      note: null,
    });
  });

  afterAll(async () => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
    try {
      const pool = getTestPool();
      if (pool) {
        await pool.query("DELETE FROM transactions WHERE memo = $1", [MARK]);
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
});
