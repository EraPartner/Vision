/**
 * Verification of the converted database. Nothing is installed unless every
 * check passes. The checks read the database through a fresh read-only
 * connection and the dump a second time from disk:
 *
 *   row counts          per table, dump == SQLite
 *   round trip          every value of every row, looked up by primary key,
 *                       means what the dump's text says (inverse.ts)
 *   checksums           SHA-256 of the converted rows == SHA-256 of the rows
 *                       read back from SQLite, in primary-key order
 *   decimal totals      per DECIMAL_TEXT column: count, exact sum, min, max,
 *                       BigInt arithmetic on the dump's text vs dec_sum() and
 *                       dec_key() ordering in SQLite
 *   readable            every value goes through the backend's reader for
 *                       its declared type without an error
 *   integrity_check, foreign_key_check, schema fingerprint == a fresh
 *   install, migration ledger complete, sequences, former materialized views
 *   empty, and the desktop app's own restore verifier (scripts/db-file.ts).
 */
import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { openDatabase } from "../../src/database/connection.ts";
import { loadMigrations, planMigrations, readLedger, schemaFingerprint } from "../../src/database/migrate.ts";
import { readerForDeclaredType } from "../../src/database/sqlite/values.ts";
import { verifyDatabaseFile } from "../db-file.ts";
import { DigestCollector, canonicalValue, compareUtf8, describeKey, rowDigest } from "./canonical.ts";
import type { CanonicalValue } from "./canonical.ts";
import { forEachCopyRow } from "./dump.ts";
import { displayValue } from "./errors.ts";
import { storedMatchesDump } from "./inverse.ts";
import type { LoadResult } from "./load.ts";
import type { TablePlan, TransitionPlan } from "./plan.ts";
import { addFixed, compareFixed, formatFixed, parseFixed } from "./pgValues.ts";
import type { FixedDecimal } from "./pgValues.ts";
import { SEQUENCES_TABLE, freshSchemaFingerprint, quoteIdent } from "./schema.ts";
import type { SqliteValue } from "./typeMapping.ts";
import { normaliseDeclared } from "./typeMapping.ts";
import { errorText } from "./util.ts";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Failure {
  check: string;
  message: string;
  table?: string;
  column?: string;
  rowKey?: string;
  dumpValue?: string;
  storedValue?: string;
  hint?: string;
}

export interface DecimalTotal {
  table: string;
  column: string;
  declaredType: string;
  dump: { count: number; sum: string | null; min: string | null; max: string | null };
  sqlite: { count: number; sum: string | null; min: string | null; max: string | null };
  ok: boolean;
}

export interface TableVerification {
  table: string;
  rows: { dump: number; sqlite: number };
  checksum: { dump: string; sqlite: string };
  roundTripValues: number;
  ok: boolean;
}

export interface VerificationResult {
  ok: boolean;
  checks: CheckResult[];
  failures: Failure[];
  tables: TableVerification[];
  decimalTotals: DecimalTotal[];
  sequences: Array<{ sequence: string; target: string; expected: string; actual: string | null; ok: boolean }>;
  schemaFingerprint: { database: string; freshInstall: string };
  schemaVersion: number;
  sqliteVersion: string;
}

const MAX_FAILURES_PER_TABLE = 20;
const MAX_FAILURES = 200;

type Row = Record<string, unknown>;

/** A value as SQLite returned it, or undefined for anything Vision never stores (BLOBs). */
function storedValue(value: unknown): SqliteValue | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") return value;
  return undefined;
}

function show(value: SqliteValue): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return displayValue(value);
  if (typeof value === "number") return `${String(value)} (REAL)`;
  return `${value.toString()} (INTEGER)`;
}

function prepareBig(db: DatabaseSync, sql: string): StatementSync {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return statement;
}

interface DecimalAccumulator {
  index: number;
  count: number;
  sum: FixedDecimal;
  min: FixedDecimal | null;
  max: FixedDecimal | null;
  minText: string | null;
  maxText: string | null;
}

class Collector {
  readonly failures: Failure[] = [];
  private perTable = new Map<string, number>();
  add(failure: Failure): boolean {
    const key = failure.table ?? "";
    const n = (this.perTable.get(key) ?? 0) + 1;
    this.perTable.set(key, n);
    if (n <= MAX_FAILURES_PER_TABLE && this.failures.length < MAX_FAILURES) this.failures.push(failure);
    return n < MAX_FAILURES_PER_TABLE;
  }
  count(table: string): number {
    return this.perTable.get(table) ?? 0;
  }
}

