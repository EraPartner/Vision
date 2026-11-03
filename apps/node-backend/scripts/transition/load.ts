/**
 * Loading the dump into the freshly migrated SQLite database.
 *
 * Everything happens in one transaction with foreign keys off (rows arrive
 * in dump order, not dependency order). Triggers are dropped first, so the
 * rows land exactly as PostgreSQL held them (no derived-column rewrites, no
 * audit side effects), and recreated from their original SQL, in their
 * original order, before COMMIT. CHECK and NOT NULL constraints stay active
 * for every row. `PRAGMA foreign_key_check` must come back empty before
 * COMMIT; any failure rolls everything back.
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { forEachCopyRow } from "./dump.ts";
import { TransitionError, displayValue } from "./errors.ts";
import { DigestCollector, canonicalValue, rowDigest } from "./canonical.ts";
import type { CanonicalValue } from "./canonical.ts";
import type { SequencePlan, TablePlan, TransitionPlan } from "./plan.ts";
import { SEQUENCES_TABLE, quoteIdent } from "./schema.ts";
import type { TargetSchema } from "./schema.ts";
import type { ConversionNote, SqliteValue } from "./typeMapping.ts";
import { ValueError } from "./pgValues.ts";
import { errorText } from "./util.ts";

export interface TableLoadResult {
  table: string;
  rows: number;
  /** Rows the migrations had put in the table (reference rows), replaced by the dump's. */
  replacedReferenceRows: number;
  /** Checksum of the converted values, before they reach SQLite. */
  checksum: string;
  keyed: boolean;
  notes: Partial<Record<ConversionNote, number>>;
}

export interface LoadResult {
  tables: Map<string, TableLoadResult>;
  triggersRecreated: number;
  sequences: Array<{ sequence: string; target: string; lastValue: string }>;
  warnings: string[];
}

export type Progress = (message: string) => void;

function rawKey(plan: TablePlan, fields: ReadonlyArray<string | null>): string {
  if (plan.primaryKey.length === 0) return "(table has no primary key)";
  return plan.primaryKey
    .map((i) => {
      const column = plan.columns[i];
      const field = column === undefined ? null : (fields[column.copyIndex] ?? null);
      return `${column?.name ?? "?"}=${field === null ? "NULL" : JSON.stringify(field)}`;
    })
    .join(", ");
}

const SCHEMA_GAP_HINT =
  "Nothing was installed. The Vision 2.0 value does not fit the new SQLite schema; do not edit the backup. " +
  "Report this message (it names the table, row and value) so the transition or the schema can be fixed.";

