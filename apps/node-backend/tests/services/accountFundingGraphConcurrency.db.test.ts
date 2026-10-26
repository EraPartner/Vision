/**
 * Real-PostgreSQL concurrency coverage for the account funding graph.
 *
 * Unit tests pin call order, but only two live connections establish that the
 * transaction-scoped advisory lock makes the second writer revalidate after
 * the first commits. Both races below would be able to mint a cycle if their
 * validation and writes interleaved.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "../setup/db.ts";
import { accountService } from "../../src/services/accountService.ts";
import { mergeAccounts } from "../../src/services/accountMergeService.ts";
import { closePool } from "../../src/database/connection.ts";
import {
  __ACCOUNT_FUNDING_GRAPH_LOCK_PARAMS as ACCOUNT_FUNDING_GRAPH_LOCK_PARAMS,
  __ACCOUNT_FUNDING_GRAPH_LOCK_SQL as ACCOUNT_FUNDING_GRAPH_LOCK_SQL,
} from "../../src/lib/accountFundingGraphLock.ts";
import {
  asAccountId,
} from "@vision/types/brands";
import { must } from "../helpers/must.ts";

async function insertAccount(
  name: string,
  fundingAccountId: number | null = null,
): Promise<number> {
  const { rows } = await must(getTestPool(), "getTestPool()").query<{ id: number }>(
    `INSERT INTO accounts (name, display_name, funding_account_id)
     VALUES ($1, $1, $2)
     RETURNING id`,
    [name, fundingAccountId],
  );
  return must(rows[0], "row").id;
}

async function expectAcyclic() {
  const { rows } = await must(getTestPool(), "getTestPool()").query<{
    id: number;
    funding_account_id: number | null;
  }>("SELECT id, funding_account_id FROM accounts ORDER BY id");
  const parentById = new Map(
    rows.map((row): [number, number | null] => [
      row.id,
      row.funding_account_id,
    ]),
  );
  for (const start of parentById.keys()) {
    const seen = new Set<number>();
    let current: number | null = start;
    while (current != null) {
      expect(
        seen.has(current),
        `funding cycle reachable from account ${start}`,
      ).toBe(false);
      seen.add(current);
      current = parentById.get(current) ?? null;
    }
  }
}

function expectOneWinner(outcomes: PromiseSettledResult<unknown>[]) {
  expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(
    1,
  );
  expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(
    1,
  );
}

async function holdFundingGraphLock() {
  const client = await must(getTestPool(), "getTestPool()").connect();
  await client.query("BEGIN");
  await client.query(ACCOUNT_FUNDING_GRAPH_LOCK_SQL, [
    ...ACCOUNT_FUNDING_GRAPH_LOCK_PARAMS,
  ]);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  };
}

async function waitForFundingGraphWaiters(expected: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await must(getTestPool(), "getTestPool()").query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM pg_stat_activity
        WHERE state = 'active'
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
          AND query LIKE 'SELECT pg_advisory_xact_lock%'`,
    );
    if (must(rows[0], "row").count >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Timed out waiting for ${expected} funding-graph lock waiter(s)`,
  );
}

async function releaseLockAndCollect<
  T extends PromiseSettledResult<unknown>[],
>(
  releaseLock: () => Promise<void>,
  outcomesPromise: Promise<T>,
  expected: number,
): Promise<T> {
  let waiterError: unknown;
  try {
    await waitForFundingGraphWaiters(expected);
  } catch (err) {
    waiterError = err;
  } finally {
    await releaseLock();
  }
  const outcomes = await outcomesPromise;
  if (waiterError) {
      throw waiterError instanceof Error
        ? waiterError
        : new Error("funding-graph waiter failed", { cause: waiterError });
    }
  return outcomes;
}

describe.skipIf(!hasTestDatabase())(
  "account funding graph concurrency (real DB)",
  () => {
    beforeAll(async () => {
      expect(
        process.env.DATABASE_URL,
        "DATABASE_URL must equal TEST_DATABASE_URL for this suite",
      ).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180_000);

    afterEach(async () => {
      const pool = must(getTestPool(), "getTestPool()");
      await pool.query("UPDATE accounts SET funding_account_id = NULL");
      await pool.query("DELETE FROM accounts");
    });

    afterAll(async () => {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    });

    it("serializes opposing PATCH requests and rejects the stale edge", async () => {
      const a = await insertAccount("Funding race A");
      const b = await insertAccount("Funding race B");
      const releaseLock = await holdFundingGraphLock();
      const outcomesPromise = Promise.allSettled([
        accountService.update(asAccountId(a), { funding_account_id: b }),
        accountService.update(asAccountId(b), { funding_account_id: a }),
      ]);
      const outcomes = await releaseLockAndCollect(
        releaseLock,
        outcomesPromise,
        2,
      );

      expectOneWinner(outcomes);
      expect(
        outcomes.some(
          (outcome) =>
            outcome.status === "rejected" &&
            /funding cycle/.test(
                (outcome.reason as Error | undefined)?.message ?? "",
              ),
        ),
      ).toBe(true);
      await expectAcyclic();
    });

    it("serializes a PATCH against a merge that could repoint it into a cycle", async () => {
      const dependent = await insertAccount("Funding merge dependent");
      const survivor = await insertAccount("Funding merge survivor", dependent);
      const source = await insertAccount("Funding merge source");
      const releaseLock = await holdFundingGraphLock();
      const outcomesPromise = Promise.allSettled([
        accountService.update(asAccountId(dependent), { funding_account_id: source }),
        mergeAccounts(asAccountId(survivor), [asAccountId(source)]),
      ]);
      const outcomes = await releaseLockAndCollect(
        releaseLock,
        outcomesPromise,
        2,
      );

      expectOneWinner(outcomes);
      await expectAcyclic();
    });

    it("serializes account deletion against a funding PATCH", async () => {
      const parent = await insertAccount("Funding delete parent");
      const dependent = await insertAccount("Funding delete dependent");
      const releaseLock = await holdFundingGraphLock();
      const outcomesPromise = Promise.allSettled([
        accountService.remove(asAccountId(parent)),
        accountService.update(asAccountId(dependent), { funding_account_id: parent }),
      ]);
      const outcomes = await releaseLockAndCollect(
        releaseLock,
        outcomesPromise,
        2,
      );

      expect(outcomes[0]).toMatchObject({ status: "fulfilled", value: parent });
      expect(
        outcomes[1].status === "fulfilled" ||
          /does not reference an existing account/.test(
            (outcomes[1].reason as Error | undefined)?.message ?? "",
          ),
      ).toBe(true);
      const { rows } = await must(getTestPool(), "getTestPool()").query<{ funding_account_id: number | null }>(
        "SELECT funding_account_id FROM accounts WHERE id = $1",
        [dependent],
      );
      expect(must(rows[0], "row").funding_account_id).toBeNull();
      await expectAcyclic();
    });
  },
);
