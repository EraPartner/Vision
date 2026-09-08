import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import insightDismissalRepository from "../src/repositories/insightDismissalRepository.js";
import insightCashProjectionRepository from "../src/repositories/insightCashProjectionRepository.js";
import { closePool } from "../src/database/connection.js";

const pool = getTestPool();
const describeDb = hasTestDatabase() ? describe : describe.skip;

async function wipe() {
  await pool.query("DELETE FROM insight_dismissals");
  await pool.query("DELETE FROM insight_cash_projections");
  await pool.query("DELETE FROM recipients WHERE name LIKE 'Insight DB %'");
  await pool.query("DELETE FROM categories WHERE general = 'INSIGHT_DB'");
  await pool.query(
    `UPDATE insight_digest_state
        SET undismissed_count = NULL, dirty_version = 1,
            computed_version = 0, computed_at = NULL, expires_at = NULL
      WHERE singleton_id = 1`,
  );
}

describeDb("insight dismissal persistence (real Postgres)", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
    await acquireDbSuiteLock();
  }, 180_000);

  beforeEach(wipe);

  afterAll(async () => {
    await wipe();
    await releaseDbSuiteLock();
    await closePool();
    await closeTestPool();
  });

  it("upserts subscription dismissals uniquely and cascades recipient deletion", async () => {
    const recipient = await pool.query(
      `INSERT INTO recipients (name, normalized_name)
       VALUES ('Insight DB Subscription', 'insight db subscription') RETURNING id`,
    );
    const id = Number(recipient.rows[0].id);
    await insightDismissalRepository.upsertSubscription("subscription_new", id);
    await insightDismissalRepository.upsertSubscription("subscription_new", id);
    const before = await pool.query(
      "SELECT count(*)::int AS count FROM insight_dismissals",
    );
    expect(before.rows[0].count).toBe(1);

    await pool.query("DELETE FROM recipients WHERE id = $1", [id]);
    const after = await pool.query(
      "SELECT count(*)::int AS count FROM insight_dismissals",
    );
    expect(after.rows[0].count).toBe(0);
  });

  it("dirties on source mutation and rejects a stale refresh version", async () => {
    const initial = await insightDismissalRepository.getCountState();
    const captured = Number(initial.dirty_version);
    await pool.query(
      "INSERT INTO categories (general, detail) VALUES ('INSIGHT_DB', 'RACE')",
    );

    expect(
      await insightDismissalRepository.saveCountIfVersion(9, captured),
    ).toBeUndefined();
    const final = await insightDismissalRepository.getCountState();
    expect(Number(final.dirty_version)).toBeGreaterThan(captured);
    expect(final.undismissed_count).toBeNull();
  });

  it("stores one current outlier threshold per category and month", async () => {
    const category = await pool.query(
      "INSERT INTO categories (general, detail) VALUES ('INSIGHT_DB', 'OUTLIER') RETURNING id",
    );
    const id = Number(category.rows[0].id);
    await insightDismissalRepository.upsertOutlier(id, "2026-09", 4.1);
    await insightDismissalRepository.upsertOutlier(id, "2026-09", 4.8);
    const rows = await insightDismissalRepository.listDismissals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "category_outlier",
      month_key: "2026-09",
      deviation_at_dismiss: 4.8,
    });
  });

  it("upserts one comparable cash projection per month, currency, and method", async () => {
    expect(
      await insightCashProjectionRepository.getProjection(
        "2026-09",
        "EUR",
        "ensemble_imse",
      ),
    ).toBeUndefined();
    await insightCashProjectionRepository.saveProjection(
      "2026-09",
      "EUR",
      "ensemble_imse",
      120,
    );
    await insightCashProjectionRepository.saveProjection(
      "2026-09",
      "EUR",
      "ensemble_imse",
      260,
    );
    await expect(
      insightCashProjectionRepository.getProjection(
        "2026-09",
        "EUR",
        "ensemble_imse",
      ),
    ).resolves.toBe(260);
  });
});
