import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { closePool } from "../src/database/connection.js";
import {
  clearHistoricalCache,
  getRateToEurForDate,
} from "../src/services/currency/rateFetcher.js";

describe.skipIf(!hasTestDatabase())("historical FX database fallback", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
    await acquireDbSuiteLock();
  }, 180_000);
  beforeEach(() => {
    clearHistoricalCache();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    clearHistoricalCache();
    await getTestPool().query(
      "DELETE FROM exchange_rates WHERE currency_code = 'USD' AND rate_date IN ('1950-01-01', '1950-01-10')",
    );
  });
  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it("does not use a future database quote when providers fail", async () => {
    await getTestPool().query(
      "INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest) VALUES ('USD', 0.8, '1950-01-10', false)",
    );
    expect(await getRateToEurForDate("USD", "1950-01-09")).toBeUndefined();
  });

  it("uses the prior database quote even when the future one is closer", async () => {
    await getTestPool().query(
      "INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest) VALUES ('USD', 0.9, '1950-01-01', false), ('USD', 0.8, '1950-01-10', false)",
    );
    expect(await getRateToEurForDate("USD", "1950-01-09")).toBeCloseTo(0.9);
  });
});
