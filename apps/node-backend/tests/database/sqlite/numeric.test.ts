/**
 * NUMERIC golden tests: every vector's expected output was produced by
 * PostgreSQL 18.6 (see numeric.golden.json); the same inputs go through the
 * SQL functions a Vision SQLite connection registers.
 */
import { describe, expect, it } from "vitest";

import { loadFixture, openDb, outcome, scalar, sha256 } from "./harness.ts";
import type { SqlArg } from "./harness.ts";

interface Vector {
  op: string;
  args: SqlArg[];
  pg?: string | null;
  pgList?: (string | null)[];
  pgLength?: number;
  pgSha256?: string;
  error?: string;
}

const vectors = loadFixture<Vector>("numeric.golden.json");
const db = openDb();
db.exec("CREATE TABLE t (i INTEGER NOT NULL, x TEXT)");

const unarySql: Record<string, string> = {
  parse: "SELECT dec(?)",
  neg: "SELECT dec_neg(?)",
  abs: "SELECT dec_abs(?)",
  sign: "SELECT dec_sign(?)",
  floor: "SELECT dec_floor(?)",
  ceil: "SELECT dec_ceil(?)",
  round0: "SELECT dec_round(?)",
  trunc0: "SELECT dec_trunc(?)",
  int: "SELECT CAST(dec_int(?) AS TEXT)",
  real: "SELECT dec_real(?)",
  add: "SELECT dec_add(?, ?)",
  sub: "SELECT dec_sub(?, ?)",
  mul: "SELECT dec_mul(?, ?)",
  div: "SELECT dec_div(?, ?)",
  mod: "SELECT dec_mod(?, ?)",
  round: "SELECT dec_round(?, ?)",
  trunc: "SELECT dec_trunc(?, ?)",
  typmod: "SELECT vision_numeric(?, ?, ?)",
  cmp: "SELECT dec_cmp(?, ?)",
};

function loadSet(values: SqlArg[]): void {
  db.exec("DELETE FROM t");
  const insert = db.prepare("INSERT INTO t (i, x) VALUES (?, ?)");
  values.forEach((x, i) => insert.run(i + 1, x));
}

const setSql: Record<string, string> = {
  sum: "SELECT dec_sum(x) FROM t",
  avg: "SELECT dec_avg(x) FROM t",
  max: "SELECT dec_max(x) FROM t",
  min: "SELECT dec_min(x) FROM t",
  window_sum:
    "SELECT json_group_array(s) FROM (SELECT dec_sum(x) OVER (ORDER BY i ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS s FROM t ORDER BY i)",
  window_avg:
    "SELECT json_group_array(s) FROM (SELECT dec_avg(x) OVER (ORDER BY i ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS s FROM t ORDER BY i)",
  order: "SELECT json_group_array(dec(x)) FROM (SELECT x FROM t ORDER BY dec_key(x), i)",
};

/** Our result as PostgreSQL's text output, so both sides compare as strings. */
function run(v: Vector): { value: string | null } | { error: string } {
  return outcome(() => {
    let out: unknown;
    const sql = unarySql[v.op];
    if (sql !== undefined) out = scalar(db, sql, ...v.args);
    else if (v.op === "greatest" || v.op === "least") {
      const fn = v.op === "greatest" ? "dec_greatest" : "dec_least";
      out = scalar(db, `SELECT ${fn}(${v.args.map(() => "?").join(", ")})`, ...v.args);
    } else {
      const set = setSql[v.op];
      if (set === undefined) throw new Error(`unknown op ${v.op}`);
      loadSet(v.args);
      out = scalar(db, set);
    }
    return out === null ? null : typeof out === "number" || typeof out === "string" ? String(out) : JSON.stringify(out);
  });
}

function expected(v: Vector): string {
  if (v.error !== undefined) return `error ${v.error}`;
  if (v.pgList !== undefined) return `list ${JSON.stringify(v.pgList)}`;
  if (v.pgSha256 !== undefined) return `length ${v.pgLength} sha256 ${v.pgSha256}`;
  return `value ${JSON.stringify(v.pg)}`;
}

