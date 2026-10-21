/**
 * Admin DB editor DATE columns at the HTTP boundary, against real PostgreSQL,
 * with the backend running east of UTC.
 *
 * Regression: GET /api/admin/database/tables/:table/rows sent DATE cells as
 * the raw pg `Date`, i.e. the previous day's UTC timestamp
 * (2024-05-28T22:00:00.000Z for 2024-05-29). The editor shows that text and
 * sends it back on save, and PostgreSQL casts it to 2024-05-28, so saving an
 * untouched date moved it one day earlier.
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
import adminRouter from "../src/routes/admin.ts";
import { routeAgent } from "./helpers/routeApp.ts";
import { bodyAt } from "./helpers/responseBody.ts";

const describeDb = hasTestDatabase() ? describe : describe.skip;
const SOURCE = `dbeditor_dates_${process.pid}`;
const TABLE = "belgian_inflation_rates";

describeDb("DB editor DATE cells are calendar days (real DB, Europe/Brussels)", () => {
  const api = routeAgent(adminRouter, { mountPath: "/api/admin" });
  const previousTz = process.env.TZ;

  async function readMarkedRow() {
    const filters = JSON.stringify([
      { column: "source", op: "eq", value: SOURCE },
    ]);
    const res = await api
      .get(`/api/admin/database/tables/${TABLE}/rows`)
      .query({ filters });
    expect(res.status).toBe(200);
    return bodyAt(res, "data", "rows", 0) as Record<string, unknown>;
  }

  beforeAll(async () => {
    await acquireDbSuiteLock();
    process.env.TZ = "Europe/Brussels";
    await getTestPool()!.query(
      `INSERT INTO ${TABLE} (month_date, monthly_rate, source)
       VALUES ('2024-05-29', 0.5, $1)`,
      [SOURCE],
    );
  });

  afterAll(async () => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
    try {
      await getTestPool()?.query(`DELETE FROM ${TABLE} WHERE source = $1`, [
        SOURCE,
      ]);
    } finally {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    }
  });

  it("reads a DATE cell as YYYY-MM-DD", async () => {
    const row = await readMarkedRow();
    expect(row.month_date).toBe("2024-05-29");
  });

  it("keeps the same day when the unchanged date text is saved back", async () => {
    const row = await readMarkedRow();

    const res = await api
      .post(`/api/admin/database/tables/${TABLE}/mutate`)
      .send({
        changes: [
          {
            op: "update",
            pk: { id: row.id },
            xmin: row.__xmin,
            set: { month_date: row.month_date, monthly_rate: "0.6" },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(bodyAt(res, "data", "results", 0, "after", "month_date")).toBe(
      "2024-05-29",
    );
    const { rows } = await getTestPool()!.query(
      `SELECT month_date::text AS month_date FROM ${TABLE} WHERE source = $1`,
      [SOURCE],
    );
    expect(rows[0].month_date).toBe("2024-05-29");
  });
});
