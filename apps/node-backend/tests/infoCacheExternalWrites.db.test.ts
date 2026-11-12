/**
 * The /api/info response caches drop their entries after another connection
 * commits (ADR-270 decision 4): the Swift app's in-process backend writes
 * `accounts` on its own connection, and Bun must not keep serving the net
 * worth, bank balances or statistics it cached before.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, openDatabase } from "../src/database/connection.ts";
import {
  invalidatePortfolioCaches,
  invalidateStatisticsCaches,
  netWorthResponseCache,
  resolveCacheWithInflight,
} from "../src/services/info/cache.ts";
import { getTestPool, resetTestDatabase } from "./setup/db.ts";

function databaseFile(): string {
  const file = process.env.VISION_DATABASE_PATH;
  if (!file) throw new Error("The SQLite test harness is not set up");
  return file;
}

/** A commit made on a connection of its own, as the Swift backend makes it. */
function writeOnOtherConnection(sqlText: string): void {
  const other = openDatabase(databaseFile(), "writer");
  try {
    other.exec(sqlText);
  } finally {
    other.close();
  }
}

async function cachedNetWorth(value: string): Promise<string> {
  return resolveCacheWithInflight(netWorthResponseCache, "EUR", {
    ttlMs: 60_000,
    loader: () => Promise.resolve(value),
  });
}

describe("info caches and other writers", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    invalidatePortfolioCaches();
    invalidateStatisticsCaches();
  });

  afterAll(async () => {
    invalidatePortfolioCaches();
    await closePool();
  });

  it("serves the cached response until another connection commits", async () => {
    expect(await cachedNetWorth("before")).toBe("before");
    expect(await cachedNetWorth("unused")).toBe("before");

    writeOnOtherConnection(
      `INSERT INTO accounts (name, currency) VALUES ('Written by Swift', 'EUR')`,
    );

    expect(await cachedNetWorth("after")).toBe("after");
  });

  it("keeps the cache across this process's own writes", async () => {
    expect(await cachedNetWorth("before")).toBe("before");

    await getTestPool().query(
      `INSERT INTO accounts (name, currency) VALUES ('Written by Bun', 'EUR')`,
    );

    // Bun's own write funnels clear the caches themselves; a raw fixture write does not.
    expect(await cachedNetWorth("unused")).toBe("before");
  });
});
