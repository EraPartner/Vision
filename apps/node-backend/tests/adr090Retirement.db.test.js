import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";

const describeDb = hasTestDatabase() ? describe : describe.skip;

describeDb("ADR-090 transaction schema retirement", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
    await acquireDbSuiteLock();
  }, 180_000);

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
  });

  it("removes the retired link and narrows transfer_source", async () => {
    const pool = getTestPool();
    const column = await pool.query(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'transactions'
          AND column_name = 'portfolio_transaction_id'`,
    );
    expect(column.rows).toHaveLength(0);

    const constraint = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'public.transactions'::regclass
          AND conname = 'chk_transactions_transfer_source'`,
    );
    expect(constraint.rows).toHaveLength(1);
    const definition = constraint.rows[0].definition;
    expect(definition).toContain("'auto'::text");
    expect(definition).toContain("'manual'::text");
    expect(definition).toContain("'opening'::text");
    expect(definition).toContain("'adjustment'::text");
    expect(definition).not.toContain("'trade'::text");
  });
});
