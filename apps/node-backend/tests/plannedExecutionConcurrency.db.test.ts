import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { executePlanned } from "../src/services/plannedExecutionService.ts";

type ExecutePlannedResult = Awaited<ReturnType<typeof executePlanned>>;

describe.skipIf(!hasTestDatabase())(
  "planned execution concurrency (real DB)",
  () => {
    const plannedIds: number[] = [];
    const transactionIds: number[] = [];
    const recipientIds: number[] = [];

    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180_000);

    afterEach(async () => {
      await getTestPool()!.query(
        "DELETE FROM planned_transactions WHERE id = ANY($1::int[])",
        [plannedIds.splice(0)],
      );
      await getTestPool()!.query(
        "DELETE FROM transactions WHERE id = ANY($1::int[])",
        [transactionIds.splice(0)],
      );
      await getTestPool()!.query(
        "DELETE FROM recipients WHERE id = ANY($1::int[])",
        [recipientIds.splice(0)],
      );
    });

    afterAll(async () => {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    });

    async function fixture({
      max = null,
      end = null,
    }: { max?: number | null; end?: string | null } = {}) {
      const pool = getTestPool()!;
      const recipient = await pool.query(
        "INSERT INTO recipients (name, normalized_name) VALUES ('Concurrency fixture', 'concurrency fixture') RETURNING id",
      );
      recipientIds.push(recipient.rows[0].id);
      const transactions = await pool.query(
        "INSERT INTO transactions (date, amount, currency, recipient_id) VALUES ('2026-07-01', '-10.00', 'EUR', $1), ('2026-08-01', '-10.00', 'EUR', $1) RETURNING id",
        [recipient.rows[0].id],
      );
      const ids = transactions.rows.map((row: { id: number }) => row.id);
      transactionIds.push(...ids);
      const planned = await pool.query(
        "INSERT INTO planned_transactions (planned_date, amount, currency, is_recurring, recurrence_pattern, max_occurrences, recurrence_end_date) VALUES ('2026-07-01', '-10.00', 'EUR', true, 'monthly', $1, $2) RETURNING id",
        [max, end],
      );
      const id = planned.rows[0].id;
      plannedIds.push(id);
      return { id, ids };
    }

    // Hold the parent until both application transactions are waiting. The old
    // implementation reads stale state before blocking on the execution insert;
    // the fixed implementation waits on the parent before its first read.
    async function concurrently(id: number, ids: number[]) {
      const gate = await getTestPool()!.connect();
      let outcomes:
        Promise<PromiseSettledResult<ExecutePlannedResult>[]> | undefined;
      try {
        await gate.query("BEGIN");
        await gate.query(
          "SELECT id FROM planned_transactions WHERE id = $1 FOR UPDATE",
          [id],
        );
        outcomes = Promise.allSettled(
          ids.map((executedTransactionId: number) =>
            executePlanned({
              id,
              executedTransactionId,
              executionDate: "2026-07-01",
            }),
          ),
        );
        const deadline = Date.now() + 5000;
        let waiters = 0;
        while (Date.now() < deadline) {
          const result = await getTestPool()!.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%planned_transaction%'",
          );
          waiters = result.rows[0].count;
          if (waiters >= 2) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiters).toBeGreaterThanOrEqual(2);
        await gate.query("COMMIT");
        return await outcomes;
      } finally {
        await gate.query("ROLLBACK");
        gate.release();
        if (outcomes) await outcomes;
      }
    }

    async function persisted(id: number) {
      const { rows } = await getTestPool()!.query(
        "SELECT to_char(planned_date, 'YYYY-MM-DD') AS day, is_executed, (SELECT count(*)::int FROM planned_transaction_executions WHERE planned_transaction_id = pt.id) AS count FROM planned_transactions pt WHERE id = $1",
        [id],
      );
      return rows[0];
    }

    it("advances two concurrent distinct payments twice", async () => {
      const { id, ids } = await fixture();
      const results = await concurrently(id, ids);
      expect(results.every((result) => result.status === "fulfilled")).toBe(
        true,
      );
      expect(await persisted(id)).toEqual({
        day: "2026-09-01",
        count: 2,
        is_executed: false,
      });
    });

    it("advances concurrent replay only once", async () => {
      const { id, ids } = await fixture();
      const results = await concurrently(id, [ids[0]!, ids[0]!]);
      expect(
        results
          .map(
            (result) =>
              (result as PromiseFulfilledResult<ExecutePlannedResult>).value
                .duplicate,
          )
          .sort(),
      ).toEqual([false, true]);
      expect(await persisted(id)).toEqual({
        day: "2026-08-01",
        count: 1,
        is_executed: false,
      });
    });

    it("accepts one final occurrence and rejects the concurrent extra payment", async () => {
      const { id, ids } = await fixture({ max: 1 });
      const results = await concurrently(id, ids);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        (
          results.find(
            (result) => result.status === "rejected",
          ) as PromiseRejectedResult
        ).reason.status,
      ).toBe(409);
      expect(await persisted(id)).toEqual({
        day: "2026-07-01",
        count: 1,
        is_executed: true,
      });
      const execution = await getTestPool()!.query(
        "SELECT executed_transaction_id FROM planned_transaction_executions WHERE planned_transaction_id = $1",
        [id],
      );
      await expect(
        executePlanned({
          id,
          executedTransactionId: execution.rows[0].executed_transaction_id,
        }),
      ).resolves.toMatchObject({ duplicate: true });
      expect((await persisted(id)).count).toBe(1);
    });

    it("does not execute a second payment after end-date completion", async () => {
      const { id, ids } = await fixture({ end: "2026-07-15" });
      await executePlanned({
        id,
        executedTransactionId: ids[0]!,
        executionDate: "2026-07-01",
      });
      await expect(
        executePlanned({ id, executedTransactionId: ids[1]! }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await persisted(id)).toEqual({
        day: "2026-07-01",
        count: 1,
        is_executed: true,
      });
      await expect(
        executePlanned({ id, executedTransactionId: ids[0]! }),
      ).resolves.toMatchObject({ duplicate: true });
    });
  },
);
