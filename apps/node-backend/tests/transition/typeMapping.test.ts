/**
 * The transition's type-mapping table (scripts/transition/typeMapping.ts):
 * one rule per SQLite declared type, the PostgreSQL types each accepts, and
 * what each conversion does with ordinary and hostile values.
 */
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/database/connection.ts";
import { migrateConnection } from "../../src/database/migrate.ts";
import { readTargetSchema } from "../../scripts/transition/schema.ts";
import { storedMatchesDump } from "../../scripts/transition/inverse.ts";
import {
  SchemaMismatchError,
  TYPE_MAPPING,
  planColumnConversion,
} from "../../scripts/transition/typeMapping.ts";
import type { ColumnConverter, ConversionNote, SqlValueChecks, SqliteValue } from "../../scripts/transition/typeMapping.ts";

const db = openDatabase(":memory:", "writer");
migrateConnection(db, ":memory:", { skipBackup: true });
afterAll(() => {
  db.close();
});

/** The real SQL functions, as the transition uses them. */
const checks: SqlValueChecks = {
  visionNumeric: (text, p, s) => {
    const row = db.prepare("SELECT vision_numeric(?, ?, ?) AS v").get(text, p, s) as { v: string | null };
    return row.v;
  },
  visionJsonb: (text) => (db.prepare("SELECT vision_jsonb(?) AS v").get(text) as { v: string | null }).v,
  jsonValid: (text) => Number((db.prepare("SELECT json_valid(?) AS v").get(text) as { v: number | bigint }).v) === 1,
};

function converter(declaredType: string, pgType: string, enumLabels?: string[]): ColumnConverter {
  return planColumnConversion(
    { table: "t", column: "c", declaredType, pgType, enumLabels: enumLabels === undefined ? undefined : new Set(enumLabels) },
    checks,
  );
}

function convert(declaredType: string, pgType: string, text: string, enumLabels?: string[]): SqliteValue {
  const c = converter(declaredType, pgType, enumLabels);
  const value = c.convert(text, () => undefined);
  // Every accepted conversion must also pass the independent round-trip check.
  expect(storedMatchesDump(c, text, value), `${declaredType} ${text}`).toBe(true);
  return value;
}

function refuses(declaredType: string, pgType: string, text: string): void {
  expect(() => converter(declaredType, pgType).convert(text, () => undefined), `${declaredType} ${text}`).toThrow();
}

describe("the mapping table", () => {
  it("has exactly one rule for every declared type in the SQLite schema", () => {
    const schema = readTargetSchema(db);
    const declared = new Set<string>();
    for (const table of schema.tables.values()) for (const c of table.insertable) declared.add(c.declaredType);
    for (const type of declared) {
      expect(TYPE_MAPPING.filter((r) => r.matchesDeclared(type)), type).toHaveLength(1);
    }
    expect(declared.size).toBeGreaterThan(10);
  });

  it("documents each rule", () => {
    for (const rule of TYPE_MAPPING) {
      expect(rule.sqlite.length).toBeGreaterThan(0);
      expect(rule.postgres.length).toBeGreaterThan(0);
      expect(rule.conversion.length).toBeGreaterThan(10);
    }
  });

  it("refuses a PostgreSQL type that does not feed the SQLite type", () => {
    expect(() => converter("DECIMAL_TEXT(18,2)", "numeric(18,4)")).toThrow(SchemaMismatchError);
    expect(() => converter("DECIMAL_TEXT", "numeric(18,4)")).toThrow(SchemaMismatchError);
    expect(() => converter("INTEGER", "bigint")).toThrow(SchemaMismatchError);
    expect(() => converter("INT", "bigint")).toThrow(SchemaMismatchError);
    expect(() => converter("BOOLEAN", "integer")).toThrow(SchemaMismatchError);
    expect(() => converter("TIMESTAMPTZ_TEXT", "timestamp without time zone")).toThrow(SchemaMismatchError);
    expect(() => converter("TEXT", "public.unknown_type")).toThrow(SchemaMismatchError);
    expect(() => converter("BLOB", "bytea")).toThrow(SchemaMismatchError);
  });
});

