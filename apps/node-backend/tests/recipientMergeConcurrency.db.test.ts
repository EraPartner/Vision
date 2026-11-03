import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeTestPool, getTestPool } from "./setup/db.ts";
import { closePool, withTransaction } from "../src/database/connection.ts";
import { mergeRecipients } from "../src/services/recipientMergeService.ts";
import { must } from "./helpers/must.ts";
import type { RecipientId } from "@vision/types/brands";

/** `IN (...)` parameter: the ids as one JSON array. */
const idList = (ids: readonly number[]) => JSON.stringify(ids);

describe(
  "recipient merge concurrency (real DB)",
  () => {
    const ids: number[] = [];
    afterEach(async () => {
      await getTestPool().query(
        "UPDATE recipients SET primary_recipient_id = NULL WHERE id IN (SELECT value FROM json_each($1))",
        [idList(ids)],
      );
      await getTestPool().query(
        "DELETE FROM recipients WHERE id IN (SELECT value FROM json_each($1))",
        [idList(ids.splice(0))],
      );
    });
    afterAll(async () => {
      await closeTestPool();
      await closePool();
    });
    async function fixture() {
      const result = await getTestPool().query<{
        id: RecipientId;
      }>(
        "INSERT INTO recipients (name, normalized_name) VALUES ('Merge A', 'merge a'), ('Merge B', 'merge b'), ('Merge C', 'merge c') RETURNING id",
      );
      const [a, b, c] = result.rows.map((r) => r.id).sort((x, y) => x - y);
      const created: [RecipientId, RecipientId, RecipientId] = [
        must(a, "recipient A"),
        must(b, "recipient B"),
        must(c, "recipient C"),
      ];
      ids.push(...created);
      return created;
    }
    // PostgreSQL held B's row lock in a gate transaction and waited in
    // pg_stat_activity for both merges to block on it. SQLite has no row
    // locks: the guarantee comes from the single writer, where every merge is
    // one BEGIN IMMEDIATE transaction queued behind any open one. The gate is
    // therefore an open write transaction; both merges queue behind it, run
    // one after the other in arrival order, and the second revalidates B.
    it("revalidates B after B into A wins the write lock ahead of C into B", async () => {
      const [a, b, c] = await fixture();
      const outcomes: Promise<{ value?: unknown; error?: unknown }>[] = [];
      let releaseGate!: () => void;
      const gateOpen = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let gateHeld!: () => void;
      const held = new Promise<void>((resolve) => {
        gateHeld = resolve;
      });
      const gate = withTransaction(async () => {
        gateHeld();
        await gateOpen;
      });
      try {
        await held;
        // Started outside the gate's context, so each merge queues for the
        // write lock instead of joining the gate's transaction. Rejections
        // become values immediately to avoid unhandled promises.
        for (const [primary, alias] of [
          [a, b],
          [b, c],
        ] as const) {
          outcomes.push(
            mergeRecipients(primary, [alias]).then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            ),
          );
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        // Neither merge can have written while the gate holds the writer.
        const during = await getTestPool().query(
          "SELECT id, primary_recipient_id FROM recipients WHERE id IN (SELECT value FROM json_each($1)) ORDER BY id",
          [idList([a, b, c])],
        );
        expect(during.rows.every((row) => row.primary_recipient_id === null)).toBe(true);
      } finally {
        releaseGate();
        await gate;
      }
      const [first, second] = await Promise.all(outcomes);
      expect(must(first, "first").error).toBeUndefined();
      expect(must(second, "second").error).toMatchObject({ status: 409 });
      const result = await getTestPool().query(
        "SELECT id, primary_recipient_id FROM recipients WHERE id IN (SELECT value FROM json_each($1)) ORDER BY id",
        [idList([a, b, c])],
      );
      expect(result.rows).toEqual([
        { id: a, primary_recipient_id: null },
        { id: b, primary_recipient_id: a },
        { id: c, primary_recipient_id: null },
      ]);
    });
    it("gives one consistent result when the two merges race without a gate", async () => {
      const [a, b, c] = await fixture();
      const settled = await Promise.allSettled([
        mergeRecipients(a, [b]),
        mergeRecipients(b, [c]),
      ]);
      expect(settled[0].status).toBe("fulfilled");
      expect(settled[1]).toMatchObject({
        status: "rejected",
        reason: { status: 409 },
      });
      const result = await getTestPool().query(
        "SELECT id, primary_recipient_id FROM recipients WHERE id IN (SELECT value FROM json_each($1)) ORDER BY id",
        [idList([a, b, c])],
      );
      expect(result.rows).toEqual([
        { id: a, primary_recipient_id: null },
        { id: b, primary_recipient_id: a },
        { id: c, primary_recipient_id: null },
      ]);
    });
    it("retains one-level aliases when C into B completes before B into A", async () => {
      const [a, b, c] = await fixture();
      await mergeRecipients(b, [c]);
      await mergeRecipients(a, [b]);
      const result = await getTestPool().query(
        "SELECT primary_recipient_id FROM recipients WHERE id IN (SELECT value FROM json_each($1)) ORDER BY id",
        [idList([b, c])],
      );
      expect(result.rows).toEqual([
        { primary_recipient_id: a },
        { primary_recipient_id: a },
      ]);
      await expect(mergeRecipients(b, [c])).rejects.toMatchObject({
        status: 409,
      });
    });
  },
);
