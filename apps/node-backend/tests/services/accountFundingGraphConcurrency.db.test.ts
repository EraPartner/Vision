/**
 * Real-database concurrency coverage for the account funding graph.
 *
 * Unit tests pin call order, but only concurrent writers establish that the
 * second writer revalidates after the first commits. PostgreSQL got this from
 * a transaction-scoped advisory lock; on SQLite (ADR-263) every funding-graph
 * mutation validates and writes inside one withTransaction(), and BEGIN
 * IMMEDIATE on the single writer queues the second transaction behind the
 * first. Each race below holds the write lock, waits until both mutations are
 * queued on it, then releases them. Both races would be able to mint a cycle
 * if their validation and writes interleaved.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeTestPool, getTestPool } from "../setup/db.ts";
import { accountService } from "../../src/services/accountService.ts";
import { mergeAccounts } from "../../src/services/accountMergeService.ts";
import {
  closePool,
  getPoolStats,
  withTransaction,
} from "../../src/database/connection.ts";
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

/**
 * Hold the database write lock in an open transaction. The mutations under
 * test are started afterwards from the test's own async context, so they do
 * not join this transaction: they queue on the write lock behind it.
 */
async function holdWriteLock() {
  let signalHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    signalHeld = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate = withTransaction(async () => {
    signalHeld();
    await released;
  });
  await Promise.race([held, gate]);
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    release();
    await gate;
  };
}

async function waitForFundingGraphWaiters(expected: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (getPoolStats().waitingCount >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Timed out waiting for ${expected} write-lock waiter(s)`,
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

describe(
  "account funding graph concurrency (real DB)",
  () => {
    afterEach(async () => {
      const pool = must(getTestPool(), "getTestPool()");
      await pool.query("UPDATE accounts SET funding_account_id = NULL");
      await pool.query("DELETE FROM accounts");
    });

    afterAll(async () => {
      await closeTestPool();
      await closePool();
    });

    it("serializes opposing PATCH requests and rejects the stale edge", async () => {
      const a = await insertAccount("Funding race A");
      const b = await insertAccount("Funding race B");
      const releaseLock = await holdWriteLock();
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
      const releaseLock = await holdWriteLock();
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
      const releaseLock = await holdWriteLock();
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
