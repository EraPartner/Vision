/**
 * Reader for the plain pg_dump inside a Vision 2.0.0 backup (`db.sql`).
 *
 * Two passes over the file, never more than one line in memory:
 *   1. `scanDump` checks the header and trailer, reads the DDL the
 *      transition needs (CREATE TABLE column types, enum labels, sequence
 *      options and owners), the `setval` calls, the Kysely migration ledger
 *      and the extent and row count of every COPY block. Other DDL is
 *      ignored: the SQLite schema comes from the backend's own migrations.
 *   2. `forEachCopyRow` streams the COPY rows again, decoded, to the loader.
 *
 * The dump is untrusted input: statements that would carry data the
 * transition does not read (INSERT, large objects, psql meta-commands other
 * than pg_dump's \restrict/\unrestrict) stop the run.
 */
import fs from "node:fs";
import { copyDecodeFailure, decodeCopyLine, endsWithEscapedNewline, parseCopyHeader } from "./copyText.ts";
import { TransitionError } from "./errors.ts";
import { at } from "./util.ts";

export interface DumpColumn {
  name: string;
  /** format_type() spelling, e.g. `numeric(18,4)`, `public.account_type`. */
  type: string;
  /** A generated column: PostgreSQL computes it and COPY leaves it out. */
  generated: boolean;
}

export interface DumpTable {
  schema: string;
  name: string;
  columns: DumpColumn[];
}

export interface CopyBlock {
  schema: string;
  table: string;
  columns: string[];
  /** 1-based line of the COPY statement. */
  headerLine: number;
  /** Byte offset of the first data line. */
  dataOffset: number;
  rowCount: number;
}

export interface SetvalCall {
  schema: string;
  sequence: string;
  value: bigint;
  isCalled: boolean;
  line: number;
}

export interface DumpSequence {
  schema: string;
  name: string;
  increment: bigint;
  ownedBy: { schema: string; table: string; column: string } | undefined;
}

export interface DumpInventory {
  serverVersion: string;
  pgDumpVersion: string | undefined;
  bytes: number;
  lines: number;
  tables: Map<string, DumpTable>;
  enums: Map<string, string[]>;
  sequences: Map<string, DumpSequence>;
  copies: CopyBlock[];
  setvals: SetvalCall[];
  /** `kysely_migration.name` values in dump order. */
  ledger: string[];
  materializedViews: string[];
}

export function qualified(schema: string, name: string): string {
  return `${schema}.${name}`;
}

const LF = 0x0a;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Call `onLine` for every line of `file` from byte `start`, synchronously in
 * file order. The line excludes its newline; `offset` is its first byte.
 * Returning `false` stops the scan; `true` continues.
 */
export async function forEachLine(
  file: string,
  start: number,
  onLine: (line: Buffer, offset: number) => boolean,
): Promise<void> {
  const stream = fs.createReadStream(file, { start, highWaterMark: 1 << 20 });
  let carry: Buffer | null = null;
  let carryOffset = start;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const buf: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
      let from = 0;
      for (;;) {
        const nl = buf.indexOf(LF, from);
        if (nl < 0) break;
        if (!onLine(buf.subarray(from, nl), carryOffset + from)) return;
        from = nl + 1;
      }
      carryOffset += from;
      carry = from < buf.length ? Buffer.from(buf.subarray(from)) : null;
    }
    if (carry !== null && carry.length > 0) onLine(carry, carryOffset);
  } finally {
    stream.destroy();
  }
}

function dumpError(message: string, line: number, hint?: string): TransitionError {
  return new TransitionError(message, {
    location: { line },
    hint:
      hint ??
      "This is not an intact Vision 2.0 backup. Make a fresh backup in Vision 2.0 (Settings > Backup) and run the transition on that file.",
  });
}

const IDENTIFIER_PART = /^("(?:[^"]|"")*"|[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*)/;

/** Parse an `a.b` or `a.b.c` name (each part quoted or not) into its parts. */
function parseDotted(text: string, parts: number): string[] | null {
  const names: string[] = [];
  let pos = 0;
  for (let i = 0; i < parts; i++) {
    const m = IDENTIFIER_PART.exec(text.slice(pos));
    if (!m) return null;
    const raw = at(m, 1);
    names.push(raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw.toLowerCase());
    pos += raw.length;
    if (i < parts - 1) {
      if (text[pos] !== ".") return null;
      pos++;
    }
  }
  return pos === text.length ? names : null;
}

