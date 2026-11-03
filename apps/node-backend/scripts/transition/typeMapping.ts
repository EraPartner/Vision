/**
 * Per-column type mapping of the 2.0.0 -> SQLite transition (ADR-263).
 *
 * Conversion is driven by the declared type of the column in the freshly
 * migrated SQLite database (PRAGMA table_xinfo), through the one table below.
 * The PostgreSQL type from the dump's CREATE TABLE must be one the rule
 * accepts, so a schema mismatch (say numeric(18,4) feeding
 * DECIMAL_TEXT(18,2)) stops the run instead of converting silently.
 *
 * Decimal values never pass through a JavaScript number: they stay the text
 * PostgreSQL printed, and the text must already be canonical for the column.
 */
import { ArrayLiteralError, parsePgIntegerArray, parsePgTextArray } from "./pgArray.ts";
import {
  ValueError,
  convertPgDate,
  convertPgTimestamptz,
  convertPgUuid,
  isCanonicalDecimalFor,
  parsePgBoolean,
  parsePgFloat,
  parsePgInteger,
  stripBpcharPadding,
} from "./pgValues.ts";

/** What SQLite stores: INTEGER as BigInt (exact), REAL as number, TEXT. */
export type SqliteValue = null | bigint | number | string;

/** Checks that run through the SQL functions every Vision connection registers. */
export interface SqlValueChecks {
  /** `vision_numeric(x, p, s)`: the canonical NUMERIC(p,s) text of x. */
  visionNumeric(text: string, precision: number | null, scale: number | null): string | null;
  /** `vision_jsonb(x)`: the canonical jsonb text of x. */
  visionJsonb(text: string): string | null;
  /** SQLite's `json_valid(x)`. */
  jsonValid(text: string): boolean;
}

/** Things a conversion observed that the report should mention. */
export type ConversionNote = "bpchar-padding-removed" | "negative-zero-real";

export interface ColumnFacts {
  table: string;
  column: string;
  /** SQLite declared type, as PRAGMA table_xinfo reports it. */
  declaredType: string;
  /** PostgreSQL type from the dump's CREATE TABLE (format_type spelling). */
  pgType: string;
  /** Labels when the PostgreSQL type is an enum. */
  enumLabels: ReadonlySet<string> | undefined;
}

export interface ColumnConverter {
  readonly facts: ColumnFacts;
  readonly rule: TypeRule;
  /** DECIMAL_TEXT typmod (null for an unconstrained DECIMAL_TEXT). */
  readonly precision: number | null;
  readonly scale: number | null;
  /** Convert one non-NULL field of the dump. Throws ValueError. */
  convert(text: string, note: (kind: ConversionNote) => void): SqliteValue;
}

export interface TypeRule {
  /** SQLite declared type family. */
  sqlite: string;
  /** PostgreSQL source types the rule accepts, for the report and docs. */
  postgres: string;
  storage: "integer" | "real" | "text";
  /** What the conversion does. */
  conversion: string;
  matchesDeclared(declared: string): boolean;
  acceptsPg(pgType: string, facts: ColumnFacts, typmod: Typmod): boolean;
  build(facts: ColumnFacts, typmod: Typmod, checks: SqlValueChecks): ColumnConverter["convert"];
}

interface Typmod {
  precision: number | null;
  scale: number | null;
}

/** Normalise a declared type: upper case, no spaces. */
export function normaliseDeclared(declared: string): string {
  return declared.toUpperCase().replace(/\s+/g, "");
}

const PG_INTEGER = /^(smallint|integer|bigint)$/;
const PG_TEXTUAL = /^(text|character varying(\(\d+\))?|character\(\d+\))$/;

function decimalTypmod(declared: string): Typmod | null {
  const m = /^DECIMAL_TEXT(?:\((\d+),(\d+)\))?$/.exec(normaliseDeclared(declared));
  if (!m) return null;
  if (m[1] === undefined || m[2] === undefined) return { precision: null, scale: null };
  return { precision: Number(m[1]), scale: Number(m[2]) };
}

const PG_INT32 = /^(smallint|integer)$/;

const integerRule = (sqlite: "INTEGER" | "INT" | "BIGINT"): TypeRule => ({
  sqlite,
  postgres: sqlite === "BIGINT" ? "smallint, integer, bigint" : "smallint, integer",
  storage: "integer",
  conversion:
    sqlite === "BIGINT"
      ? "decimal integer text -> 64-bit integer, bound as BigInt (exact beyond 2^53); outside int64 refused"
      : "decimal integer text -> integer, bound as BigInt; the backend reads it as a JavaScript number, " +
        "so a PostgreSQL bigint may not feed it",
  matchesDeclared: (d) => normaliseDeclared(d) === sqlite,
  acceptsPg: (pg) => (sqlite === "BIGINT" ? PG_INTEGER : PG_INT32).test(pg),
  build: () => (text) => parsePgInteger(text),
});

