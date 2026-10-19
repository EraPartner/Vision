/**
 * GET /api/splits/owed and /api/splits/owed/:id against real PostgreSQL:
 * a split is denominated in its transaction's currency, so the owed figures
 * convert each currency at the latest stored rate before adding them up.
 *
 * Regression: the summary used to SUM split amounts across currencies, so
 * 20 EUR + 50 USD + 7 GBP outstanding showed as 77 "EUR". A currency without
 * a stored rate is now left out and counted, never added 1:1.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { todayAppDateString } from "../src/lib/timezone.ts";
import splitService from "../src/services/splitService.ts";
import splitsRouter from "../src/routes/splits.ts";
import { routeAgent } from "./helpers/routeApp.ts";
import { bodyAt } from "./helpers/responseBody.ts";
import {
  asRecipientId,
} from "@vision/types/brands";

const describeDb = hasTestDatabase() ? describe : describe.skip;
const MARK = `owed_totals_${process.pid}`;

async function insertRecipient(name: string): Promise<number> {
  const { rows } = await getTestPool()!.query(
    `INSERT INTO recipients (name, normalized_name) VALUES ($1, $1) RETURNING id`,
    [`${MARK}_${name}`],
  );
  return rows[0].id;
}

/** A transaction of `amount` in `currency` with one split owed by `owedBy`. */
async function insertSplit(
  owedBy: number,
  currency: string,
  amount: number,
  paid = 0,
) {
  const { rows } = await getTestPool()!.query(
    `INSERT INTO transactions (date, amount, memo, currency, recipient_id)
     VALUES (CURRENT_DATE, $1, $2, $3, $4) RETURNING id`,
    [-amount, MARK, currency, owedBy],
  );
  const split = await splitService.createSplitAtomic({
    transaction_id: rows[0].id,
    recipient_id: asRecipientId(owedBy),
    amount,
    note: null,
  });
  if (paid > 0)
    await splitService.addPayment({ split_id: split.id, amount: paid });
}

describeDb("owed totals in one currency (real DB)", () => {
  const api = routeAgent(splitsRouter, { mountPath: "/api/splits" });
  let alice: number;
  let bob: number;

  beforeAll(async () => {
    await acquireDbSuiteLock();
  });

  beforeEach(async () => {
    const pool = getTestPool()!;
    await pool.query("DELETE FROM transaction_splits");
    await pool.query("DELETE FROM transactions WHERE memo = $1", [MARK]);
    await pool.query("DELETE FROM recipients WHERE normalized_name LIKE $1", [
      `${MARK}%`,
    ]);
    await pool.query("DELETE FROM exchange_rates");
    await pool.query(
      `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest)
       VALUES ('USD', '0.9', $1, true)`,
      [todayAppDateString()],
    );
    alice = await insertRecipient("alice");
    bob = await insertRecipient("bob");
    // Alice: 30 EUR (10 repaid), 50 USD, 7 GBP (no stored rate).
    await insertSplit(alice, "EUR", 30, 10);
    await insertSplit(alice, "USD", 50);
    await insertSplit(alice, "GBP", 7);
    // Bob only owes in a currency without a rate.
    await insertSplit(bob, "GBP", 12);
  });

  afterAll(async () => {
    try {
      const pool = getTestPool();
      if (pool) {
        await pool.query("DELETE FROM transactions WHERE memo = $1", [MARK]);
        await pool.query(
          "DELETE FROM recipients WHERE normalized_name LIKE $1",
          [`${MARK}%`],
        );
        await pool.query("DELETE FROM exchange_rates");
      }
    } finally {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    }
  });

  it("converts each recipient's currencies and counts the ones without a rate", async () => {
    const res = await api.get("/api/splits/owed?currency=EUR");

    expect(res.status).toBe(200);
    // Alice: owed 30 + 50 × 0.9 = 75, paid 10, remaining 20 + 45 = 65.
    expect(bodyAt(res, "data", "items")).toEqual([
      {
        recipient_id: alice,
        recipient_name: `${MARK}_alice`,
        total_owed: 75,
        total_paid: 10,
        remaining: 65,
        split_count: 3,
        unconverted_count: 1,
        unconverted_currencies: ["GBP"],
      },
      {
        recipient_id: bob,
        recipient_name: `${MARK}_bob`,
        total_owed: 0,
        total_paid: 0,
        remaining: 0,
        split_count: 1,
        unconverted_count: 1,
        unconverted_currencies: ["GBP"],
      },
    ]);
    expect(bodyAt(res, "data", "summary")).toEqual({
      currency: "EUR",
      remaining: 65,
      unconverted_count: 2,
      unconverted_currencies: ["GBP"],
    });
  });

  it("returns a recipient's converted total outstanding with the detail list", async () => {
    const res = await api.get(`/api/splits/owed/${alice}?currency=EUR`);

    expect(res.status).toBe(200);
    expect(bodyAt(res, "data", "total")).toBe(3);
    expect(bodyAt(res, "data", "summary")).toEqual({
      currency: "EUR",
      remaining: 65,
      unconverted_count: 1,
      unconverted_currencies: ["GBP"],
    });
  });

  it("converts into a non-EUR display currency through EUR", async () => {
    const res = await api.get(`/api/splits/owed/${alice}?currency=usd`);

    expect(res.status).toBe(200);
    // 20 EUR / 0.9 = 22.222… USD, plus 50 USD.
    expect(bodyAt(res, "data", "summary", "remaining")).toBe(72.22);
    expect(bodyAt(res, "data", "summary", "currency")).toBe("USD");
  });

  it("rejects a malformed currency", async () => {
    const res = await api.get("/api/splits/owed?currency=euro");
    expect(res.status).toBe(400);
  });
});
