import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { closePool } from "../src/database/connection.ts";
import { mergeRecipients } from "../src/services/recipientMergeService.js";

describe.skipIf(!hasTestDatabase())(
  "recipient merge concurrency (real DB)",
  () => {
    const ids = [];
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180_000);
    afterEach(async () => {
      await getTestPool().query(
        "UPDATE recipients SET primary_recipient_id = NULL WHERE id = ANY($1::int[])",
        [ids],
      );
      await getTestPool().query(
        "DELETE FROM recipients WHERE id = ANY($1::int[])",
        [ids.splice(0)],
      );
    });
    afterAll(async () => {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    });
    async function fixture() {
      const result = await getTestPool().query(
        "INSERT INTO recipients (name, normalized_name) VALUES ('Merge A', 'merge a'), ('Merge B', 'merge b'), ('Merge C', 'merge c') RETURNING id",
      );
      const created = result.rows.map((r) => r.id);
      ids.push(...created);
      return created;
    }
    async function waitForBlockedMerges(count) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = await getTestPool().query(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%recipients%'",
        );
        if (result.rows[0].count >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Merge transactions did not reach the lock gate");
    }
    it("revalidates B after B into A wins the lock ahead of C into B", async () => {
      const [a, b, c] = await fixture();
      const gate = await getTestPool().connect();
      const outcomes = [];
      try {
        await gate.query("BEGIN");
        await gate.query("SELECT id FROM recipients WHERE id = $1 FOR UPDATE", [
          b,
        ]);
        // Convert rejections into values immediately to avoid unhandled promises.
        outcomes.push(
          mergeRecipients(a, [b]).then(
            (value) => ({ value }),
            (error) => ({ error }),
          ),
        );
        await waitForBlockedMerges(1);
        outcomes.push(
          mergeRecipients(b, [c]).then(
            (value) => ({ value }),
            (error) => ({ error }),
          ),
        );
        await waitForBlockedMerges(2);
        await gate.query("COMMIT");
        const [first, second] = await Promise.all(outcomes);
        expect(first.error).toBeUndefined();
        expect(second.error).toMatchObject({ status: 409 });
        const result = await getTestPool().query(
          "SELECT id, primary_recipient_id FROM recipients WHERE id = ANY($1::int[]) ORDER BY id",
          [[a, b, c]],
        );
        expect(result.rows).toEqual([
          { id: a, primary_recipient_id: null },
          { id: b, primary_recipient_id: a },
          { id: c, primary_recipient_id: null },
        ]);
      } finally {
        await gate.query("ROLLBACK");
        gate.release();
        await Promise.all(outcomes);
      }
    });
    it("retains one-level aliases when C into B completes before B into A", async () => {
      const [a, b, c] = await fixture();
      await mergeRecipients(b, [c]);
      await mergeRecipients(a, [b]);
      const result = await getTestPool().query(
        "SELECT primary_recipient_id FROM recipients WHERE id = ANY($1::int[]) ORDER BY id",
        [[b, c]],
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