/** Read the table back in key order and compute its checksum; check every value is readable. */
function readBackChecksum(db: DatabaseSync, plan: TablePlan, collector: Collector): { rows: number; checksum: string } {
  const ordered = plan.checksumOrder.map((i) => plan.columns[i]?.name ?? "");
  const order =
    plan.primaryKey.length > 0 ? plan.primaryKey.map((i) => quoteIdent(plan.columns[i]?.name ?? "")).join(", ") : "rowid";
  const select = prepareBig(
    db,
    `SELECT ${ordered.map(quoteIdent).join(", ")} FROM ${quoteIdent(plan.name)} ORDER BY ${order}`,
  );
  const readers = ordered.map((name) => {
    const column = plan.target.columns.find((c) => c.name === name);
    return { name, declared: column?.declaredType ?? "", reader: readerForDeclaredType(column?.declaredType) };
  });
  // Keyed tables arrive in key order and hash as they stream; unkeyed ones are sorted first.
  const digests = new DigestCollector(plan.copy.rowCount, 0);
  const streamed = createHash("sha256");
  const keyed = plan.primaryKey.length > 0;
  const canonical: CanonicalValue[] = new Array<CanonicalValue>(ordered.length).fill(null);
  let rows = 0;
  let readFailures = 0;
  for (const raw of select.iterate()) {
    const row = raw as Row;
    for (let i = 0; i < readers.length; i++) {
      const r = readers[i];
      if (r === undefined) continue;
      const value = storedValue(row[r.name]);
      canonical[i] = value === undefined ? "blob" : canonicalValue(value);
      if (readFailures < MAX_FAILURES_PER_TABLE) {
        const declared = normaliseDeclared(r.declared);
        let problem: string | null = null;
        if (value === undefined) problem = "a BLOB, which no Vision column holds";
        else if ((declared === "INTEGER" || declared === "INT") && typeof value === "bigint" && !Number.isSafeInteger(Number(value))) {
          problem = "beyond 2^53, so Vision would read it inexactly as a JavaScript number";
        } else if (r.reader !== null) {
          try {
            r.reader(value);
          } catch (err) {
            problem = `unreadable for Vision (${errorText(err)})`;
          }
        }
        if (problem !== null) {
          readFailures++;
          collector.add({
            check: "readable",
            message: `${plan.name}.${r.name} holds a value that is ${problem}`,
            table: plan.name,
            column: r.name,
            storedValue: value === undefined ? "BLOB" : show(value),
          });
        }
      }
    }
    const digest = rowDigest(canonical);
    if (keyed) streamed.update(digest);
    else digests.add([], digest);
    rows++;
  }
  return { rows, checksum: keyed ? streamed.digest("hex") : digests.checksum() };
}

