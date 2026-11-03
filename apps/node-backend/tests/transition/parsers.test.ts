/**
 * The transition's parsers: COPY text format, array literals, PostgreSQL
 * value output, exact decimals, the dump scanner, ledger and sequence
 * planning, and the canonical row ordering.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  decodeCopyField,
  decodeCopyLine,
  endsWithEscapedNewline,
  parseCopyHeader,
  splitCopyLine,
} from "../../scripts/transition/copyText.ts";
import { compareKeys, compareUtf8, canonicalValue } from "../../scripts/transition/canonical.ts";
import { forEachCopyRow, parseColumnDefinition, scanDump } from "../../scripts/transition/dump.ts";
import { formatPgTextArray, parsePgIntegerArray, parsePgTextArray } from "../../scripts/transition/pgArray.ts";
import {
  addFixed,
  compareFixed,
  convertPgTimestamptz,
  formatFixed,
  isCanonicalDecimalFor,
  parseFixed,
  parsePgInteger,
} from "../../scripts/transition/pgValues.ts";
import { EXPECTED_V2_LEDGER, checkLedger } from "../../scripts/transition/plan.ts";
import { validateEntryName } from "../../scripts/transition/zip.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

afterAll(removeTempDirs);

const bytes = (s: string): Uint8Array => Buffer.from(s, "utf8");
const field = (s: string): string | null => decodeCopyField(bytes(s));

describe("COPY text format", () => {
  it("decodes every escape PostgreSQL defines", () => {
    expect(field("\\N")).toBeNull();
    expect(field("\\\\N")).toBe("\\N");
    expect(field("NULL")).toBe("NULL");
    expect(field("")).toBe("");
    expect(field("a\\tb\\nc\\rd\\be\\ff\\vg\\\\h")).toBe("a\tb\nc\rd\be\ff\vg\\h");
    expect(field("\\101\\60\\7x")).toBe("A0\u0007x");
    expect(field("\\x41\\x4a\\x4")).toBe("AJ\u0004");
    expect(field("\\q")).toBe("q");
    expect(field("\\303\\251")).toBe("é"); // octal escapes of UTF-8 bytes
    expect(field("emoji 😀 ✓")).toBe("emoji 😀 ✓");
  });

  it("refuses invalid UTF-8, NUL and an end marker inside a row", () => {
    expect(() => field("\\377")).toThrow();
    expect(() => field("\\0")).toThrow();
    expect(() => field("a\\.")).toThrow();
  });

  it("splits on unescaped tabs only", () => {
    const parts = splitCopyLine(bytes("1\ta\\tb\t\\N\t\\\\\t")).map((p) => Buffer.from(p).toString());
    expect(parts).toEqual(["1", "a\\tb", "\\N", "\\\\", ""]);
    expect(decodeCopyLine(bytes("x\t\\N\ty\\\\"))).toEqual(["x", null, "y\\"]);
  });

  it("recognises a backslash-escaped newline at the end of a line", () => {
    expect(endsWithEscapedNewline(bytes("abc\\"))).toBe(true);
    expect(endsWithEscapedNewline(bytes("abc\\\\"))).toBe(false);
    expect(endsWithEscapedNewline(bytes("abc\\\\\\"))).toBe(true);
  });

  it("parses COPY headers with quoted names", () => {
    expect(parseCopyHeader('COPY public.transactions (id, "timestamp", "we""ird") FROM stdin;')).toEqual({
      schema: "public",
      table: "transactions",
      columns: ["id", "timestamp", 'we"ird'],
    });
    expect(parseCopyHeader("COPY public.t (id) TO stdout;")).toBeNull();
  });

  it("parses column definitions with type modifiers, defaults and generated columns", () => {
    expect(parseColumnDefinition("    amount numeric(18,4) NOT NULL,")).toMatchObject({ name: "amount", type: "numeric(18,4)", generated: false });
    expect(parseColumnDefinition("    created_at timestamp with time zone DEFAULT now() NOT NULL,")).toMatchObject({
      type: "timestamp with time zone",
    });
    expect(parseColumnDefinition("    type public.account_type DEFAULT 'checking'::public.account_type NOT NULL,")).toMatchObject({
      type: "public.account_type",
    });
    expect(
      parseColumnDefinition("    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, text)) STORED"),
    ).toMatchObject({ name: "search_vector", generated: true });
    expect(parseColumnDefinition("    tags text[] DEFAULT '{}'::text[] NOT NULL")).toMatchObject({ type: "text[]" });
  });
});

describe("array literals", () => {
  it("round-trips array_out quoting", () => {
    const elements = ["a", "b c", null, "NULL", "null", "", 'x"y', "back\\slash", "{}", "a,b", " lead", "é"];
    const literal = formatPgTextArray(elements);
    expect(literal).toBe('{a,"b c",NULL,"NULL","null","","x\\"y","back\\\\slash","{}","a,b"," lead",é}');
    expect(parsePgTextArray(literal)).toEqual(elements);
  });

  it("refuses literals that are not array_out output", () => {
    expect(() => parsePgTextArray("{a, b}")).toThrow();
    expect(() => parsePgTextArray('{"a"}')).toThrow(); // array_out would not quote a
    expect(() => parsePgTextArray("{{1,2},{3,4}}")).toThrow();
    expect(() => parsePgTextArray("[1:2]={a,b}")).toThrow();
    expect(() => parsePgTextArray("a,b")).toThrow();
    expect(parsePgIntegerArray("{1,2,NULL,-3}")).toEqual([1, 2, null, -3]);
    expect(() => parsePgIntegerArray("{1.5}")).toThrow();
  });
});

describe("values", () => {
  it("parses int64 output exactly", () => {
    expect(parsePgInteger("-9223372036854775808")).toBe(-9223372036854775808n);
    expect(() => parsePgInteger("-9223372036854775809")).toThrow();
  });

  it("does decimal arithmetic exactly", () => {
    let sum = parseFixed("0");
    for (const v of ["0.1", "0.2", "-0.3", "99999999999999.9999", "-99999999999999.9999", "0.0001"]) {
      sum = addFixed(sum, parseFixed(v));
    }
    expect(formatFixed(sum)).toBe("0.0001");
    expect(compareFixed(parseFixed("-1"), parseFixed("-1.5"))).toBe(1);
    expect(compareFixed(parseFixed("1.50"), parseFixed("1.5"))).toBe(0);
    expect(formatFixed(parseFixed("-0.0500"))).toBe("-0.0500");
    expect(() => parseFixed("NaN")).toThrow();
    expect(() => parseFixed("-0")).toThrow();
    expect(isCanonicalDecimalFor("12.50", 18, 2)).toBe(true);
    expect(isCanonicalDecimalFor("12.5", 18, 2)).toBe(false);
    expect(isCanonicalDecimalFor("1234567890123456.00", 18, 2)).toBe(true);
    expect(isCanonicalDecimalFor("12345678901234567.00", 18, 2)).toBe(false);
  });

  it("converts timestamps across DST, LMT offsets and 5-digit local years", () => {
    expect(convertPgTimestamptz("2026-10-25 02:30:00+02")).toBe("2026-10-25T00:30:00.000000Z");
    expect(convertPgTimestamptz("2026-10-25 02:30:00+01")).toBe("2026-10-25T01:30:00.000000Z");
    expect(convertPgTimestamptz("1880-01-01 00:00:00+00:17:30")).toBe("1879-12-31T23:42:30.000000Z");
    expect(convertPgTimestamptz("2024-06-01 12:00:00.000001-09:30")).toBe("2024-06-01T21:30:00.000001Z");
  });
});

describe("canonical order and values", () => {
  it("orders text like SQLite's BINARY collation (UTF-8 bytes)", () => {
    const values = ["b", "a", "\uffff", "😀", "é", "", "A", "ab"];
    const sorted = [...values].sort(compareUtf8);
    const byBytes = [...values].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
    expect(sorted).toEqual(byBytes);
    expect(compareKeys([1n, "b"], [1n, "a"])).toBe(1);
    expect(compareKeys([2n], [10n])).toBe(-1);
  });

  it("tags storage classes", () => {
    expect(canonicalValue(null)).toBeNull();
    expect(canonicalValue(9223372036854775807n)).toBe("i:9223372036854775807");
    expect(canonicalValue(0.1)).toBe("r:3fb999999999999a");
    expect(canonicalValue("1.0000")).toBe("t:1.0000");
  });
});

describe("ledger", () => {
  it("accepts exactly the 2.0.0 ledger", () => {
    expect(() => checkLedger(EXPECTED_V2_LEDGER)).not.toThrow();
    expect(() => checkLedger(EXPECTED_V2_LEDGER.slice(0, 4))).toThrow(/older database/);
    expect(() => checkLedger([...EXPECTED_V2_LEDGER, "0006_new"])).toThrow(/newer database/);
    expect(() => checkLedger([])).toThrow(/no kysely_migration rows/);
    expect(() => checkLedger([...EXPECTED_V2_LEDGER].reverse())).toThrow(/order differs/);
  });
});

describe("zip entry names", () => {
  it("refuses unsafe names and folds case and Unicode for duplicate detection", () => {
    for (const bad of ["/abs", "../x", "a/../b", "a\\b", "C:/x", "a//b", "a/./b", "x\u0000"]) {
      expect(() => validateEntryName(bad), bad).toThrow();
    }
    expect(validateEntryName("Attachments/É.pdf")).toBe(validateEntryName("attachments/e\u0301.PDF".normalize("NFC")));
  });
});

describe("dump scanner", () => {
  const dump = (body: string): string => {
    const file = path.join(tempDir(), "db.sql");
    fs.writeFileSync(
      file,
      [
        "--",
        "-- PostgreSQL database dump",
        "--",
        "",
        "\\restrict abc123",
        "",
        "-- Dumped from database version 18.6",
        "-- Dumped by pg_dump version 18.6",
        "",
        "SET client_encoding = 'UTF8';",
        "SET standard_conforming_strings = on;",
        body,
        "--",
        "-- PostgreSQL database dump complete",
        "--",
        "",
        "\\unrestrict abc123",
        "",
      ].join("\n"),
    );
    return file;
  };

  it("inventories tables, COPY blocks, setval and the ledger, and streams rows", async () => {
    const file = dump(
      [
        "CREATE TABLE public.t (",
        "    id integer NOT NULL,",
        "    note text",
        ");",
        "CREATE SEQUENCE public.t_id_seq",
        "    AS integer",
        "    START WITH 1",
        "    INCREMENT BY 1",
        "    NO MINVALUE",
        "    NO MAXVALUE",
        "    CACHE 1;",
        "ALTER SEQUENCE public.t_id_seq OWNED BY public.t.id;",
        "COPY public.t (id, note) FROM stdin;",
        "1\tline\\nbreak",
        "2\t\\N",
        "\\.",
        "COPY public.kysely_migration (name, \"timestamp\") FROM stdin;",
        ...EXPECTED_V2_LEDGER.map((n) => `${n}\t2026-01-01T00:00:00.000Z`),
        "\\.",
        "SELECT pg_catalog.setval('public.t_id_seq', 5, false);",
      ].join("\n"),
    );
    const inventory = await scanDump(file);
    expect(inventory.serverVersion).toBe("18.6");
    expect(inventory.tables.get("public.t")?.columns.map((c) => c.type)).toEqual(["integer", "text"]);
    expect(inventory.copies.map((c) => [c.table, c.rowCount])).toEqual([
      ["t", 2],
      ["kysely_migration", 5],
    ]);
    expect(inventory.ledger).toEqual(EXPECTED_V2_LEDGER);
    expect(inventory.setvals).toMatchObject([{ sequence: "t_id_seq", value: 5n, isCalled: false }]);
    expect(inventory.sequences.get("public.t_id_seq")?.ownedBy).toEqual({ schema: "public", table: "t", column: "id" });
    const rows: Array<Array<string | null>> = [];
    const block = inventory.copies[0];
    if (block === undefined) throw new Error("no COPY block");
    await forEachCopyRow(file, block, (row) => rows.push(row.fields));
    expect(rows).toEqual([
      ["1", "line\nbreak"],
      ["2", null],
    ]);
  });

  it("refuses INSERT data, unknown meta-commands, other servers and a missing trailer", async () => {
    await expect(scanDump(dump("INSERT INTO public.t VALUES (1);"))).rejects.toThrow(/outside COPY/);
    await expect(scanDump(dump("\\connect other"))).rejects.toThrow(/meta-command/);
    const file = dump("");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("version 18.6", "version 17.2"));
    await expect(scanDump(file)).rejects.toThrow(/PostgreSQL 17.2/);
    const cut = dump("");
    fs.writeFileSync(cut, fs.readFileSync(cut, "utf8").replace("-- PostgreSQL database dump complete", "-- x"));
    await expect(scanDump(cut)).rejects.toThrow(/truncated/);
  });
});
