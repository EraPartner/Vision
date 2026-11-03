import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  closeTestPool,
  getTestPool,
} from "./setup/db.ts";
import { closePool, withTransaction } from "../src/database/connection.ts";
import transactionRepository from "../src/repositories/transactionRepository.ts";
import { bulkDeleteTransactions } from "../src/services/transactionBulkService.ts";
import { executePlanned } from "../src/services/plannedExecutionService.ts";
import {
  asPlannedTransactionId,
  asTransactionId,
} from "@vision/types/brands";
import type { PlannedTransactionId } from "@vision/types/brands";
import { must } from "./helpers/must.ts";
import { valueAt } from "./helpers/responseBody.ts";

interface IdRow {
  id: number;
}

type ExecutePlannedResult = Awaited<ReturnType<typeof executePlanned>>;

describe(
  "planned execution concurrency (real DB)",
  () => {
    const plannedIds: number[] = [];
    const transactionIds: number[] = [];
    const recipientIds: number[] = [];

    afterEach(async () => {
      await must(getTestPool(), "test pool").query(
        "DELETE FROM planned_transactions WHERE id IN (SELECT value FROM json_each($1))",
        [JSON.stringify(plannedIds.splice(0))],
      );
      await must(getTestPool(), "test pool").query(
        "DELETE FROM transactions WHERE id IN (SELECT value FROM json_each($1))",
        [JSON.stringify(transactionIds.splice(0))],
      );
      await must(getTestPool(), "test pool").query(
        "DELETE FROM recipients WHERE id IN (SELECT value FROM json_each($1))",
        [JSON.stringify(recipientIds.splice(0))],
      );
    });

    afterAll(async () => {
      await closeTestPool();
      await closePool();
    });

    async function fixture({
      max = null,
      end = null,
    }: { max?: number | null; end?: string | null } = {}) {
      const pool = must(getTestPool(), "test pool");
      const recipient = await pool.query<IdRow>(
        "INSERT INTO recipients (name, normalized_name) VALUES ('Concurrency fixture', 'concurrency fixture') RETURNING id",
      );
      recipientIds.push(must(recipient.rows[0], "recipient.rows[0]").id);
      const transactions = await pool.query<IdRow>(
        "INSERT INTO transactions (date, amount, currency, recipient_id) VALUES ('2026-07-01', vision_numeric('-10.00', 18, 4), 'EUR', $1), ('2026-08-01', vision_numeric('-10.00', 18, 4), 'EUR', $1) RETURNING id",
        [must(recipient.rows[0], "recipient.rows[0]").id],
      );
      const ids = transactions.rows.map((row: { id: number }) => row.id);
      transactionIds.push(...ids);
      const planned = await pool.query<IdRow>(
        "INSERT INTO planned_transactions (planned_date, amount, currency, is_recurring, recurrence_pattern, max_occurrences, recurrence_end_date) VALUES ('2026-07-01', vision_numeric('-10.00', 18, 4), 'EUR', true, 'monthly', $1, $2) RETURNING id",
        [max, end],
      );
      const id = asPlannedTransactionId(must(planned.rows[0], "planned row").id);
      plannedIds.push(id);
      return { id, ids };
    }

    // Hold the single writer until both application transactions have queued
    // behind it. PostgreSQL held the parent row FOR UPDATE and polled
    // pg_stat_activity for two lock waiters; under SQLite every
    // withTransaction() is BEGIN IMMEDIATE on the one writer connection, so the
    // guarantee to prove is that neither execution gets anywhere while another
    // write transaction is open, and that they then run one after the other.
    async function concurrently(
      id: PlannedTransactionId,
      ids: number[],
      expectedOccurrence?: string,
    ) {
      let releaseGate: (() => void) | undefined;
      let gateHeld: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        gateHeld = resolve;
      });
      const gate = withTransaction(async (client) => {
        await client.query("SELECT id FROM planned_transactions WHERE id = $1", [id]);
        gateHeld?.();
        await new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
      });
      await held;
      // Started outside the gate's callback, so they do not join its
      // transaction: each opens its own and waits for the writer.
      let settled = 0;
      const outcomes = Promise.allSettled(
        ids.map((executedTransactionId: number) =>
          executePlanned({
            id,
            executedTransactionId: asTransactionId(executedTransactionId),
            executionDate: "2026-07-01",
            expectedOccurrence,
          }).finally(() => {
            settled += 1;
          }),
        ),
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(settled).toBe(0);
        expect(await persisted(id)).toMatchObject({ count: 0 });
      } finally {
        releaseGate?.();
        await gate;
      }
      return await outcomes;
    }

    async function persisted(id: number) {
      const { rows } = await must(getTestPool(), "test pool").query<{ day: string; is_executed: boolean; count: number }>(
        "SELECT to_char(planned_date, 'YYYY-MM-DD') AS day, is_executed, (SELECT count(*) FROM planned_transaction_executions WHERE planned_transaction_id = pt.id) AS count FROM planned_transactions pt WHERE id = $1",
        [id],
      );
      return rows[0];
    }

    it.each([undefined, "2026-07-01"])(
      "rejects inactive payments without advancing (expected occurrence %s)",
      async (expectedOccurrence) => {
        const { id, ids } = await fixture();
        await must(getTestPool(), "test pool").query(
          "UPDATE transactions SET is_active = false WHERE id = $1",
          [ids[0]],
        );
        await expect(
          executePlanned({
            id,
            executedTransactionId: asTransactionId(must(ids[0], "ids[0]")),
            expectedOccurrence,
          }),
        ).rejects.toMatchObject({ status: 409 });
        expect(await persisted(id)).toEqual({
          day: "2026-07-01",
          count: 0,
          is_executed: false,
        });
      },
    );

    it("replays an existing execution even if its ledger row was later deactivated", async () => {
      const { id, ids } = await fixture();
      await executePlanned({ id, executedTransactionId: asTransactionId(must(ids[0], "ids[0]")) });
      const before = await persisted(id);
      await must(getTestPool(), "test pool").query(
        "UPDATE transactions SET is_active = false WHERE id = $1",
        [ids[0]],
      );
      await expect(
        executePlanned({ id, executedTransactionId: asTransactionId(must(ids[0], "ids[0]")) }),
      ).resolves.toMatchObject({ duplicate: true });
      expect(await persisted(id)).toEqual(before);
    });

    it("rejects a different currency without advancing or recording execution", async () => {
      const { id, ids } = await fixture();
      await must(getTestPool(), "test pool").query(
        "UPDATE transactions SET currency = 'USD' WHERE id = $1",
        [ids[0]],
      );
      await expect(
        executePlanned({ id, executedTransactionId: asTransactionId(must(ids[0], "ids[0]")) }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await persisted(id)).toEqual({
        day: "2026-07-01",
        count: 0,
        is_executed: false,
      });
    });

    it("allows only one payment for a one-off, but accepts its replay", async () => {
      const { id, ids } = await fixture();
      await must(getTestPool(), "test pool").query(
        "UPDATE planned_transactions SET is_recurring = false WHERE id = $1",
        [id],
      );
      const results = await concurrently(id, ids);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await persisted(id)).toEqual({
        day: "2026-07-01",
        count: 1,
        is_executed: true,
      });
    });

    it("serializes two automatic matches for the same recurring occurrence", async () => {
      const { id, ids } = await fixture();
      await must(getTestPool(), "test pool").query(
        "UPDATE planned_transactions SET recipient_id = (SELECT recipient_id FROM transactions WHERE id = $2) WHERE id = $1",
        [id, ids[0]],
      );
      await must(getTestPool(), "test pool").query(
        "UPDATE transactions SET date = '2026-07-01' WHERE id IN (SELECT value FROM json_each($1))",
        [JSON.stringify(ids)],
      );
      const results = await concurrently(id, ids, "2026-07-01");
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await persisted(id)).toEqual({
        day: "2026-08-01",
        count: 1,
        is_executed: false,
      });
    });

    it("rejects a stale automatic occurrence after a concurrent execution", async () => {
      const { id, ids } = await fixture();
      await must(getTestPool(), "test pool").query(
        "UPDATE planned_transactions SET recipient_id = (SELECT recipient_id FROM transactions WHERE id = $2) WHERE id = $1",
        [id, ids[0]],
      );
      await executePlanned({
        id,
        executedTransactionId: asTransactionId(must(ids[0], "ids[0]")),
        expectedOccurrence: "2026-07-01",
        hydrateResult: false,
      });
      await expect(
        executePlanned({
          id,
          executedTransactionId: asTransactionId(must(ids[1], "ids[1]")),
          expectedOccurrence: "2026-07-01",
          hydrateResult: false,
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await persisted(id)).toEqual({
        day: "2026-08-01",
        count: 1,
        is_executed: false,
      });
    });

    it("preserves earlier and latest executions when single or bulk deletion is rejected", async () => {
      const { id, ids } = await fixture();
      await executePlanned({ id, executedTransactionId: asTransactionId(must(ids[0], "ids[0]")) });
      await executePlanned({ id, executedTransactionId: asTransactionId(must(ids[1], "ids[1]")) });
      await expect(
        transactionRepository.hardDelete(asTransactionId(must(ids[0], "ids[0]"))),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        transactionRepository.hardDelete(asTransactionId(must(ids[1], "ids[1]"))),
      ).rejects.toMatchObject({ status: 409 });
      await expect(bulkDeleteTransactions({ ids })).rejects.toMatchObject({
        status: 409,
      });
      expect(await persisted(id)).toEqual({
        day: "2026-09-01",
        count: 2,
        is_executed: false,
      });
      expect(
        (
          await must(getTestPool(), "test pool").query<IdRow>(
            "SELECT id FROM transactions WHERE id IN (SELECT value FROM json_each($1))",
            [JSON.stringify(ids)],
          )
        ).rowCount,
      ).toBe(2);
    });

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
      const results = await concurrently(id, [must(ids[0], "ids[0]"), must(ids[0], "ids[0]")]);
      expect(
        results
          .map(
            (result) =>
              (result as PromiseFulfilledResult<ExecutePlannedResult>).value
                .duplicate,
          )
          .sort((a, b) => Number(a) - Number(b)),
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
        valueAt(
          (
            results.find(
              (result) => result.status === "rejected",
            ) as PromiseRejectedResult
          ).reason,
          "status",
        ),
      ).toBe(409);
      expect(await persisted(id)).toEqual({
        day: "2026-07-01",
        count: 1,
        is_executed: true,
      });
      const execution = await must(getTestPool(), "test pool").query<{ executed_transaction_id: number }>(
        "SELECT executed_transaction_id FROM planned_transaction_executions WHERE planned_transaction_id = $1",
        [id],
      );
      await expect(
        executePlanned({
          id,
          executedTransactionId: asTransactionId(
            must(execution.rows[0], "execution row").executed_transaction_id,
          ),
        }),
      ).resolves.toMatchObject({ duplicate: true });
      expect(must((await persisted(id)), "persisted result").count).toBe(1);
    });

    it("does not execute a second payment after end-date completion", async () => {
      const { id, ids } = await fixture({ end: "2026-07-15" });
      await executePlanned({
        id,
        executedTransactionId: asTransactionId(must(ids[0], "ids[0]")),
        executionDate: "2026-07-01",
      });
      await expect(
        executePlanned({ id, executedTransactionId: asTransactionId(must(ids[1], "ids[1]")) }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await persisted(id)).toEqual({
        day: "2026-07-01",
        count: 1,
        is_executed: true,
      });
      await expect(
        executePlanned({ id, executedTransactionId: asTransactionId(must(ids[0], "ids[0]")) }),
      ).resolves.toMatchObject({ duplicate: true });
    });
  },
);
