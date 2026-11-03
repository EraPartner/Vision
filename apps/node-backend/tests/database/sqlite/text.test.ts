/**
 * Golden tests for the C-locale text functions: LIKE/ILIKE (with ESCAPE),
 * POSIX regular expressions, pg_trgm, jsonb `@>`, lower/upper, btrim,
 * GREATEST/LEAST and ORDER BY, against outputs captured from PostgreSQL 18.6.
 */
import { describe, expect, it } from "vitest";

import { showTrgm } from "../../../src/database/sqlite/text.ts";
import { loadFixture, openDb, outcome, scalar } from "./harness.ts";
import type { SqlArg } from "./harness.ts";

interface MatrixVector {
  op: "like" | "ilike" | "regex" | "regex_i";
  values: string[];
  patterns: string[];
  rows: string[];
  errors: (string | null)[];
}

interface SimilarityVector {
  op: "similarity";
  names: string[];
  upperTriangle: string[][];
}

interface ScalarVector {
  op: string;
  args: string[];
  pg?: string;
  error?: string;
  pgList?: string[];
}

type Vector = MatrixVector | SimilarityVector | ScalarVector;

const vectors = loadFixture<Vector>("text.golden.json");
const db = openDb();

function ofOp<V extends Vector>(op: string): V[] {
  return vectors.filter((v) => v.op === op) as V[];
}

const MATRIX_SQL: Record<MatrixVector["op"], string> = {
  like: "SELECT ? LIKE ?",
  ilike: "SELECT ilike(?, ?)",
  regex: "SELECT ? REGEXP ?",
  regex_i: "SELECT regexp_i(?, ?)",
};

function cell(sql: string, value: string, pattern: string): string {
  const result = outcome(() => scalar(db, sql, value, pattern));
  if ("error" in result) return `E:${result.error}`;
  if (result.value === 1) return "t";
  if (result.value === 0) return "f";
  return `?${String(result.value)}`;
}

describe("LIKE, ILIKE and regex matrices", () => {
  for (const op of ["like", "ilike", "regex", "regex_i"] as const) {
    it(`${op} matches PostgreSQL for every value and pattern`, () => {
      const [matrix] = ofOp<MatrixVector>(op);
      expect(matrix).toBeDefined();
      if (matrix === undefined) return;
      const mismatches: string[] = [];
      matrix.patterns.forEach((pattern, p) => {
        const row = matrix.rows[p] ?? "";
        matrix.values.forEach((value, v) => {
          const expected = row[v] === "E" ? `E:${matrix.errors[p] ?? "?"}` : (row[v] ?? "?");
          const actual = cell(MATRIX_SQL[op], value, pattern);
          if (actual !== expected) {
            mismatches.push(`${JSON.stringify(value)} ${op} ${JSON.stringify(pattern)}: pg ${expected}, got ${actual}`);
          }
        });
      });
      expect(mismatches).toEqual([]);
      expect(matrix.values.length * matrix.patterns.length).toBeGreaterThan(1000);
    });
  }

  it("treats the special characters of the bug report as literals", () => {
    expect(scalar(db, "SELECT 'sp-kept' LIKE 'sp-%'")).toBe(1);
    expect(scalar(db, "SELECT ilike('SP-Kept', 'sp-%')")).toBe(1);
    expect(scalar(db, "SELECT 'a#b@c:d,e' LIKE '%#%@%:%,%'")).toBe(1);
  });

  it("returns NULL for a NULL operand", () => {
    expect(scalar(db, "SELECT NULL LIKE 'a'")).toBeNull();
    expect(scalar(db, "SELECT ilike('a', NULL)")).toBeNull();
    expect(scalar(db, "SELECT NULL REGEXP 'a'")).toBeNull();
  });
});

describe("LIKE and ILIKE with ESCAPE", () => {
  const cases = [...ofOp<ScalarVector>("like_escape"), ...ofOp<ScalarVector>("ilike_escape")];
  it(`matches ${cases.length} PostgreSQL vectors`, () => {
    const mismatches: string[] = [];
    for (const v of cases) {
      const sql = v.op === "like_escape" ? "SELECT ? LIKE ? ESCAPE ?" : "SELECT ilike(?, ?, ?)";
      const result = outcome(() => scalar(db, sql, ...(v.args as SqlArg[])));
      const actual = "error" in result ? `E:${result.error}` : result.value === 1 ? "t" : "f";
      const expected = v.error !== undefined ? `E:${v.error}` : (v.pg ?? "?");
      if (actual !== expected) mismatches.push(`${v.op} ${JSON.stringify(v.args)}: pg ${expected}, got ${actual}`);
    }
    expect(mismatches).toEqual([]);
  });
});