async function loadTable(db: DatabaseSync, plan: TablePlan, dumpPath: string): Promise<TableLoadResult> {
  const before = db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(plan.name)}`).get() as { n: number | bigint };
  db.exec(`DELETE FROM ${quoteIdent(plan.name)}`);
  const columnList = plan.columns.map((c) => quoteIdent(c.name)).join(", ");
  const placeholders = plan.columns.map(() => "?").join(", ");
  const insert = db.prepare(`INSERT INTO ${quoteIdent(plan.name)} (${columnList}) VALUES (${placeholders})`);
  const digests = new DigestCollector(plan.copy.rowCount, plan.primaryKey.length);
  const key: SqliteValue[] = new Array<SqliteValue>(plan.primaryKey.length).fill(null);
  const notes: Partial<Record<ConversionNote, number>> = {};
  const note = (kind: ConversionNote): void => {
    notes[kind] = (notes[kind] ?? 0) + 1;
  };
  const values: SqliteValue[] = new Array<SqliteValue>(plan.columns.length).fill(null);
  const canonical: CanonicalValue[] = new Array<CanonicalValue>(plan.columns.length).fill(null);
  let count = 0;
  await forEachCopyRow(dumpPath, plan.copy, ({ fields, line }) => {
    for (let i = 0; i < plan.columns.length; i++) {
      const column = plan.columns[i];
      if (column === undefined) continue;
      const field = fields[column.copyIndex] ?? null;
      if (field === null) {
        values[i] = null;
        continue;
      }
      try {
        values[i] = column.converter.convert(field, note);
      } catch (err) {
        if (!(err instanceof ValueError)) throw err;
        throw new TransitionError(
          `Cannot convert ${plan.name}.${column.name} (${column.converter.facts.pgType} -> ` +
            `${column.converter.facts.declaredType}): ${err.message}`,
          {
            location: {
              table: plan.name,
              column: column.name,
              rowKey: rawKey(plan, fields),
              line,
              value: displayValue(field),
            },
            hint: SCHEMA_GAP_HINT,
          },
        );
      }
    }
    try {
      insert.run(...(values as SQLInputValue[]));
    } catch (err) {
      throw new TransitionError(`SQLite refused a row of ${plan.name}: ${errorText(err)}`, {
        location: { table: plan.name, rowKey: rawKey(plan, fields), line },
        hint: SCHEMA_GAP_HINT,
        cause: err,
      });
    }
    for (let i = 0; i < plan.checksumOrder.length; i++) {
      canonical[i] = canonicalValue(values[plan.checksumOrder[i] ?? 0] ?? null);
    }
    for (let k = 0; k < plan.primaryKey.length; k++) key[k] = values[plan.primaryKey[k] ?? 0] ?? null;
    digests.add(key, rowDigest(canonical));
    count++;
  });
  return {
    table: plan.name,
    rows: count,
    replacedReferenceRows: Number(before.n),
    checksum: digests.checksum(),
    keyed: plan.primaryKey.length > 0,
    notes,
  };
}

function applySequence(db: DatabaseSync, sequence: SequencePlan): string {
  if (sequence.target.kind === "vision_sequences") {
    const result = db
      .prepare(`UPDATE ${SEQUENCES_TABLE} SET last_value = ? WHERE name = ?`)
      .run(sequence.lastValue, sequence.target.name);
    if (Number(result.changes) !== 1) {
      throw new TransitionError(`vision_sequences has no row ${sequence.target.name}.`);
    }
    return `${SEQUENCES_TABLE}.${sequence.target.name}`;
  }
  db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(sequence.target.table);
  if (sequence.lastValue > 0n) {
    db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(sequence.target.table, sequence.lastValue);
  }
  return `sqlite_sequence.${sequence.target.table}`;
}

/** Load every planned table, set the sequences and commit, or change nothing. */
export async function loadDump(
  db: DatabaseSync,
  dumpPath: string,
  plan: TransitionPlan,
  target: TargetSchema,
  progress: Progress = () => undefined,
): Promise<LoadResult> {
  const tables = new Map<string, TableLoadResult>();
  const sequences: LoadResult["sequences"] = [];
  const warnings: string[] = [];
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number | bigint };
    if (Number(fk.foreign_keys) !== 0) throw new TransitionError("Could not switch foreign keys off for the load.");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const trigger of target.triggers) db.exec(`DROP TRIGGER ${quoteIdent(trigger.name)}`);
      for (const table of plan.tables) {
        progress(`  loading ${table.name} (${table.copy.rowCount.toLocaleString("en-US")} rows)`);
        tables.set(table.name, await loadTable(db, table, dumpPath));
      }
      for (const sequence of plan.sequences) {
        sequences.push({
          sequence: sequence.sequence,
          target: applySequence(db, sequence),
          lastValue: sequence.lastValue.toString(),
        });
      }
      for (const trigger of target.triggers) db.exec(trigger.sql);
      const violations = db.prepare("PRAGMA foreign_key_check").all() as Array<{
        table: string;
        rowid: number | null;
        parent: string;
        fkid: number;
      }>;
      if (violations.length > 0) {
        const first = violations
          .slice(0, 5)
          .map((v) => `${v.table} rowid ${String(v.rowid)} -> ${v.parent}`)
          .join("; ");
        throw new TransitionError(
          `The converted data has ${violations.length} foreign key violation(s): ${first}.`,
          { hint: SCHEMA_GAP_HINT },
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  for (const sequence of plan.sequences) {
    for (const user of sequence.users) {
      const max = db.prepare(`SELECT max(${quoteIdent(user.column)}) AS m FROM ${quoteIdent(user.table)}`);
      max.setReadBigInts(true);
      const row = max.get() as { m: bigint | null };
      if (row.m !== null && row.m > sequence.lastValue) {
        warnings.push(
          `Sequence ${sequence.sequence} is at ${sequence.lastValue} but ${user.table}.${user.column} already holds ` +
            `${String(row.m)}; this was so in PostgreSQL too (kept as is).`,
        );
      }
    }
  }
  return { tables, triggersRecreated: target.triggers.length, sequences, warnings };
}