/** Second pass over the dump: every value against SQLite, plus decimal totals from the dump's text. */
async function roundTrip(
  db: DatabaseSync,
  dumpPath: string,
  plan: TablePlan,
  collector: Collector,
): Promise<{ values: number; decimals: DecimalAccumulator[] }> {
  const decimals: DecimalAccumulator[] = [];
  plan.columns.forEach((c, index) => {
    if (c.converter.rule.sqlite === "DECIMAL_TEXT(p,s)") {
      decimals.push({ index, count: 0, sum: { coef: 0n, scale: 0 }, min: null, max: null, minText: null, maxText: null });
    }
  });
  const columnList = plan.columns.map((c) => quoteIdent(c.name)).join(", ");
  const keyed = plan.primaryKey.length > 0;
  const lookup = keyed
    ? prepareBig(
        db,
        `SELECT ${columnList} FROM ${quoteIdent(plan.name)} WHERE ${plan.primaryKey
          .map((i) => `${quoteIdent(plan.columns[i]?.name ?? "")} = ?`)
          .join(" AND ")}`,
      )
    : null;
  const sequential = keyed ? null : prepareBig(db, `SELECT ${columnList} FROM ${quoteIdent(plan.name)} ORDER BY rowid`).iterate();
  const keyNames = plan.primaryKey.map((i) => plan.columns[i]?.name ?? "");
  let values = 0;
  const state = { stopped: false };
  /** Record a failure; true once this table has reported enough of them. */
  const fail = (failure: Failure): boolean => {
    if (!collector.add(failure)) state.stopped = true;
    return state.stopped;
  };
  await forEachCopyRow(dumpPath, plan.copy, ({ fields }) => {
    for (const d of decimals) {
      const raw = fields[plan.columns[d.index]?.copyIndex ?? -1] ?? null;
      if (raw === null) continue;
      try {
        const value = parseFixed(raw);
        d.count++;
        d.sum = addFixed(d.sum, value);
        if (d.min === null || compareFixed(value, d.min) < 0) {
          d.min = value;
          d.minText = raw;
        }
        if (d.max === null || compareFixed(value, d.max) > 0) {
          d.max = value;
          d.maxText = raw;
        }
      } catch {
        // The load refused such a value already; nothing to total.
      }
    }
    if (state.stopped) return;
    let row: Row | undefined;
    let key: SqliteValue[] = [];
    if (lookup !== null) {
      try {
        key = plan.primaryKey.map((i) => {
          const column = plan.columns[i];
          const raw = column === undefined ? null : (fields[column.copyIndex] ?? null);
          return raw === null || column === undefined ? null : column.converter.convert(raw, () => undefined);
        });
      } catch (err) {
        fail({ check: "round trip", message: `cannot read the key of a ${plan.name} row: ${errorText(err)}`, table: plan.name });
        return;
      }
      row = lookup.get(...key);
    } else if (sequential !== null) {
      const next = sequential.next();
      row = next.done === true ? undefined : next.value;
    }
    if (row === undefined) {
      fail({
        check: "round trip",
        message: `a ${plan.name} row of the dump is missing from SQLite`,
        table: plan.name,
        rowKey: describeKey(keyNames, key),
      });
      return;
    }
    for (const column of plan.columns) {
      const raw = fields[column.copyIndex] ?? null;
      const stored = storedValue(row[column.name]);
      values++;
      if (stored === undefined || !storedMatchesDump(column.converter, raw, stored)) {
        const enough = fail({
          check: "round trip",
          message: `${plan.name}.${column.name} does not hold the dump's value`,
          table: plan.name,
          column: column.name,
          rowKey: describeKey(keyNames, key),
          dumpValue: displayValue(raw),
          storedValue: stored === undefined ? "BLOB" : show(stored),
          hint: "The conversion changed this value. Nothing was installed. Report this message.",
        });
        if (enough) return;
      }
    }
  });
  return { values, decimals };
}

function decimalTotals(db: DatabaseSync, plan: TablePlan, decimals: DecimalAccumulator[]): DecimalTotal[] {
  return decimals.map((d) => {
    const column = plan.columns[d.index];
    const name = column?.name ?? "";
    const q = quoteIdent(name);
    const t = quoteIdent(plan.name);
    const agg = prepareBig(db, `SELECT count(${q}) AS n, dec_sum(${q}) AS s FROM ${t}`).get() as {
      n: bigint;
      s: string | null;
    };
    const pick = (direction: "ASC" | "DESC"): string | null => {
      const row = prepareBig(
        db,
        `SELECT ${q} AS v FROM ${t} WHERE ${q} IS NOT NULL ORDER BY dec_key(${q}) ${direction} LIMIT 1`,
      ).get() as { v: string } | undefined;
      return row?.v ?? null;
    };
    const dumpSum = d.count === 0 ? null : formatFixed(d.sum);
    const sqlite = { count: Number(agg.n), sum: agg.s, min: pick("ASC"), max: pick("DESC") };
    const dump = { count: d.count, sum: dumpSum, min: d.minText, max: d.maxText };
    const sameSum =
      dump.sum === null || sqlite.sum === null
        ? dump.sum === sqlite.sum
        : dump.sum === sqlite.sum && compareFixed(parseFixed(dump.sum), parseFixed(sqlite.sum)) === 0;
    const ok = dump.count === sqlite.count && sameSum && dump.min === sqlite.min && dump.max === sqlite.max;
    return { table: plan.name, column: name, declaredType: column?.converter.facts.declaredType ?? "", dump, sqlite, ok };
  });
}