describe("integers", () => {
  it("keeps every 64-bit value exact as BigInt", () => {
    expect(convert("BIGINT", "bigint", "9223372036854775807")).toBe(9223372036854775807n);
    expect(convert("BIGINT", "bigint", "-9223372036854775808")).toBe(-9223372036854775808n);
    expect(convert("BIGINT", "bigint", "9007199254740993")).toBe(9007199254740993n);
    expect(convert("INTEGER", "integer", "-2147483648")).toBe(-2147483648n);
    expect(convert("INT", "integer", "0")).toBe(0n);
    expect(convert("BIGINT", "smallint", "-32768")).toBe(-32768n);
  });

  it("refuses anything that is not int64 output", () => {
    refuses("BIGINT", "bigint", "9223372036854775808");
    refuses("BIGINT", "bigint", "1.0");
    refuses("BIGINT", "bigint", "+1");
    refuses("BIGINT", "bigint", "01");
    refuses("BIGINT", "bigint", "-0");
    refuses("BIGINT", "bigint", "");
    refuses("INTEGER", "integer", "1e3");
  });
});

describe("decimals", () => {
  it("keeps canonical text, never a JavaScript number", () => {
    expect(convert("DECIMAL_TEXT(18,4)", "numeric(18,4)", "-12345678901234.5678")).toBe("-12345678901234.5678");
    expect(convert("DECIMAL_TEXT(18,4)", "numeric(18,4)", "99999999999999.9999")).toBe("99999999999999.9999");
    expect(convert("DECIMAL_TEXT(18,4)", "numeric(18,4)", "0.0000")).toBe("0.0000");
    expect(convert("DECIMAL_TEXT(18,0)", "numeric(18,0)", "999999999999999999")).toBe("999999999999999999");
    expect(convert("DECIMAL_TEXT(20,10)", "numeric(20,10)", "1.0000000001")).toBe("1.0000000001");
    expect(convert("DECIMAL_TEXT", "numeric", "-123456789012345678901234567890.000000000000000000001")).toBe(
      "-123456789012345678901234567890.000000000000000000001",
    );
    expect(convert("DECIMAL_TEXT", "numeric", "1.50")).toBe("1.50");
    expect(convert("DECIMAL_TEXT", "numeric", "100")).toBe("100");
  });

  it("refuses NaN, infinities and text that is not canonical for the column", () => {
    refuses("DECIMAL_TEXT", "numeric", "NaN");
    refuses("DECIMAL_TEXT", "numeric", "Infinity");
    refuses("DECIMAL_TEXT", "numeric", "-Infinity");
    refuses("DECIMAL_TEXT(18,4)", "numeric(18,4)", "1.5");
    refuses("DECIMAL_TEXT(18,4)", "numeric(18,4)", "1.50000");
    refuses("DECIMAL_TEXT(18,4)", "numeric(18,4)", "100000000000000.0000");
    refuses("DECIMAL_TEXT(18,4)", "numeric(18,4)", "-0.0000");
    refuses("DECIMAL_TEXT(18,4)", "numeric(18,4)", "+1.0000");
    refuses("DECIMAL_TEXT(18,4)", "numeric(18,4)", "1e2");
    refuses("DECIMAL_TEXT(18,4)", "numeric(18,4)", ".5000");
    refuses("DECIMAL_TEXT", "numeric", "01.5");
  });
});

describe("floats", () => {
  it("keeps the IEEE double the text denotes", () => {
    expect(convert("REAL", "double precision", "0.1")).toBe(0.1);
    expect(convert("REAL", "double precision", "1.7976931348623157e+308")).toBe(Number.MAX_VALUE);
    expect(convert("REAL", "double precision", "5e-324")).toBe(5e-324);
    expect(convert("REAL", "real", "0.33333334")).toBe(0.33333334);
    expect(convert("REAL", "real", "3.4028235e+38")).toBe(3.4028235e38);
  });

  it("stores -0 as 0 and notes it; refuses NaN and infinities", () => {
    const notes: ConversionNote[] = [];
    const c = converter("REAL", "double precision");
    expect(c.convert("-0", (n) => notes.push(n))).toBe(0);
    expect(notes).toEqual(["negative-zero-real"]);
    refuses("REAL", "double precision", "NaN");
    refuses("REAL", "double precision", "Infinity");
    refuses("REAL", "double precision", "-Infinity");
    refuses("REAL", "double precision", "abc");
  });
});

