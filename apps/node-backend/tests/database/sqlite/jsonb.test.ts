/**
 * Golden tests for canonical jsonb text: `vision_jsonb(x)` against
 * PostgreSQL 18.6 `x::jsonb::text` and `to_jsonb(x)::text`, and the
 * `vision_jsonb_ok` CHECK helper.
 */
import { describe, expect, it } from "vitest";

import { canonicalJsonbText, isCanonicalJsonbText } from "../../../src/database/sqlite/jsonb.ts";
import { loadFixture, openDb, outcome, scalar, sha256 } from "./harness.ts";

interface Vector {
  op: "cast" | "to_jsonb_float8" | "to_jsonb_int8";
  args: [string];
  pg?: string;
  pgLength?: number;
  pgSha256?: string;
  error?: string;
}

const vectors = loadFixture<Vector>("jsonb.golden.json");
const db = openDb();

function describeExpected(v: Vector): string {
  if (v.error !== undefined) return `E:${v.error}`;
  if (v.pg !== undefined) return v.pg;
  return `len ${v.pgLength ?? "?"} sha ${v.pgSha256 ?? "?"}`;
}

function describeActual(v: Vector, result: { value: unknown } | { error: string }): string {
  if ("error" in result) return `E:${result.error}`;
  if (typeof result.value !== "string") return `?${String(result.value)}`;
  if (v.pg !== undefined || v.error !== undefined) return result.value;
  return `len ${result.value.length} sha ${sha256(result.value)}`;
}

describe("vision_jsonb() against PostgreSQL", () => {
  const casts = vectors.filter((v) => v.op === "cast");

  it(`matches ${casts.length} \`x::jsonb::text\` vectors`, () => {
    const mismatches: string[] = [];
    for (const v of casts) {
      const expected = describeExpected(v);
      const viaSql = describeActual(v, outcome(() => scalar(db, "SELECT vision_jsonb(?)", v.args[0])));
      const direct = describeActual(v, outcome(() => canonicalJsonbText(v.args[0])));
      if (viaSql !== expected || direct !== expected) {
        mismatches.push(`${JSON.stringify(v.args[0])}: pg ${expected}, sql ${viaSql}, js ${direct}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("vision_jsonb_ok() accepts exactly PostgreSQL's output text", () => {
    const mismatches: string[] = [];
    for (const v of casts) {
      if (v.pg === undefined) {
        if (v.error !== undefined && scalar(db, "SELECT vision_jsonb_ok(?)", v.args[0]) !== 0) {
          mismatches.push(`invalid ${JSON.stringify(v.args[0])} accepted`);
        }
        continue;
      }
      if (scalar(db, "SELECT vision_jsonb_ok(?)", v.pg) !== 1) mismatches.push(`canonical ${JSON.stringify(v.pg)} refused`);
      const inputOk = scalar(db, "SELECT vision_jsonb_ok(?)", v.args[0]);
      if (inputOk !== (v.args[0] === v.pg ? 1 : 0)) mismatches.push(`input ${JSON.stringify(v.args[0])} gave ${String(inputOk)}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("matches to_jsonb() of double precision and bigint values", () => {
    for (const v of vectors.filter((x) => x.op !== "cast")) {
      const arg = v.op === "to_jsonb_int8" ? BigInt(v.args[0]) : Number(v.args[0]);
      const row = db.prepare("SELECT vision_jsonb(?) AS j").get(arg);
      expect(describeActual(v, { value: row?.j }), v.args[0]).toBe(describeExpected(v));
    }
  });

  it("canonicalJsonbText() throws 22P02 on invalid JSON", () => {
    for (const bad of ["", "{a:1}", "[1,]", "01", "NaN"]) {
      expect(outcome(() => canonicalJsonbText(bad))).toEqual({ error: "22P02" });
    }
    expect(isCanonicalJsonbText("not json")).toBe(false);
  });

  it("NULL stays NULL and the helper returns INTEGER", () => {
    expect(scalar(db, "SELECT vision_jsonb(NULL)")).toBeNull();
    expect(scalar(db, "SELECT vision_jsonb_ok(NULL)")).toBeNull();
    expect(scalar(db, "SELECT typeof(vision_jsonb_ok('{}'))")).toBe("integer");
    expect(scalar(db, "SELECT vision_jsonb_ok(1)")).toBe(0);
  });

  it("keeps the number text a JSON.parse round trip would lose", () => {
    expect(canonicalJsonbText('{"amount": 12345678901234567890.10}')).toBe('{"amount": 12345678901234567890.10}');
    expect(canonicalJsonbText("[0.10, 1e2, -0]")).toBe("[0.10, 100, 0]");
  });
});
