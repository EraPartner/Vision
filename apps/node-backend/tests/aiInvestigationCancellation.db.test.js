import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  releaseDbSuiteLock,
} from "./setup/db.js";
import {
  finishJob,
  requestCancel,
  setProviderResult,
} from "../src/repositories/aiInvestigationRepository.js";

const pool = getTestPool();

beforeAll(acquireDbSuiteLock, 180_000);
afterAll(async () => {
  await releaseDbSuiteLock();
  await closeTestPool();
});

describe("cloud investigation cancellation at the database boundary", () => {
  it.skipIf(!pool)(
    "keeps a cancelled job cancelled when a provider answer arrives afterward",
    async () => {
      const inserted = await pool.query(
        `INSERT INTO ai_investigation_jobs
           (question, route, depth, language, state, scope_json)
         VALUES ('Fictional question', 'openai-api', 'quick', 'en', 'running', '{}'::jsonb)
         RETURNING id`,
      );
      const id = inserted.rows[0].id;
      try {
        await setProviderResult(id, { summary: "Fictional provider answer" });
        await requestCancel(id);
        expect(
          await setProviderResult(id, { summary: "Late provider answer" }),
        ).toBeUndefined();
        const finished = await finishJob(id, "completed", {
          summary: "Late provider answer",
        });
        expect(finished.state).toBe("cancelled");
        expect(finished.result).toBeNull();
        expect(finished.error).toEqual({ code: "CANCELLED" });
        expect(finished.checkpoint).not.toHaveProperty("providerResult");
      } finally {
        await pool.query("DELETE FROM ai_investigation_jobs WHERE id=$1", [id]);
      }
    },
  );
});
