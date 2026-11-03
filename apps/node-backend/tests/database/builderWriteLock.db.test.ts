/**
 * Builder queries and connection.ts's write lock (ADR-263): a builder write
 * outside a transaction that waits for the lock must not stop the
 * transaction holding the lock from running its own builder queries.
 */
import { describe, expect, it } from "vitest";

import { withTransaction } from "../../src/database/connection.ts";
import { db } from "../../src/database/db.ts";

describe("builder queries and the write lock", () => {
  it("let a transaction finish while a builder write outside it waits for the lock", { timeout: 3_000 }, async () => {
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const transaction = withTransaction(async () => {
      entered();
      await gate;
      return db.selectFrom("user_settings").select("key").execute();
    });
    await inside;
    // Outside the transaction: this write waits for the lock the transaction holds.
    const outside = db
      .deleteFrom("user_settings")
      .where("key", "=", "builder-write-lock-test")
      .execute();
    await new Promise((resolve) => setTimeout(resolve, 20));
    open();
    await expect(Promise.all([transaction, outside])).resolves.toHaveLength(2);
  });
});