function actual(v: Vector, got: { value: string | null } | { error: string }): string {
  if ("error" in got) return `error ${got.error}`;
  if (v.pgSha256 !== undefined && got.value !== null) {
    return `length ${got.value.length} sha256 ${sha256(got.value)}`;
  }
  if (got.value !== null && v.pgList !== undefined) return `list ${JSON.stringify(JSON.parse(got.value))}`;
  if (got.value !== null && v.op === "real" && v.pg !== null && v.pg !== undefined) {
    return Number(got.value) === Number(v.pg) ? `value ${JSON.stringify(v.pg)}` : `value ${got.value}`;
  }
  return `value ${JSON.stringify(got.value)}`;
}


const ops = [...new Set(vectors.map((v) => v.op))];

describe("NUMERIC functions match PostgreSQL 18", () => {
  it("has the golden vectors", () => {
    expect(vectors.length).toBeGreaterThan(2500);
  });

  for (const op of ops) {
    it(op, () => {
      const mismatches: string[] = [];
      for (const v of vectors) {
        if (v.op !== op) continue;
        const want = expected(v);
        const got = actual(v, run(v));
        if (got !== want) {
          mismatches.push(`${op}(${v.args.map((a) => JSON.stringify(a)).join(", ").slice(0, 200)}): want ${want.slice(0, 200)}, got ${got.slice(0, 200)}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  it("dec_cmp agrees with the comparison functions", () => {
    for (const v of vectors) {
      if (v.op !== "cmp" || v.pg === undefined || v.pg === null) continue;
      const c = Number(v.pg);
      const [a, b] = v.args;
      expect(scalar(db, "SELECT dec_lt(?, ?)", a ?? null, b ?? null)).toBe(c < 0 ? 1 : 0);
      expect(scalar(db, "SELECT dec_le(?, ?)", a ?? null, b ?? null)).toBe(c <= 0 ? 1 : 0);
      expect(scalar(db, "SELECT dec_gt(?, ?)", a ?? null, b ?? null)).toBe(c > 0 ? 1 : 0);
      expect(scalar(db, "SELECT dec_ge(?, ?)", a ?? null, b ?? null)).toBe(c >= 0 ? 1 : 0);
      expect(scalar(db, "SELECT dec_eq(?, ?)", a ?? null, b ?? null)).toBe(c === 0 ? 1 : 0);
      expect(scalar(db, "SELECT dec_ne(?, ?)", a ?? null, b ?? null)).toBe(c !== 0 ? 1 : 0);
    }
  });

  it("vision_numeric_ok accepts exactly PostgreSQL's numeric(p,s) output", () => {
    for (const v of vectors) {
      if (v.op !== "typmod" || typeof v.pg !== "string") continue;
      const [, p, s] = v.args;
      expect(scalar(db, "SELECT vision_numeric_ok(?, ?, ?)", v.pg, p ?? null, s ?? null)).toBe(1);
      expect(scalar(db, "SELECT vision_numeric_ok(?, NULL, NULL)", v.pg)).toBe(1);
      if (typeof s === "number" && s > 0) {
        expect(scalar(db, "SELECT vision_numeric_ok(?, ?, ?)", `${v.pg}0`, p ?? null, s)).toBe(0);
      }
    }
    expect(scalar(db, "SELECT vision_numeric_ok('-0', NULL, NULL)")).toBe(0);
    expect(scalar(db, "SELECT vision_numeric_ok('+1', NULL, NULL)")).toBe(0);
    expect(scalar(db, "SELECT vision_numeric_ok('1e2', NULL, NULL)")).toBe(0);
    expect(scalar(db, "SELECT vision_numeric_ok('.5', NULL, NULL)")).toBe(0);
    expect(scalar(db, "SELECT vision_numeric_ok(' 1', NULL, NULL)")).toBe(0);
    expect(scalar(db, "SELECT vision_numeric_ok(NULL, 18, 2)")).toBe(null);
    expect(scalar(db, "SELECT vision_numeric_ok(12.5, 18, 2)")).toBe(0);
  });

  it("refuses floating-point input instead of rounding it silently", () => {
    expect(outcome(() => scalar(db, "SELECT dec_add(0.1, '1')"))).toEqual({ error: "42804" });
    expect(scalar(db, "SELECT dec_add(2, '1.5')")).toBe("3.5");
    expect(scalar(db, "SELECT dec_add('1', NULL)")).toBe(null);
  });
});
