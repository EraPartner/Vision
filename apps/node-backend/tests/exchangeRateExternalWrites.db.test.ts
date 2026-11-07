/**
 * The latest-rate cache reloads after another connection commits (ADR-270
 * decision 4): during the Swift port the app's in-process backend writes
 * `exchange_rates` on its own connection, and Bun must not keep serving the
 * rates it cached before.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, openDatabase } from "../src/database/connection.ts";
import {
  clearMemoryCache,
  loadCurrentRates,
} from "../src/services/currency/currencyConversionService.ts";
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

describe("exchange-rate cache and other writers", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    clearMemoryCache();
    await getTestPool().query(
      `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest)
       VALUES ('USD', vision_numeric('0.9', 20, 10), '2026-01-02', 1)`,
    );
  });

  afterAll(async () => {
    clearMemoryCache();
    await closePool();
  });

  it("serves the cached rate until another connection commits", async () => {
    expect((await loadCurrentRates()).USD).toBe(0.9);

    writeOnOtherConnection(
      `UPDATE exchange_rates SET rate_to_eur = vision_numeric('0.8', 20, 10), updated_at = now()
       WHERE currency_code = 'USD'`,
    );

    expect((await loadCurrentRates()).USD).toBe(0.8);
  });

  it("keeps the cache across this process's own writes", async () => {
    expect((await loadCurrentRates()).USD).toBe(0.9);

    await getTestPool().query(
      `UPDATE exchange_rates SET rate_to_eur = vision_numeric('0.7', 20, 10), updated_at = now()
       WHERE currency_code = 'USD'`,
    );

    // Bun's own writers clear the cache themselves; a raw fixture write does not.
    expect((await loadCurrentRates()).USD).toBe(0.9);
  });
});
