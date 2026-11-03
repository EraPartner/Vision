import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  closeTestPool,
  getTestPool,
  hasTestDatabase,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import {
  clearHistoricalCache,
  getRateToEurForDate,
} from "../src/services/currency/rateFetcher.ts";
import { must } from "./helpers/must.ts";

describe.skipIf(!hasTestDatabase())("historical FX database fallback", () => {
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
    await must(getTestPool(), "getTestPool()").query(
      "DELETE FROM exchange_rates WHERE currency_code = 'USD' AND rate_date IN ('1950-01-01', '1950-01-10', '1950-01-31')",
    );
  });
  afterAll(async () => {
    await closeTestPool();
    await closePool();
  });

  it("does not use a future database quote when providers fail", async () => {
    await must(getTestPool(), "getTestPool()").query(
      "INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest) VALUES ('USD', vision_numeric('0.8', 20, 10), '1950-01-10', 0)",
    );
    expect(await getRateToEurForDate("USD", "1950-01-09")).toBeUndefined();
  });

  it("uses the prior database quote even when the future one is closer", async () => {
    await must(getTestPool(), "getTestPool()").query(
      "INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest) VALUES ('USD', vision_numeric('0.9', 20, 10), '1950-01-01', 0), ('USD', vision_numeric('0.8', 20, 10), '1950-01-10', 0)",
    );
    expect(await getRateToEurForDate("USD", "1950-01-09")).toBeCloseTo(0.9);
  });

  it("matches a month-end quote on the day itself, not the day before", async () => {
    // DATE_TEXT compares as calendar-day text: the 31st is on-or-before the
    // 31st and after the 30th, with no time-of-day or DST shift.
    await must(getTestPool(), "getTestPool()").query(
      "INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest) VALUES ('USD', vision_numeric('0.9', 20, 10), '1950-01-01', 0), ('USD', vision_numeric('0.123456789', 20, 10), '1950-01-31', 0)",
    );
    expect(await getRateToEurForDate("USD", "1950-01-31")).toBe(0.123456789);
    expect(await getRateToEurForDate("USD", "1950-01-30")).toBe(0.9);
  });
});