/** Split a column definition into name, type and the rest. */
export function parseColumnDefinition(line: string): DumpColumn | null {
  const body = line.trim().replace(/,$/, "");
  const nameMatch = /^("(?:[^"]|"")*"|[a-z_][a-z0-9_$]*) /.exec(body);
  if (!nameMatch) return null;
  const rawName = at(nameMatch, 1);
  const name = rawName.startsWith('"') ? rawName.slice(1, -1).replaceAll('""', '"') : rawName;
  const rest = body.slice(nameMatch[0].length);
  // format_type() spellings are lower case and never contain these upper-case
  // clause keywords, so the type ends at the first of them outside brackets.
  let depth = 0;
  let quoted = false;
  let end = rest.length;
  for (let i = 0; i < rest.length; i++) {
    const c = at(rest, i);
    if (c === '"') quoted = !quoted;
    if (quoted) continue;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === " " && depth === 0) {
      const tail = rest.slice(i + 1);
      if (/^(DEFAULT|NOT NULL|NULL|GENERATED|COLLATE|CONSTRAINT|CHECK|REFERENCES|UNIQUE|PRIMARY)\b/.test(tail)) {
        end = i;
        break;
      }
    }
  }
  const type = rest.slice(0, end).replace(/"([^"]+)"/g, "$1");
  const clauses = rest.slice(end);
  const generated = /\bGENERATED ALWAYS AS \(/.test(clauses) && !/\bAS IDENTITY\b/.test(clauses);
  return { name, type, generated };
}

function parseStringLiteral(text: string): string | null {
  const m = /^'((?:[^']|'')*)'$/.exec(text);
  return m ? at(m, 1).replaceAll("''", "'") : null;
}

const SETVAL = /^SELECT pg_catalog\.setval\('((?:[^']|'')+)', (-?[0-9]+), (true|false)\);$/;
const OWNED_BY = /^ALTER SEQUENCE (.+) OWNED BY (.+);$/;

interface ScanState {
  lineNo: number;
  firstLines: string[];
  complete: boolean;
  completeLine: number;
  restrictKey: string | undefined;
  unrestricted: boolean;
  clientEncoding: string | undefined;
  standardStrings: string | undefined;
  copy: CopyBlock | null;
  copyIsLedger: boolean;
  pending: Buffer | null;
  table: DumpTable | null;
  enumDef: { key: string; labels: string[] } | null;
  sequence: DumpSequence | null;
}

function parseName(text: string, parts: number, line: string, lineNo: number, what: string): string[] {
  const name = parseDotted(text, parts);
  if (!name) throw dumpError(`Unreadable ${what}: ${line.slice(0, 120)}`, lineNo);
  return name;
}