/**
 * The mapping table. Exactly one rule matches each declared type; the run
 * fails on a column no rule matches.
 */
export const TYPE_MAPPING: readonly TypeRule[] = [
  integerRule("INTEGER"),
  integerRule("INT"),
  integerRule("BIGINT"),
  {
    sqlite: "DECIMAL_TEXT(p,s)",
    postgres: "numeric(p,s) with the same p and s; numeric for DECIMAL_TEXT",
    storage: "text",
    conversion:
      "PostgreSQL numeric text kept as is; it must already be canonical for the column " +
      "(vision_numeric(x,p,s) == x and exactly s decimals); NaN and Infinity refused",
    matchesDeclared: (d) => decimalTypmod(d) !== null,
    acceptsPg: (pg, _facts, typmod) =>
      typmod.precision === null ? pg === "numeric" : pg === `numeric(${typmod.precision},${typmod.scale})`,
    build: (_facts, typmod, checks) => (text) => {
      if (/^-?(NaN|Infinity)$/.test(text)) throw new ValueError(`${text} cannot be stored in a decimal column`);
      if (!isCanonicalDecimalFor(text, typmod.precision, typmod.scale)) {
        throw new ValueError(
          `not canonical NUMERIC${typmod.precision === null ? "" : `(${typmod.precision},${typmod.scale})`} text: ${text}`,
        );
      }
      let canonical: string | null;
      try {
        canonical = checks.visionNumeric(text, typmod.precision, typmod.scale);
      } catch (err) {
        throw new ValueError(`vision_numeric refused ${text}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (canonical !== text) {
        throw new ValueError(`vision_numeric(${text}) is ${String(canonical)}, not the same text`);
      }
      return text;
    },
  },
  {
    sqlite: "REAL",
    postgres: "real, double precision",
    storage: "real",
    conversion:
      "float text (pg_dump prints the shortest exact form) -> IEEE double; NaN and Infinity refused; -0 stored as 0",
    matchesDeclared: (d) => normaliseDeclared(d) === "REAL",
    acceptsPg: (pg) => pg === "real" || pg === "double precision",
    build: () => (text, note) => {
      const parsed = parsePgFloat(text);
      if (parsed.negativeZero) note("negative-zero-real");
      return parsed.value;
    },
  },
  {
    sqlite: "BOOLEAN",
    postgres: "boolean",
    storage: "integer",
    conversion: "t -> 1, f -> 0",
    matchesDeclared: (d) => normaliseDeclared(d) === "BOOLEAN",
    acceptsPg: (pg) => pg === "boolean",
    build: () => (text) => parsePgBoolean(text),
  },
  {
    sqlite: "TIMESTAMPTZ_TEXT",
    postgres: "timestamp with time zone",
    storage: "text",
    conversion:
      "`YYYY-MM-DD HH:MM:SS.ffffff±HH[:MM[:SS]]` in the dump's time zone -> UTC `YYYY-MM-DDTHH:MM:SS.ffffffZ`, " +
      "exact to the microsecond; ±infinity, BC and years outside 1-9999 refused",
    matchesDeclared: (d) => normaliseDeclared(d) === "TIMESTAMPTZ_TEXT",
    acceptsPg: (pg) => pg === "timestamp with time zone",
    build: () => (text) => convertPgTimestamptz(text),
  },
  {
    sqlite: "DATE_TEXT",
    postgres: "date",
    storage: "text",
    conversion: "ISO `YYYY-MM-DD` kept; ±infinity, BC and years outside 1-9999 refused",
    matchesDeclared: (d) => normaliseDeclared(d) === "DATE_TEXT",
    acceptsPg: (pg) => pg === "date",
    build: () => (text) => convertPgDate(text),
  },
  {
    sqlite: "JSONB_TEXT",
    postgres: "jsonb",
    storage: "text",
    conversion: "jsonb output text kept as is; it is PostgreSQL's canonical form, so vision_jsonb(x) == x must hold",
    matchesDeclared: (d) => normaliseDeclared(d) === "JSONB_TEXT",
    acceptsPg: (pg) => pg === "jsonb",
    build: (_facts, _typmod, checks) => (text) => {
      let canonical: string | null;
      try {
        canonical = checks.visionJsonb(text);
      } catch (err) {
        throw new ValueError(`vision_jsonb refused the value: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (canonical !== text) {
        throw new ValueError(
          `vision_jsonb() changes this jsonb text (${JSON.stringify(String(canonical).slice(0, 80))}); ` +
            "the stored form would differ from what PostgreSQL returned",
        );
      }
      return text;
    },
  },
  {
    sqlite: "JSON_TEXT",
    postgres: "json",
    storage: "text",
    conversion: "json text kept byte for byte (white space, key order, duplicate keys); json_valid must hold",
    matchesDeclared: (d) => normaliseDeclared(d) === "JSON_TEXT",
    acceptsPg: (pg) => pg === "json",
    build: (_facts, _typmod, checks) => (text) => {
      if (!checks.jsonValid(text)) throw new ValueError("json_valid() refuses this json text");
      return text;
    },
  },
  {
    sqlite: "TEXT_ARRAY",
    postgres: "text[], character varying[], smallint[], integer[], bigint[]",
    storage: "text",
    conversion:
      "array literal `{a,\"b c\",NULL}` -> JSON array text `[\"a\",\"b c\",null]` (JSON.stringify); " +
      "integer arrays -> JSON numbers; bounds, multiple dimensions and integers beyond 2^53 refused",
    matchesDeclared: (d) => normaliseDeclared(d) === "TEXT_ARRAY",
    acceptsPg: (pg) => /^(text|character varying(\(\d+\))?|smallint|integer|bigint)\[\]$/.test(pg),
    build: (facts) => {
      const integers = /^(smallint|integer|bigint)\[\]$/.test(facts.pgType);
      return (text) => {
        try {
          return JSON.stringify(integers ? parsePgIntegerArray(text) : parsePgTextArray(text));
        } catch (err) {
          if (err instanceof ArrayLiteralError) throw new ValueError(err.message);
          throw err;
        }
      };
    },
  },
  {
    sqlite: "UUID_TEXT",
    postgres: "uuid",
    storage: "text",
    conversion: "lower-case 8-4-4-4-12 text kept",
    matchesDeclared: (d) => normaliseDeclared(d) === "UUID_TEXT",
    acceptsPg: (pg) => pg === "uuid",
    build: () => (text) => convertPgUuid(text),
  },
  {
    sqlite: "TEXT",
    postgres: "text, character varying(n), character(n), enum types",
    storage: "text",
    conversion:
      "text kept as is; character(n) loses its space padding (the dialect stores char(n) unpadded); " +
      "an enum value must be one of the type's labels",
    matchesDeclared: (d) => normaliseDeclared(d) === "TEXT",
    acceptsPg: (pg, facts) => PG_TEXTUAL.test(pg) || facts.enumLabels !== undefined,
    build: (facts) => {
      if (facts.enumLabels !== undefined) {
        const labels = facts.enumLabels;
        return (text) => {
          if (!labels.has(text)) throw new ValueError(`${text} is not a label of enum ${facts.pgType}`);
          return text;
        };
      }
      if (facts.pgType.startsWith("character(")) {
        return (text, note) => {
          const stripped = stripBpcharPadding(text);
          if (stripped !== text) note("bpchar-padding-removed");
          return stripped;
        };
      }
      return (text) => text;
    },
  },
];

export class SchemaMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaMismatchError";
  }
}

/** Pick the rule for a column and check the PostgreSQL type feeds it. */
export function planColumnConversion(facts: ColumnFacts, checks: SqlValueChecks): ColumnConverter {
  const rules = TYPE_MAPPING.filter((rule) => rule.matchesDeclared(facts.declaredType));
  const rule = rules[0];
  if (rule === undefined || rules.length > 1) {
    throw new SchemaMismatchError(
      `${facts.table}.${facts.column}: no single transition rule for SQLite type ${JSON.stringify(facts.declaredType)}`,
    );
  }
  const typmod = decimalTypmod(facts.declaredType) ?? { precision: null, scale: null };
  if (!rule.acceptsPg(facts.pgType, facts, typmod)) {
    throw new SchemaMismatchError(
      `${facts.table}.${facts.column}: PostgreSQL ${facts.pgType} cannot feed SQLite ${facts.declaredType} ` +
        `(rule ${rule.sqlite} accepts ${rule.postgres})`,
    );
  }
  return {
    facts,
    rule,
    precision: typmod.precision,
    scale: typmod.scale,
    convert: rule.build(facts, typmod, checks),
  };
}
