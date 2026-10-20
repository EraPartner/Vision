/** Real-PostgreSQL atomicity, replay, and lock coverage for WP-C3. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { __retagPortfolioTransactions as retagPortfolioTransactions } from "../src/services/portfolio/portfolioBrokerRetagService.ts";
import {
  asAccountId,
  asPortfolioTransactionId,
} from "@vision/types/brands";

const pool = getTestPool()!;
const describeDb = hasTestDatabase() ? describe : describe.skip;
const runId = randomBytes(4).toString("hex");
const uuid = (suffix: string) =>
  `75557a9d-4dee-453a-9ef6-${runId}${suffix.padStart(4, "0")}`;
let fixture: Awaited<ReturnType<typeof seed>>;

async function wipe() {
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
    accounts.rows.map((row) => [row.name, asAccountId(Number(row.id))]),
  );
  const source = accountIdByName.get("WPC3 source")!;
  const transactions = await pool.query(
    `INSERT INTO portfolio_transactions
       (investment_id, type, date, amount, units, currency, account_id)
     VALUES ($1, 'buy', '2026-01-01', 100, 10, 'EUR', $2),
            ($1, 'sell', '2026-02-01', 30, 3, 'EUR', $2)
     RETURNING id, type`,
    [investment.rows[0].id, source],
  );
  const transactionIdByType = new Map(
    transactions.rows.map((row) => [
      row.type,
      asPortfolioTransactionId(Number(row.id)),
    ]),
  );
  return {
    source,
    destination: accountIdByName.get("WPC3 destination")!,
    transactionIds: [
      transactionIdByType.get("buy")!,
      transactionIdByType.get("sell")!,
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
                AND query ~* 'from "?accounts"? .*for update'`,
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

  async function accountIds() {
    const rows = await pool.query(
      "SELECT account_id, xmin::text AS version FROM portfolio_transactions ORDER BY id",
    );
    return rows.rows.map((row) => ({
      account: row.account_id === null ? null : Number(row.account_id),
      version: row.version as string,
    }));
  }

  it("applies a repeated request once and reports the repeat as a replay", async () => {
    const first = await retagPortfolioTransactions(request());
    const afterFirst = await accountIds();
    const replay = await retagPortfolioTransactions(request());
    const afterReplay = await accountIds();

    expect(afterFirst.map((row) => row.account)).toEqual([
      fixture.destination,
      fixture.destination,
    ]);
    // The replay wrote nothing: the row versions are unchanged.
    expect(afterReplay).toEqual(afterFirst);
    expect(first).toMatchObject({
      replayed: false,
      selected_count: 2,
      changed_count: 2,
      previous_assignments: fixture.transactionIds.map((id) => ({
        transaction_id: id,
        account_id: fixture.source,
      })),
    });
    expect(replay).toMatchObject({
      replayed: true,
      selected_count: 2,
      changed_count: 0,
      idempotency_key: uuid("1"),
      previous_assignments: fixture.transactionIds.map((id) => ({
        transaction_id: id,
        account_id: fixture.destination,
      })),
    });
  });

  it("applies concurrent identical requests once", async () => {
    const results = await Promise.all([
      retagPortfolioTransactions(request(uuid("6"))),
      retagPortfolioTransactions(request(uuid("6"))),
    ]);
    expect(
      results.map((result) => [result.replayed, result.changed_count]).sort(),
    ).toEqual([
      [false, 2],
      [true, 0],
    ]);
    expect((await accountIds()).map((row) => row.account)).toEqual([
      fixture.destination,
      fixture.destination,
    ]);
  });

  it("still rejects a stale source once the rows have moved elsewhere", async () => {
    await retagPortfolioTransactions(request());
    const error = await retagPortfolioTransactions({
      ...request(uuid("7")),
      to_account_id: null,
    }).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: "CONFLICT" });
    expect((await accountIds()).map((row) => row.account)).toEqual([
      fixture.destination,
      fixture.destination,
    ]);
  });

  it("rolls back when moving only the buy would oversell the source", async () => {
    await expect(
      retagPortfolioTransactions({
        ...request(uuid("2")),
        transaction_ids: [fixture.transactionIds[0]!],
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
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
    });
    const winner = (
      outcomes.find((outcome) => outcome.status === "fulfilled") as
        PromiseFulfilledResult<{ to_account_id: number | null }>
    ).value;
    expect((await accountIds()).map((row) => row.account)).toEqual([
      winner.to_account_id,
      winner.to_account_id,
    ]);
  });

  it("rechecks destination eligibility after a concurrent account close", async () => {
    const closer = await pool.connect();
    await closer.query("BEGIN");
    await closer.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [
      fixture.destination,
    ]);

    const retag = retagPortfolioTransactions(request(uuid("5")));
    // COMMIT releases the row lock, so the re-tag can reject before the
    // assertion below attaches; handle it now, the assertion still sees it.
    retag.catch(() => {});
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