/** One statement line outside COPY data. */
function scanStatementLine(inventory: DumpInventory, st: ScanState, line: string, offset: number, rawLength: number): void {
  const lineNo = st.lineNo;
  if (st.firstLines.length < 3) st.firstLines.push(line);
  if (st.complete && line !== "" && !line.startsWith("--") && !line.startsWith("\\unrestrict ")) {
    throw dumpError("db.sql continues after its 'dump complete' trailer", lineNo);
  }
  if (st.table !== null) {
    const table = st.table;
    if (line.startsWith(")")) {
      inventory.tables.set(qualified(table.schema, table.name), table);
      st.table = null;
      return;
    }
    if (line.startsWith("    CONSTRAINT ")) return;
    const column = parseColumnDefinition(line);
    if (!column) throw dumpError(`Unreadable column definition in CREATE TABLE ${table.schema}.${table.name}: ${line}`, lineNo);
    table.columns.push(column);
    return;
  }
  if (st.enumDef !== null) {
    if (line === ");") {
      inventory.enums.set(st.enumDef.key, st.enumDef.labels);
      st.enumDef = null;
      return;
    }
    const label = parseStringLiteral(line.trim().replace(/,$/, ""));
    if (label === null) throw dumpError(`Unreadable enum label: ${line}`, lineNo);
    st.enumDef.labels.push(label);
    return;
  }
  if (st.sequence !== null) {
    const option = line.trim().replace(/;$/, "");
    const inc = /^INCREMENT BY (-?[0-9]+)$/.exec(option);
    if (inc) st.sequence.increment = BigInt(at(inc, 1));
    if (line.endsWith(";")) {
      inventory.sequences.set(qualified(st.sequence.schema, st.sequence.name), st.sequence);
      st.sequence = null;
    }
    return;
  }

  if (line.startsWith("\\")) {
    const restrict = /^\\restrict ([A-Za-z0-9]+)$/.exec(line);
    const unrestrict = /^\\unrestrict ([A-Za-z0-9]+)$/.exec(line);
    if (restrict && st.restrictKey === undefined) st.restrictKey = restrict[1];
    else if (unrestrict && unrestrict[1] === st.restrictKey) st.unrestricted = true;
    else throw dumpError(`Unexpected psql meta-command in db.sql: ${line.slice(0, 60)}`, lineNo);
    return;
  }
  if (line.startsWith("--")) {
    const from = /^-- Dumped from database version (\S+)/.exec(line);
    if (from) inventory.serverVersion = at(from, 1);
    const by = /^-- Dumped by pg_dump version (\S+)/.exec(line);
    if (by) inventory.pgDumpVersion = at(by, 1);
    if (line === "-- PostgreSQL database dump complete") {
      st.complete = true;
      st.completeLine = lineNo;
    }
    return;
  }
  if (line.startsWith("SET client_encoding = ")) st.clientEncoding = line;
  if (line.startsWith("SET standard_conforming_strings = ")) st.standardStrings = line;

  const header = parseCopyHeader(line);
  if (header) {
    st.copy = { ...header, headerLine: lineNo, dataOffset: offset + rawLength + 1, rowCount: 0 };
    st.copyIsLedger = header.schema === "public" && header.table === "kysely_migration";
    if (st.copyIsLedger && header.columns[0] !== "name") {
      throw dumpError("kysely_migration COPY does not start with its name column", lineNo);
    }
    return;
  }
  if (line.startsWith("COPY ")) throw dumpError(`Unsupported COPY statement: ${line.slice(0, 80)}`, lineNo);
  if (/^INSERT INTO \S+\.\S+ (VALUES|\()/.test(line) || /^SELECT pg_catalog\.(lo_create|lo_open|lowrite)\(/.test(line)) {
    throw dumpError(
      "db.sql carries data outside COPY blocks (INSERT statements or large objects); a Vision 2.0 backup never does",
      lineNo,
    );
  }
  const createTable = /^CREATE (?:UNLOGGED )?TABLE (.+) \($/.exec(line);
  if (createTable) {
    const name = parseName(at(createTable, 1), 2, line, lineNo, "CREATE TABLE");
    st.table = { schema: at(name, 0), name: at(name, 1), columns: [] };
    return;
  }
  const createEnum = /^CREATE TYPE (.+) AS ENUM \($/.exec(line);
  if (createEnum) {
    const name = parseName(at(createEnum, 1), 2, line, lineNo, "CREATE TYPE");
    st.enumDef = { key: qualified(at(name, 0), at(name, 1)), labels: [] };
    return;
  }
  const createSequence = /^CREATE SEQUENCE (\S+)$/.exec(line);
  if (createSequence) {
    const name = parseName(at(createSequence, 1), 2, line, lineNo, "CREATE SEQUENCE");
    st.sequence = { schema: at(name, 0), name: at(name, 1), increment: 1n, ownedBy: undefined };
    return;
  }
  const owned = OWNED_BY.exec(line);
  if (owned) {
    const seq = parseName(at(owned, 1), 2, line, lineNo, "sequence ownership");
    const owner = parseName(at(owned, 2), 3, line, lineNo, "sequence ownership");
    const existing = inventory.sequences.get(qualified(at(seq, 0), at(seq, 1)));
    if (!existing) throw dumpError(`Ownership of an undeclared sequence: ${line}`, lineNo);
    existing.ownedBy = { schema: at(owner, 0), table: at(owner, 1), column: at(owner, 2) };
    return;
  }
  const setval = SETVAL.exec(line);
  if (setval) {
    const text = at(setval, 1).replaceAll("''", "'");
    const name = parseDotted(text, 2) ?? parseName(`public.${text}`, 2, line, lineNo, "setval");
    inventory.setvals.push({
      schema: at(name, 0),
      sequence: at(name, 1),
      value: BigInt(at(setval, 2)),
      isCalled: setval[3] === "true",
      line: lineNo,
    });
    return;
  }
  if (line.startsWith("SELECT pg_catalog.setval(")) throw dumpError(`Unreadable setval: ${line}`, lineNo);
  const mv = /^CREATE MATERIALIZED VIEW (\S+) AS$/.exec(line);
  if (mv) inventory.materializedViews.push(at(mv, 1));
}

/** One line inside a COPY block. */
function scanCopyLine(inventory: DumpInventory, st: ScanState, copy: CopyBlock, raw: Buffer): void {
  let row: Buffer = raw;
  if (st.pending !== null) {
    row = Buffer.concat([st.pending, Buffer.from([LF]), raw]);
    st.pending = null;
  }
  if (row.length === 2 && row[0] === 0x5c && row[1] === 0x2e) {
    inventory.copies.push(copy);
    st.copy = null;
    return;
  }
  if (endsWithEscapedNewline(row)) {
    st.pending = row;
    return;
  }
  copy.rowCount++;
  if (st.copyIsLedger) {
    try {
      inventory.ledger.push(decodeCopyLine(row)[0] ?? "");
    } catch (err) {
      copyDecodeFailure(err, "kysely_migration", st.lineNo);
    }
  }
}

/** Pass 1: inventory of the dump. */
export async function scanDump(file: string): Promise<DumpInventory> {
  const inventory: DumpInventory = {
    serverVersion: "",
    pgDumpVersion: undefined,
    bytes: fs.statSync(file).size,
    lines: 0,
    tables: new Map(),
    enums: new Map(),
    sequences: new Map(),
    copies: [],
    setvals: [],
    ledger: [],
    materializedViews: [],
  };
  const st: ScanState = {
    lineNo: 0,
    firstLines: [],
    complete: false,
    completeLine: 0,
    restrictKey: undefined,
    unrestricted: false,
    clientEncoding: undefined,
    standardStrings: undefined,
    copy: null,
    copyIsLedger: false,
    pending: null,
    table: null,
    enumDef: null,
    sequence: null,
  };
  await forEachLine(file, 0, (raw, offset) => {
    st.lineNo++;
    if (st.copy !== null) {
      scanCopyLine(inventory, st, st.copy, raw);
      return true;
    }
    let line: string;
    try {
      line = utf8.decode(raw);
    } catch {
      throw dumpError("db.sql is not valid UTF-8", st.lineNo);
    }
    scanStatementLine(inventory, st, line, offset, raw.length);
    return true;
  });
  inventory.lines = st.lineNo;
  if (st.copy !== null) throw dumpError("db.sql ends inside a COPY block (the dump is truncated)", st.lineNo);
  if (st.table !== null || st.enumDef !== null || st.sequence !== null) {
    throw dumpError("db.sql ends inside a statement (the dump is truncated)", st.lineNo);
  }
  if (st.firstLines.join("\n") !== "--\n-- PostgreSQL database dump\n--") {
    throw dumpError("db.sql does not start like a pg_dump plain-format dump", 1);
  }
  if (!st.complete) {
    throw dumpError("db.sql has no 'PostgreSQL database dump complete' trailer (the dump is truncated)", st.lineNo);
  }
  if (st.restrictKey !== undefined && !st.unrestricted) {
    throw dumpError("db.sql's \\restrict key is not closed by a matching \\unrestrict", st.completeLine);
  }
  if (!/^18(\.|$)/.test(inventory.serverVersion)) {
    throw dumpError(
      `db.sql was dumped from PostgreSQL ${inventory.serverVersion || "(unknown)"}; Vision 2.0 dumps come from PostgreSQL 18`,
      1,
    );
  }
  if (st.clientEncoding !== "SET client_encoding = 'UTF8';") {
    throw dumpError(`db.sql is not UTF-8 (${st.clientEncoding ?? "no client_encoding"})`, 1);
  }
  if (st.standardStrings !== "SET standard_conforming_strings = on;") {
    throw dumpError("db.sql was not written with standard_conforming_strings on", 1);
  }
  return inventory;
}

export interface CopyRow {
  fields: Array<string | null>;
  line: number;
}

/**
 * Pass 2: decode every row of the given COPY blocks, in file order. `onRow`
 * runs synchronously for each row.
 */
export async function forEachCopyRow(
  file: string,
  block: CopyBlock,
  onRow: (row: CopyRow) => void,
): Promise<number> {
  let lineNo = block.headerLine;
  let rows = 0;
  let pending: Buffer | null = null;
  let pendingLine = 0;
  const state = { ended: false };
  await forEachLine(file, block.dataOffset, (raw) => {
    lineNo++;
    let row: Buffer = raw;
    if (pending !== null) {
      row = Buffer.concat([pending, Buffer.from([LF]), raw]);
      pending = null;
    }
    if (row.length === 2 && row[0] === 0x5c && row[1] === 0x2e) {
      state.ended = true;
      return false;
    }
    if (endsWithEscapedNewline(row)) {
      pending = row;
      if (pendingLine === 0) pendingLine = lineNo;
      return true;
    }
    const line = pendingLine !== 0 ? pendingLine : lineNo;
    pendingLine = 0;
    let fields: Array<string | null>;
    try {
      fields = decodeCopyLine(row);
    } catch (err) {
      copyDecodeFailure(err, block.table, line);
    }
    if (fields.length !== block.columns.length) {
      throw new TransitionError(
        `COPY row has ${fields.length} fields, the table lists ${block.columns.length} columns`,
        { location: { table: block.table, line }, hint: "The backup's database dump is damaged. Make a new backup in Vision 2.0." },
      );
    }
    rows++;
    onRow({ fields, line });
    return true;
  });
  if (!state.ended) {
    throw new TransitionError("COPY block has no end marker", { location: { table: block.table, line: lineNo } });
  }
  if (rows !== block.rowCount) {
    throw new TransitionError(`db.sql changed while it was read (${rows} rows now, ${block.rowCount} before)`, {
      location: { table: block.table },
    });
  }
  return rows;
}
