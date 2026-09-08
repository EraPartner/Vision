/** Real-PostgreSQL atomicity, idempotency, and lock coverage for WP-C3. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { closePool } from "../src/database/connection.js";
import { retagPortfolioTransactions } from "../src/services/portfolio/portfolioBrokerRetagService.js";

const pool = getTestPool();
const describeDb = hasTestDatabase() ? describe : describe.skip;
const uuid = (suffix) => `75557a9d-4dee-453a-9ef6-${suffix.padStart(12, "0")}`;
let fixture;

async function wipe() {
  await pool.query("DELETE FROM portfolio_retag_audit");
  await pool.query("DELETE FROM portfolio_transactions");
  await pool.query("DELETE FROM investments WHERE name LIKE 'WPC3 %'");
  await pool.query("DELETE FROM accounts WHERE name LIKE 'WPC3 %'");
}

async function seed() {
  const accounts = await pool.query(
    `INSERT INTO accounts (name, display_name, type)
     VALUES ('WPC3 source', 'Source', 'brokerage'),
            ('WPC3 destination', 'Destination', 'brokerage')
     RETURNING id, name`,
  );
  const investment = await pool.query(
    `INSERT INTO investments (name, symbol, asset_class, currency, current_price)
     VALUES ('WPC3 instrument', 'WPC3', 'stock', 'EUR', 12)
     RETURNING id`,
  );
  const accountIdByName = new Map(
    accounts.rows.map((row) => [row.name, Number(row.id)]),
  );
  const source = accountIdByName.get("WPC3 source");
  const transactions = await pool.query(
    `INSERT INTO portfolio_transactions
       (investment_id, type, date, amount, units, currency, account_id)
     VALUES ($1, 'buy', '2026-01-01', 100, 10, 'EUR', $2),
            ($1, 'sell', '2026-02-01', 30, 3, 'EUR', $2)
     RETURNING id, type`,
    [investment.rows[0].id, source],
  );
  const transactionIdByType = new Map(
    transactions.rows.map((row) => [row.type, Number(row.id)]),
  );
  return {
    source,
    destination: accountIdByName.get("WPC3 destination"),
    transactionIds: [
      transactionIdByType.get("buy"),
      transactionIdByType.get("sell"),
    ],
  };
}

function request(idempotencyKey = uuid("1")) {
  return {
    transaction_ids: fixture.transactionIds,
    from_account_id: fixture.source,
    to_account_id: fixture.destination,
    idempotency_key: idempotencyKey,
  };
}

async function waitForRetagAccountLock() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT count(*)::int AS count
               FROM pg_stat_activity
              WHERE wait_event_type = 'Lock'
                AND query LIKE '%FROM accounts%FOR UPDATE%'`,
    );
    if (result.rows[0].count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for broker re-tag account-row lock");
}

describeDb("portfolio broker bulk re-tag (real Postgres)", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
    await acquireDbSuiteLock();
  }, 180_000);

  beforeEach(async () => {
    await wipe();
    fixture = await seed();
  });

  afterAll(async () => {
    await wipe();
    await releaseDbSuiteLock();
    await closePool();
    await closeTestPool();
  });

  it("updates the complete set and durably replays its receipt", async () => {
    const first = await retagPortfolioTransactions(request());
    const replay = await retagPortfolioTransactions(request());
    const rows = await pool.query(
      "SELECT account_id FROM portfolio_transactions ORDER BY id",
    );
    const audits = await pool.query(
      "SELECT count(*)::int AS count FROM portfolio_retag_audit",
    );

    expect(rows.rows.map((row) => Number(row.account_id))).toEqual([
      fixture.destination,
      fixture.destination,
    ]);
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(audits.rows[0].count).toBe(1);
  });

  it("rolls back when moving only the buy would oversell the source", async () => {
    await expect(
      retagPortfolioTransactions({
        ...request(uuid("2")),
        transaction_ids: [fixture.transactionIds[0]],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const rows = await pool.query(
      "SELECT account_id FROM portfolio_transactions ORDER BY id",
    );
    expect(rows.rows.map((row) => Number(row.account_id))).toEqual([
      fixture.source,
      fixture.source,
    ]);
  });

  it("serializes competing source-guarded writers so exactly one wins", async () => {
    const outcomes = await Promise.allSettled([
      retagPortfolioTransactions(request(uuid("3"))),
      retagPortfolioTransactions({
        ...request(uuid("4")),
        to_account_id: null,
      }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected.reason).toMatchObject({ code: "CONFLICT" });
    const audits = await pool.query(
      "SELECT count(*)::int AS count FROM portfolio_retag_audit",
    );
    expect(audits.rows[0].count).toBe(1);
  });

  it("rechecks destination eligibility after a concurrent account close", async () => {
    const closer = await pool.connect();
    await closer.query("BEGIN");
    await closer.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [
      fixture.destination,
    ]);

    const retag = retagPortfolioTransactions(request(uuid("5")));
    let waitError;
    try {
      await waitForRetagAccountLock();
    } catch (err) {
      waitError = err;
    } finally {
      await closer.query(
        "UPDATE accounts SET is_active = false WHERE id = $1",
        [fixture.destination],
      );
      await closer.query("COMMIT");
      closer.release();
    }
    if (waitError) throw waitError;

    await expect(retag).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const rows = await pool.query(
      "SELECT account_id FROM portfolio_transactions ORDER BY id",
    );
    expect(rows.rows.map((row) => Number(row.account_id))).toEqual([
      fixture.source,
      fixture.source,
    ]);
  });
});
