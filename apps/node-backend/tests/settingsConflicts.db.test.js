import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  releaseDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
} from "./setup/db.js";
import { closePool } from "../src/database/connection.js";
import { createDailyJob } from "../src/startup/dailyJobs.js";
import repo from "../src/repositories/settingsRepository.js";
const pool = getTestPool();
const keys = ["vision_test_conflict_a", "vision_test_conflict_b"];
describe.skipIf(!hasTestDatabase())(
  "settings conflict SQL against disposable PostgreSQL",
  () => {
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180000);
    afterAll(async () => {
      try {
        await pool.query("DELETE FROM user_settings WHERE key=ANY($1)", [
          [...keys, "daily_job_vision_test"],
        ]);
      } finally {
        try {
          await releaseDbSuiteLock();
        } finally {
          try {
            await closeTestPool();
          } finally {
            await closePool();
          }
        }
      }
    });
    it("persists daily completion across scheduler recreation", async () => {
      await pool.query("DELETE FROM user_settings WHERE key=$1", [
        "daily_job_vision_test",
      ]);
      let runs = 0;
      const now = () => 10 * 86400000;
      const run = async () => {
        runs++;
        return true;
      };
      await createDailyJob("vision_test", run, { store: repo, now })();
      await createDailyJob("vision_test", run, { store: repo, now })();
      expect(runs).toBe(1);
      expect(await repo.get("daily_job_vision_test")).toBe(now());
    });
    it("permits one concurrent creator, then rejects stale replacement and deletion", async () => {
      await pool.query("DELETE FROM user_settings WHERE key=ANY($1)", [
        [...keys, "daily_job_vision_test"],
      ]);
      const created = await Promise.allSettled([
        repo.replace(keys[0], { a: 1 }, { exists: false }),
        repo.replace(keys[0], { b: 2 }, { exists: false }),
      ]);
      expect(created.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        created.filter((r) => r.status === "rejected")[0].reason.status,
      ).toBe(409);
      const old = (await repo.getRecord(keys[0])).expected;
      await repo.replace(keys[0], { nested: { only: true } }, old);
      await expect(
        repo.replace(keys[0], { sibling: true }, old),
      ).rejects.toMatchObject({ status: 409 });
      await expect(repo.deleteExpected(keys[0], old)).rejects.toMatchObject({
        status: 409,
      });
      expect(await repo.get(keys[0])).toEqual({ nested: { only: true } });
    });
    it("rolls back the entire bulk save on conflict and handles JSON null separately from absence", async () => {
      await repo.set(keys[0], null);
      await repo.set(keys[1], [1, 2]);
      await expect(
        repo.replaceMany(
          { [keys[0]]: { replaced: true }, [keys[1]]: [] },
          {
            [keys[0]]: { exists: true, value: null },
            [keys[1]]: { exists: true, value: [9] },
          },
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect((await repo.getRecord(keys[0])).expected).toEqual({
        exists: true,
        value: null,
      });
      expect(await repo.get(keys[1])).toEqual([1, 2]);
    });
  },
);
