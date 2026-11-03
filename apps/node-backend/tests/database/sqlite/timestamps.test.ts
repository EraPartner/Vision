/**
 * Date/time golden tests: expected outputs come from PostgreSQL 18.6 with
 * `TimeZone = 'Europe/Brussels'` (timestamps.golden.json). The functions read the
 * session zone from the process, so this file runs in the same zone.
 */
process.env.TZ = "Europe/Brussels";

import { describe, expect, it } from "vitest";

import { parseInterval } from "../../../src/database/sqlite/timestamps.ts";
import { loadFixture, openDb, outcome, scalar } from "./harness.ts";
import type { SqlArg } from "./harness.ts";

interface Vector {
  op: string;
  args: SqlArg[];
  pg?: string | null;
  error?: string;
}

const vectors = loadFixture<Vector>("timestamps.golden.json");
const db = openDb();

const sqlFor: Record<string, string> = {
  add_months_date: "SELECT add_months(?, ?)",
  add_days_date: "SELECT add_days(?, ?)",
  add_interval_date: "SELECT add_interval(?, ?)",
  sub_interval_date: "SELECT sub_interval(?, ?)",
  vision_ts: "SELECT vision_ts(?)",
  add_interval_ts: "SELECT add_interval(vision_ts(?), ?)",
  sub_interval_ts: "SELECT sub_interval(vision_ts(?), ?)",
  add_months_ts: "SELECT add_months(vision_ts(?), ?)",
  add_days_ts: "SELECT add_days(vision_ts(?), ?)",
  date_trunc_ts: "SELECT date_trunc(?, vision_ts(?))",
  date_trunc_date: "SELECT date_trunc(?, ?)",
  date_part_ts: "SELECT date_part(?, vision_ts(?))",
  date_part_date: "SELECT date_part(?, ?)",
  to_char_ts: "SELECT to_char(vision_ts(?), ?)",
  to_char_date: "SELECT to_char(?, ?)",
  ts_date: "SELECT ts_date(vision_ts(?))",
  month_end_ts: "SELECT month_end(vision_ts(?))",
  date_ts: "SELECT date_ts(?)",
  month_end: "SELECT month_end(?)",
  date_diff_days: "SELECT date_diff_days(?, ?)",
  month_diff: "SELECT month_diff(?, ?)",
  make_date: "SELECT make_date(?, ?, ?)",
};

function expected(v: Vector): string {
  if (v.error !== undefined) return `error ${v.error}`;
  // PostgreSQL turns date + clock time into a timestamp; Vision refuses it.
  if (typeof v.pg === "string" && v.pg.startsWith("time:")) return "error 22023";
  if (v.op.startsWith("date_part")) return `number ${Number(v.pg)}`;
  if (v.op === "interval_fields") return `value ${JSON.stringify(JSON.parse(v.pg ?? "null"))}`;
  return `value ${JSON.stringify(v.pg)}`;
}

function actual(v: Vector): string {
  const got = outcome(() => {
    if (v.op === "interval_fields") {
      const i = parseInterval(String(v.args[0]));
      return JSON.stringify([i.months, i.days, i.micros]);
    }
    const sql = sqlFor[v.op];
    if (sql === undefined) throw new Error(`unknown op ${v.op}`);
    return scalar(db, sql, ...v.args);
  });
  if ("error" in got) return `error ${got.error}`;
  if (v.op.startsWith("date_part")) return `number ${Number(got.value)}`;
  if (v.op === "interval_fields") return `value ${String(got.value)}`;
  const value = got.value;
  const text = typeof value === "string" || typeof value === "number" || typeof value === "bigint" ? String(value) : value;
  return `value ${JSON.stringify(text)}`;
}

describe("date and time functions match PostgreSQL 18 in Europe/Brussels", () => {
  it("runs in the Europe/Brussels zone", () => {
    expect(new Date("2026-07-01T12:00:00Z").getTimezoneOffset()).toBe(-120);
    expect(new Date("2026-01-01T12:00:00Z").getTimezoneOffset()).toBe(-60);
    expect(vectors.length).toBeGreaterThan(5000);
  });

  for (const op of [...new Set(vectors.map((v) => v.op))]) {
    it(op, () => {
      const mismatches: string[] = [];
      for (const v of vectors) {
        if (v.op !== op) continue;
        const want = expected(v);
        const got = actual(v);
        if (got !== want) mismatches.push(`${op}(${v.args.map((a) => JSON.stringify(a)).join(", ")}): want ${want}, got ${got}`);
      }
      expect(mismatches).toEqual([]);
    });
  }

  it("keeps a date a date and a timestamp a timestamp", () => {
    expect(scalar(db, "SELECT date_trunc('month', '2026-01-31')")).toBe("2026-01-01");
    expect(scalar(db, "SELECT date_trunc('month', '2026-01-31T12:00:00.000000Z')")).toBe("2025-12-31T23:00:00.000000Z");
    expect(scalar(db, "SELECT add_months('2026-01-31', 1)")).toBe("2026-02-28");
    expect(scalar(db, "SELECT typeof(date_part('year', '2026-01-31'))")).toBe("integer");
    expect(scalar(db, "SELECT typeof(date_part('epoch', '2026-01-31T12:00:00.500000Z'))")).toBe("real");
    expect(scalar(db, "SELECT typeof(date_diff_days('2026-03-01', '2026-02-01'))")).toBe("integer");
  });

  it("reads x::date as PostgreSQL does for stored timestamps and for written text", () => {
    // A stored timestamp is a timestamptz: its date in the session zone.
    expect(scalar(db, "SELECT ts_date(vision_ts('2026-01-05T23:30:00Z'))")).toBe("2026-01-06");
    expect(scalar(db, "SELECT ts_date('2026-01-05T23:30:00.000000Z')")).toBe("2026-01-06");
    // Other text is date input in PostgreSQL: the written date, whatever the clock or zone.
    expect(scalar(db, "SELECT ts_date('2026-01-05T23:30:00Z')")).toBe("2026-01-05");
    expect(scalar(db, "SELECT ts_date('2026-01-05T23:30:00.000Z')")).toBe("2026-01-05");
    expect(scalar(db, "SELECT ts_date('2026-01-05 01:00:00+14:00')")).toBe("2026-01-05");
    expect(scalar(db, "SELECT ts_date('2026-01-05')")).toBe("2026-01-05");
    expect(scalar(db, "SELECT ts_date(NULL)")).toBeNull();
    expect(outcome(() => scalar(db, "SELECT ts_date('2026-02-30T10:00:00Z')"))).toEqual({ error: "22008" });
    expect(outcome(() => scalar(db, "SELECT ts_date('2026-01-05Tnoon')"))).toEqual({ error: "22007" });
  });

  it("accepts only canonical storage text", () => {
    expect(scalar(db, "SELECT vision_ts_ok('2026-01-31T12:00:00.000000Z')")).toBe(1);
    expect(scalar(db, "SELECT vision_ts_ok('2026-01-31T12:00:00Z')")).toBe(0);
    expect(scalar(db, "SELECT vision_ts_ok('2026-01-31')")).toBe(0);
    expect(scalar(db, "SELECT vision_date_ok('2026-02-28')")).toBe(1);
    expect(scalar(db, "SELECT vision_date_ok('2026-02-29')")).toBe(0);
    expect(scalar(db, "SELECT vision_date_ok('2026-2-28')")).toBe(0);
  });
});
