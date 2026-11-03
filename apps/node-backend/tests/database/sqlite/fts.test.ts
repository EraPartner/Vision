/**
 * Golden tests for full-text search: the default parser's tokens (ts_debug),
 * to_tsvector('simple'), websearch_to_tsquery('simple'), `@@` and
 * ts_rank_cd against PostgreSQL 18.6 in the C locale.
 */
import { describe, expect, it } from "vitest";

import {
  TOKEN_TYPES,
  formatTsquery,
  formatTsvector,
  parseTokens,
  toTsvector,
  websearchToTsquery,
} from "../../../src/database/sqlite/fts.ts";
import { loadFixture, openDb, scalar } from "./harness.ts";

interface PassageVector {
  op: "passage";
  text: string;
  tokens: [string, string][];
  tsvector: string;
}

interface QueryVector {
  op: "query";
  text: string;
  tsquery?: string;
  error?: string;
}

/** A long passage stored compactly: prefix + repeat * times + suffix. */
interface PassageSpec {
  prefix: string;
  repeat: string;
  times: number;
  suffix: string;
}

interface MatrixVector {
  op: "matrix";
  passages: (string | PassageSpec)[];
  queries: string[];
  matches: string[];
  ranks: string[][];
}

function expand(passage: string | PassageSpec): string {
  return typeof passage === "string" ? passage : passage.prefix + passage.repeat.repeat(passage.times) + passage.suffix;
}

type Vector = PassageVector | QueryVector | MatrixVector;

const vectors = loadFixture<Vector>("fts.golden.json");
const passages = vectors.filter((v): v is PassageVector => v.op === "passage");
const queries = vectors.filter((v): v is QueryVector => v.op === "query");
const matrices = vectors.filter((v): v is MatrixVector => v.op === "matrix");
const db = openDb();

describe("default text search parser", () => {
  it(`splits ${passages.length} passages into ts_debug's tokens`, () => {
    const mismatches: string[] = [];
    for (const v of passages) {
      const actual = parseTokens(v.text).map((t) => [TOKEN_TYPES[t.type] ?? `#${t.type}`, t.text]);
      if (JSON.stringify(actual) !== JSON.stringify(v.tokens)) {
        mismatches.push(`${JSON.stringify(v.text)}\n  pg  ${JSON.stringify(v.tokens)}\n  got ${JSON.stringify(actual)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("builds to_tsvector('simple', ...) exactly", () => {
    const mismatches: string[] = [];
    for (const v of passages) {
      const actual = formatTsvector(toTsvector(v.text));
      if (actual !== v.tsvector) mismatches.push(`${JSON.stringify(v.text)}\n  pg  ${v.tsvector}\n  got ${actual}`);
    }
    expect(mismatches).toEqual([]);
  });
});

describe("websearch_to_tsquery('simple', ...)", () => {
  it(`parses ${queries.length} queries as PostgreSQL`, () => {
    const mismatches: string[] = [];
    for (const v of queries) {
      const actual = formatTsquery(websearchToTsquery(v.text));
      if (actual !== v.tsquery) mismatches.push(`${JSON.stringify(v.text)}: pg ${String(v.tsquery)}, got ${actual}`);
    }
    expect(mismatches).toEqual([]);
  });
});

describe("@@ and ts_rank_cd", () => {
  it("has the corpus matrix and the rank-focused matrix", () => {
    expect(matrices.map((m) => m.passages.length * m.queries.length)).toEqual([3763, 645]);
  });

  it("vision_fts_match() equals `@@` for every passage and query", () => {
    const mismatches: string[] = [];
    for (const matrix of matrices) matrix.passages.map(expand).forEach((passage, p) => {
      matrix.queries.forEach((query, q) => {
        const expected = matrix.matches[p]?.[q] === "t" ? 1 : 0;
        const actual = scalar(db, "SELECT vision_fts_match(?, ?)", passage, query);
        if (actual !== expected) mismatches.push(`${JSON.stringify(passage.slice(0, 80))} @@ ${JSON.stringify(query)}: pg ${expected}, got ${String(actual)}`);
      });
    });
    expect(mismatches).toEqual([]);
  });

  it("vision_fts_rank() equals ts_rank_cd's float4 for every passage and query", () => {
    const mismatches: string[] = [];
    for (const matrix of matrices) matrix.passages.map(expand).forEach((passage, p) => {
      matrix.queries.forEach((query, q) => {
        const expected = Number(matrix.ranks[p]?.[q]);
        const actual = scalar(db, "SELECT vision_fts_rank(?, ?)", passage, query);
        if (typeof actual !== "number" || Math.abs(actual - expected) > 1e-6 || actual !== expected) {
          mismatches.push(`${JSON.stringify(passage.slice(0, 80))} / ${JSON.stringify(query)}: pg ${expected}, got ${String(actual)}`);
        }
      });
    });
    expect(mismatches).toEqual([]);
  });

  it("returns NULL for NULL input, INTEGER for a match and REAL for a rank", () => {
    expect(scalar(db, "SELECT vision_fts_match(NULL, 'rent')")).toBeNull();
    expect(scalar(db, "SELECT vision_fts_rank('rent', NULL)")).toBeNull();
    expect(scalar(db, "SELECT typeof(vision_fts_match('rent', 'rent'))")).toBe("integer");
    expect(scalar(db, "SELECT typeof(vision_fts_rank('rent', 'rent'))")).toBe("real");
    expect(scalar(db, "SELECT vision_fts_match('rent', '')")).toBe(0);
  });
});