export interface VerifyOptions {
  databasePath: string;
  dumpPath: string;
  plan: TransitionPlan;
  load: LoadResult;
  progress?: (message: string) => void;
}

/** Run every check against the closed, converted database file. */
export async function verifyDatabase(options: VerifyOptions): Promise<VerificationResult> {
  const { plan, load } = options;
  const progress = options.progress ?? (() => undefined);
  const collector = new Collector();
  const checks: CheckResult[] = [];
  const tables: TableVerification[] = [];
  const totals: DecimalTotal[] = [];
  const db = openDatabase(options.databasePath, "inspect");
  try {
    let countsOk = true;
    let checksumsOk = true;
    let roundTripOk = true;
    let values = 0;
    for (const table of plan.tables) {
      progress(`  verifying ${table.name}`);
      const loaded = load.tables.get(table.name);
      const count = Number(
        (prepareBig(db, `SELECT count(*) AS n FROM ${quoteIdent(table.name)}`).get() as { n: bigint }).n,
      );
      const before = collector.count(table.name);
      const back = readBackChecksum(db, table, collector);
      const trip = await roundTrip(db, options.dumpPath, table, collector);
      values += trip.values;
      totals.push(...decimalTotals(db, table, trip.decimals));
      const dumpRows = table.copy.rowCount;
      const rowsOk = count === dumpRows && back.rows === dumpRows && loaded?.rows === dumpRows;
      const checksumOk = loaded !== undefined && back.checksum === loaded.checksum;
      if (!rowsOk) {
        countsOk = false;
        collector.add({
          check: "row counts",
          message: `${table.name}: ${dumpRows} rows in the dump, ${count} in SQLite`,
          table: table.name,
        });
      }
      if (!checksumOk) {
        checksumsOk = false;
        collector.add({
          check: "checksums",
          message: `${table.name}: checksum of the converted rows ${loaded?.checksum ?? "?"} differs from the rows read back ${back.checksum}`,
          table: table.name,
        });
      }
      const tripOk = collector.count(table.name) === before;
      if (!tripOk) roundTripOk = false;
      tables.push({
        table: table.name,
        rows: { dump: dumpRows, sqlite: count },
        checksum: { dump: loaded?.checksum ?? "", sqlite: back.checksum },
        roundTripValues: trip.values,
        ok: rowsOk && checksumOk && tripOk,
      });
    }
    const totalRows = plan.tables.reduce((n, t) => n + t.copy.rowCount, 0);
    checks.push({ name: "row counts", ok: countsOk, detail: `${plan.tables.length} tables, ${totalRows} rows` });
    checks.push({
      name: "round trip",
      ok: roundTripOk && !collector.failures.some((f) => f.check === "round trip" || f.check === "readable"),
      detail: `${values} values compared with the dump's text; every value readable by the backend`,
    });
    checks.push({ name: "table checksums", ok: checksumsOk, detail: "SHA-256 per table, converted rows vs read back" });
    const badTotals = totals.filter((t) => !t.ok);
    for (const t of badTotals) {
      collector.add({
        check: "decimal totals",
        message:
          `${t.table}.${t.column}: dump count/sum/min/max ${t.dump.count}/${String(t.dump.sum)}/${String(t.dump.min)}/${String(t.dump.max)} ` +
          `but SQLite ${t.sqlite.count}/${String(t.sqlite.sum)}/${String(t.sqlite.min)}/${String(t.sqlite.max)}`,
        table: t.table,
        column: t.column,
      });
    }
    checks.push({
      name: "decimal totals",
      ok: badTotals.length === 0,
      detail: `${totals.length} DECIMAL_TEXT columns: exact count, sum, min and max`,
    });

    const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    const integrityOk = integrity.length === 1 && integrity[0]?.integrity_check === "ok";
    checks.push({
      name: "integrity_check",
      ok: integrityOk,
      detail: integrityOk ? "ok" : integrity.slice(0, 5).map((r) => r.integrity_check).join("; "),
    });
    const fk = db.prepare("PRAGMA foreign_key_check").all();
    checks.push({ name: "foreign_key_check", ok: fk.length === 0, detail: `${fk.length} violations` });

    const fresh = freshSchemaFingerprint();
    const fingerprint = schemaFingerprint(db);
    checks.push({
      name: "schema fingerprint",
      ok: fingerprint === fresh.fingerprint,
      detail: `database ${fingerprint}, fresh install ${fresh.fingerprint}`,
    });
    const ledger = readLedger(db);
    const migrations = loadMigrations();
    const pending = planMigrations(db, migrations);
    const ledgerOk =
      pending.length === 0 &&
      ledger.length === migrations.length &&
      ledger.every((m, i) => m.name === migrations[i]?.name && m.sha256 === migrations[i].sha256);
    checks.push({
      name: "migration ledger",
      ok: ledgerOk,
      detail: `${ledger.map((m) => m.name).join(", ")}${pending.length > 0 ? ` (pending: ${pending.map((m) => m.name).join(", ")})` : ""}`,
    });

    const sequences = plan.sequences.map((s) => {
      let actual: string | null;
      if (s.target.kind === "vision_sequences") {
        const row = prepareBig(db, `SELECT last_value AS v FROM ${SEQUENCES_TABLE} WHERE name = ?`).get(s.target.name) as
          | { v: bigint }
          | undefined;
        actual = row === undefined ? null : row.v.toString();
      } else {
        const row = prepareBig(db, "SELECT seq AS v FROM sqlite_sequence WHERE name = ?").get(s.target.table) as
          | { v: bigint }
          | undefined;
        actual = row === undefined ? "0" : row.v.toString();
      }
      const expected = s.lastValue.toString();
      const target = s.target.kind === "vision_sequences" ? `vision_sequences.${s.target.name}` : `sqlite_sequence.${s.target.table}`;
      return { sequence: s.sequence, target, expected, actual, ok: actual === expected };
    });
    const badSequences = sequences.filter((s) => !s.ok);
    for (const s of badSequences) {
      collector.add({ check: "sequences", message: `${s.sequence}: expected ${s.target} = ${s.expected}, found ${String(s.actual)}` });
    }
    checks.push({
      name: "sequences",
      ok: badSequences.length === 0,
      detail: `${sequences.length} sequences carried over (${sequences.filter((s) => s.target.startsWith("vision_")).length} vision_sequences, ${sequences.filter((s) => s.target.startsWith("sqlite_")).length} AUTOINCREMENT)`,
    });

    const emptied = plan.targetOnlyTables.filter((t) => t.name.startsWith("mv_"));
    const notEmpty = emptied.filter(
      (t) => Number((prepareBig(db, `SELECT count(*) AS n FROM ${quoteIdent(t.name)}`).get() as { n: bigint }).n) !== 0,
    );
    checks.push({
      name: "former materialized views empty",
      ok: notEmpty.length === 0,
      detail: emptied.map((t) => t.name).join(", "),
    });

    const triggers = Number(
      (prepareBig(db, "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'trigger'").get() as { n: bigint }).n,
    );
    checks.push({
      name: "triggers recreated",
      ok: triggers === load.triggersRecreated,
      detail: `${triggers} triggers in the database, ${load.triggersRecreated} dropped for the load`,
    });

    const version = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
    db.close();

    try {
      const app = await verifyDatabaseFile(options.databasePath);
      checks.push({
        name: "Vision restore verifier (db-file.ts verify)",
        ok: app.ok,
        detail: `schema version ${app.schemaVersion}, ${app.pendingMigrations} pending migrations`,
      });
    } catch (err) {
      checks.push({ name: "Vision restore verifier (db-file.ts verify)", ok: false, detail: errorText(err) });
    }

    for (const check of checks) {
      if (!check.ok && !collector.failures.some((f) => f.check === check.name)) {
        collector.failures.push({ check: check.name, message: `${check.name} failed: ${check.detail}` });
      }
    }
    return {
      ok: checks.every((c) => c.ok) && collector.failures.length === 0,
      checks,
      failures: collector.failures,
      tables,
      decimalTotals: totals.sort((a, b) => compareUtf8(`${a.table}.${a.column}`, `${b.table}.${b.column}`)),
      sequences,
      schemaFingerprint: { database: fingerprint, freshInstall: fresh.fingerprint },
      schemaVersion: ledger.at(-1)?.version ?? 0,
      sqliteVersion: version.v,
    };
  } finally {
    if (db.isOpen) db.close();
  }
}