describe("pg_trgm", () => {
  it("similarity() returns PostgreSQL's float4 for every pair", () => {
    const [sim] = ofOp<SimilarityVector>("similarity");
    expect(sim).toBeDefined();
    if (sim === undefined) return;
    const mismatches: string[] = [];
    sim.names.forEach((a, i) => {
      sim.names.slice(i).forEach((b, k) => {
        const expected = Number(sim.upperTriangle[i]?.[k]);
        for (const [x, y] of [[a, b], [b, a]] as const) {
          const actual = scalar(db, "SELECT similarity(?, ?)", x, y);
          if (actual !== expected) mismatches.push(`${JSON.stringify(x)} ~ ${JSON.stringify(y)}: pg ${expected}, got ${String(actual)}`);
        }
      });
    });
    expect(mismatches).toEqual([]);
  });

  it("show_trgm() lists PostgreSQL's trigrams in its order", () => {
    for (const v of ofOp<ScalarVector>("show_trgm")) {
      expect(showTrgm(v.args[0] ?? ""), JSON.stringify(v.args[0])).toEqual(v.pgList);
    }
  });

  it("`a % b` is similarity(a, b) >= 0.3", () => {
    for (const v of ofOp<ScalarVector>("trgm_match")) {
      const actual = scalar(db, "SELECT similarity(?, ?) >= 0.3", ...(v.args as SqlArg[]));
      expect(actual === 1 ? "true" : "false", JSON.stringify(v.args)).toBe(v.pg);
    }
  });
});

describe("jsonb containment", () => {
  const cases = ofOp<ScalarVector>("json_contains");
  it(`json_contains() matches ${cases.length} PostgreSQL @> vectors`, () => {
    const mismatches: string[] = [];
    for (const v of cases) {
      const result = outcome(() => scalar(db, "SELECT json_contains(?, ?)", ...(v.args as SqlArg[])));
      const actual = "error" in result ? `E:${result.error}` : result.value === 1 ? "true" : "false";
      const expected = v.error !== undefined ? `E:${v.error}` : (v.pg ?? "?");
      if (actual !== expected) mismatches.push(`${JSON.stringify(v.args)}: pg ${expected}, got ${actual}`);
    }
    expect(mismatches).toEqual([]);
  });
});

describe("C-collation text functions", () => {
  for (const op of ["lower", "upper", "btrim"] as const) {
    it(`${op}() matches PostgreSQL`, () => {
      for (const v of ofOp<ScalarVector>(op)) {
        const params = v.args.map(() => "?").join(", ");
        expect(scalar(db, `SELECT ${op}(${params})`, ...(v.args as SqlArg[])), JSON.stringify(v.args)).toBe(v.pg);
      }
    });
  }

  for (const op of ["greatest", "least"] as const) {
    it(`${op}() orders text bytewise like PostgreSQL's C collation`, () => {
      for (const v of ofOp<ScalarVector>(op)) {
        const params = v.args.map(() => "?").join(", ");
        expect(scalar(db, `SELECT ${op}(${params})`, ...(v.args as SqlArg[])), JSON.stringify(v.args)).toBe(v.pg);
      }
    });
  }

  it("ORDER BY sorts text as PostgreSQL's C collation", () => {
    for (const v of ofOp<ScalarVector>("order")) {
      const rows = db.prepare("SELECT value FROM json_each(?) ORDER BY value").all(JSON.stringify(v.args));
      expect(rows.map((r) => r.value), JSON.stringify(v.args)).toEqual(v.pgList);
    }
  });

  it("greatest() and least() ignore NULLs and keep INTEGER values exact", () => {
    expect(scalar(db, "SELECT greatest(NULL, 2, NULL, 1)")).toBe(2);
    expect(scalar(db, "SELECT least(NULL, NULL)")).toBeNull();
    expect(scalar(db, "SELECT typeof(greatest(1, 2))")).toBe("integer");
    expect(scalar(db, "SELECT CAST(greatest(9007199254740993, 9007199254740992.0) AS TEXT)")).toBe("9007199254740993");
    expect(scalar(db, "SELECT least(2, 1.5)")).toBe(1.5);
    expect(scalar(db, "SELECT greatest(3, 2.5)")).toBe(3);
  });

  it("floor(), ceil() and sign() keep INTEGER arguments INTEGER", () => {
    expect(scalar(db, "SELECT typeof(floor(5))")).toBe("integer");
    expect(scalar(db, "SELECT typeof(ceil(-5))")).toBe("integer");
    expect(scalar(db, "SELECT sign(-7)")).toBe(-1);
    expect(scalar(db, "SELECT typeof(sign(-7))")).toBe("integer");
    expect(scalar(db, "SELECT floor(-1.5)")).toBe(-2);
    expect(scalar(db, "SELECT typeof(floor(-1.5))")).toBe("real");
  });
});