describe("booleans, uuids, text, enums", () => {
  it("converts t/f and nothing else", () => {
    expect(convert("BOOLEAN", "boolean", "t")).toBe(1n);
    expect(convert("BOOLEAN", "boolean", "f")).toBe(0n);
    refuses("BOOLEAN", "boolean", "true");
    refuses("BOOLEAN", "boolean", "1");
  });

  it("keeps lower-case uuids and refuses others", () => {
    expect(convert("UUID_TEXT", "uuid", "3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBe("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    refuses("UUID_TEXT", "uuid", "3F2504E0-4F89-41D3-9A0C-0305E82C3301");
    refuses("UUID_TEXT", "uuid", "{3f2504e0-4f89-41d3-9a0c-0305e82c3301}");
  });

  it("keeps text byte for byte and strips only char(n) padding", () => {
    expect(convert("TEXT", "text", "  spaced  \t")).toBe("  spaced  \t");
    expect(convert("TEXT", "character varying(10)", "x ")).toBe("x ");
    const notes: ConversionNote[] = [];
    expect(converter("TEXT", "character(3)").convert("US ", (n) => notes.push(n))).toBe("US");
    expect(notes).toEqual(["bpchar-padding-removed"]);
    expect(convert("TEXT", "character(3)", "EUR")).toBe("EUR");
  });

  it("accepts only an enum's labels", () => {
    expect(convert("TEXT", "public.account_type", "checking", ["checking", "savings"])).toBe("checking");
    expect(() => converter("TEXT", "public.account_type", ["checking"]).convert("Checking", () => undefined)).toThrow();
  });
});

describe("timestamps and dates", () => {
  it("converts every offset form to exact UTC microseconds", () => {
    expect(convert("TIMESTAMPTZ_TEXT", "timestamp with time zone", "2026-03-29 01:59:59.999999+01")).toBe(
      "2026-03-29T00:59:59.999999Z",
    );
    expect(convert("TIMESTAMPTZ_TEXT", "timestamp with time zone", "2026-03-29 03:00:00+02")).toBe("2026-03-29T01:00:00.000000Z");
    expect(convert("TIMESTAMPTZ_TEXT", "timestamp with time zone", "1890-06-01 12:00:00+00:17:30")).toBe(
      "1890-06-01T11:42:30.000000Z",
    );
    expect(convert("TIMESTAMPTZ_TEXT", "timestamp with time zone", "2024-01-01 00:00:00.5-05:30")).toBe(
      "2024-01-01T05:30:00.500000Z",
    );
    expect(convert("TIMESTAMPTZ_TEXT", "timestamp with time zone", "0001-01-01 00:17:30+00:17:30")).toBe(
      "0001-01-01T00:00:00.000000Z",
    );
    expect(convert("TIMESTAMPTZ_TEXT", "timestamp with time zone", "9999-12-31 23:59:59.999999+00")).toBe(
      "9999-12-31T23:59:59.999999Z",
    );
    expect(convert("TIMESTAMPTZ_TEXT", "timestamp with time zone", "2000-02-29 23:00:00-02")).toBe("2000-03-01T01:00:00.000000Z");
  });

  it("refuses infinity, BC, out-of-range years and malformed text", () => {
    refuses("TIMESTAMPTZ_TEXT", "timestamp with time zone", "infinity");
    refuses("TIMESTAMPTZ_TEXT", "timestamp with time zone", "-infinity");
    refuses("TIMESTAMPTZ_TEXT", "timestamp with time zone", "0001-01-01 00:00:00+01 BC");
    refuses("TIMESTAMPTZ_TEXT", "timestamp with time zone", "0001-01-01 00:00:00+01");
    refuses("TIMESTAMPTZ_TEXT", "timestamp with time zone", "9999-12-31 23:00:00-02");
    refuses("TIMESTAMPTZ_TEXT", "timestamp with time zone", "10000-01-01 00:00:00+00");
    refuses("TIMESTAMPTZ_TEXT", "timestamp with time zone", "2023-02-29 00:00:00+00");
    refuses("TIMESTAMPTZ_TEXT", "timestamp with time zone", "2023-01-01T00:00:00Z");
    refuses("TIMESTAMPTZ_TEXT", "timestamp with time zone", "2023-01-01 24:00:00+00");
  });

  it("keeps dates and refuses BC, infinity and impossible days", () => {
    expect(convert("DATE_TEXT", "date", "2024-02-29")).toBe("2024-02-29");
    expect(convert("DATE_TEXT", "date", "0001-01-01")).toBe("0001-01-01");
    expect(convert("DATE_TEXT", "date", "9999-12-31")).toBe("9999-12-31");
    refuses("DATE_TEXT", "date", "infinity");
    refuses("DATE_TEXT", "date", "-infinity");
    refuses("DATE_TEXT", "date", "0001-01-01 BC");
    refuses("DATE_TEXT", "date", "2023-02-29");
    refuses("DATE_TEXT", "date", "10000-01-01");
  });
});

describe("json, jsonb, arrays", () => {
  it("keeps canonical jsonb and refuses text vision_jsonb would change", () => {
    expect(convert("JSONB_TEXT", "jsonb", '{"a": 1, "bb": [true, null, "x"]}')).toBe('{"a": 1, "bb": [true, null, "x"]}');
    expect(convert("JSONB_TEXT", "jsonb", "1.50")).toBe("1.50");
    refuses("JSONB_TEXT", "jsonb", '{"bb": 1, "a": 2}');
    refuses("JSONB_TEXT", "jsonb", '{"a":1}');
    refuses("JSONB_TEXT", "jsonb", "not json");
  });

  it("keeps json byte for byte, duplicate keys and white space included", () => {
    expect(convert("JSON_TEXT", "json", '{ "b":1, "a" : 2, "b": 3 }')).toBe('{ "b":1, "a" : 2, "b": 3 }');
    refuses("JSON_TEXT", "json", "{nope}");
  });

  it("turns array literals into JSON arrays", () => {
    expect(convert("TEXT_ARRAY", "text[]", "{}")).toBe("[]");
    expect(convert("TEXT_ARRAY", "text[]", '{a,"b c",NULL,"NULL","","x\\"y","back\\\\slash"}')).toBe(
      '["a","b c",null,"NULL","","x\\"y","back\\\\slash"]',
    );
    expect(convert("TEXT_ARRAY", "text[]", '{"{braces}","comma,here",é}')).toBe('["{braces}","comma,here","é"]');
    expect(convert("TEXT_ARRAY", "integer[]", "{1,-2,NULL}")).toBe("[1,-2,null]");
    refuses("TEXT_ARRAY", "text[]", "[0:1]={a,b}");
    refuses("TEXT_ARRAY", "text[]", "{{a},{b}}");
    refuses("TEXT_ARRAY", "text[]", "{ a}");
    refuses("TEXT_ARRAY", "bigint[]", "{9007199254740993}");
  });
});

describe("the round-trip check", () => {
  it("rejects stored values that differ from the dump in any way", () => {
    const ts = converter("TIMESTAMPTZ_TEXT", "timestamp with time zone");
    expect(storedMatchesDump(ts, "2026-03-29 03:00:00+02", "2026-03-29T01:00:00.000000Z")).toBe(true);
    expect(storedMatchesDump(ts, "2026-03-29 03:00:00+02", "2026-03-29T01:00:00.000001Z")).toBe(false);
    expect(storedMatchesDump(ts, "2026-03-29 03:00:00+02", "2026-03-29T03:00:00.000000Z")).toBe(false);
    const big = converter("BIGINT", "bigint");
    expect(storedMatchesDump(big, "9007199254740993", 9007199254740993n)).toBe(true);
    expect(storedMatchesDump(big, "9007199254740993", 9007199254740992n)).toBe(false);
    expect(storedMatchesDump(big, "1", 1)).toBe(false);
    const dec = converter("DECIMAL_TEXT(18,4)", "numeric(18,4)");
    expect(storedMatchesDump(dec, "1.0000", "1.0000")).toBe(true);
    expect(storedMatchesDump(dec, "1.0000", "1")).toBe(false);
    expect(storedMatchesDump(dec, "1.0000", 1)).toBe(false);
    const real = converter("REAL", "real");
    expect(storedMatchesDump(real, "0.33333334", 0.33333334)).toBe(true);
    expect(storedMatchesDump(real, "0.33333334", Math.fround(0.33333334))).toBe(false);
    const char = converter("TEXT", "character(3)");
    expect(storedMatchesDump(char, "US ", "US")).toBe(true);
    expect(storedMatchesDump(char, "US ", "U")).toBe(false);
    const arr = converter("TEXT_ARRAY", "text[]");
    expect(storedMatchesDump(arr, "{a,b}", '["a","b"]')).toBe(true);
    expect(storedMatchesDump(arr, "{a,b}", '["b","a"]')).toBe(false);
    expect(storedMatchesDump(arr, "{a,b}", null)).toBe(false);
    expect(storedMatchesDump(arr, null, null)).toBe(true);
  });
});
