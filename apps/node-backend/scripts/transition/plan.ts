/**
 * Matching the PostgreSQL dump to the SQLite schema: which COPY block
 * feeds which table, how each column converts, and where each sequence's
 * state goes. Everything that does not match one-to-one must be on one of
 * the explicit lists below, or the run stops before it loads anything.
 */
import type { CopyBlock, DumpInventory, DumpTable, SetvalCall } from "./dump.ts";
import { qualified } from "./dump.ts";
import { TransitionError } from "./errors.ts";
import { SchemaMismatchError, planColumnConversion } from "./typeMapping.ts";
import type { ColumnConverter, SqlValueChecks } from "./typeMapping.ts";
import { LEDGER_TABLE, SEQUENCES_TABLE } from "./schema.ts";
import type { TargetSchema, TargetTable } from "./schema.ts";
import { compareText } from "./util.ts";

/** The migration ledger a Vision 2.0.0 database has, exactly. */
export const EXPECTED_V2_LEDGER: readonly string[] = [
  "0001_baseline",
  "0002_remove_cloud_ai",
  "0003_remove_life_scenarios",
  "0004_remove_audit_history",
  "0005_simplify_portfolio_reconciliation",
];

/** Dump tables that have no SQLite table, and why their rows are not copied. */
export const DUMP_TABLES_WITHOUT_TARGET: ReadonlyMap<string, string> = new Map([
  [
    "public.kysely_migration",
    "the Kysely migration ledger of 2.0; checked to be exactly 0001-0005, then replaced by vision_migrations",
  ],
  ["public.kysely_migration_lock", "the Kysely migrator's lock row; SQLite's migrator needs none"],
]);

/** Generated PostgreSQL columns SQLite does not have. COPY never carries them. */
export const DUMP_GENERATED_COLUMNS_DROPPED: ReadonlyMap<string, string> = new Map([
  [
    "public.ai_research_passages.search_vector",
    "generated tsvector of the passage text; SQLite search computes it on the fly (vision_fts_match)",
  ],
]);

/** SQLite tables the dump does not fill, and why. */
export const TARGET_TABLES_NOT_FROM_DUMP: ReadonlyMap<string, string> = new Map([
  [LEDGER_TABLE, "SQLite migration ledger, written by the migrator when the new database is created"],
  [SEQUENCES_TABLE, "bigint sequence state, set from the dump's setval() lines"],
  [
    "mv_monthly_summary",
    "former materialized view; left empty, Vision rebuilds it (materializedViewService) when it starts",
  ],
  [
    "mv_category_totals",
    "former materialized view; left empty, Vision rebuilds it (materializedViewService) when it starts",
  ],
]);

export interface ColumnPlan {
  name: string;
  /** Position of the field in the COPY row. */
  copyIndex: number;
  converter: ColumnConverter;
}

export interface TablePlan {
  /** SQLite table name (the PostgreSQL table in schema public). */
  name: string;
  dump: DumpTable;
  copy: CopyBlock;
  target: TargetTable;
  /** In COPY order; the INSERT lists the columns in this order. */
  columns: ColumnPlan[];
  /** Indexes into `columns` of the primary key, in key order (empty: no key). */
  primaryKey: number[];
  /** Indexes into `columns`, sorted by column name: the checksum order. */
  checksumOrder: number[];
}

export type SequenceTarget =
  | { kind: "vision_sequences"; name: string }
  | { kind: "sqlite_sequence"; table: string };

export interface SequencePlan {
  sequence: string;
  setval: SetvalCall;
  /** The value the next nextval() would have returned in PostgreSQL, minus one. */
  lastValue: bigint;
  target: SequenceTarget;
  /** Tables whose keys draw from this sequence (for the max-key check). */
  users: Array<{ table: string; column: string }>;
}

export interface TransitionPlan {
  tables: TablePlan[];
  skippedDumpTables: Array<{ name: string; rows: number; reason: string }>;
  droppedGeneratedColumns: Array<{ name: string; reason: string }>;
  targetOnlyTables: Array<{ name: string; reason: string }>;
  sequences: SequencePlan[];
}

function schemaError(message: string, hint?: string): TransitionError {
  return new TransitionError(message, {
    hint:
      hint ??
      "The SQLite schema of this checkout and the Vision 2.0 dump do not line up. Do not work around it: " +
        "report it, with this message, so the schema or the transition can be fixed.",
  });
}

/** The dump's ledger must be exactly the 2.0.0 one. */
export function checkLedger(ledger: readonly string[]): void {
  const expected = EXPECTED_V2_LEDGER;
  const same = ledger.length === expected.length && ledger.every((name, i) => name === expected[i]);
  if (same) return;
  const extra = ledger.filter((name) => !expected.includes(name));
  const missing = expected.filter((name) => !ledger.includes(name));
  let why: string;
  if (ledger.length === 0) why = "the dump has no kysely_migration rows";
  else if (extra.length > 0) why = `it has migrations Vision 2.0.0 did not ship: ${extra.join(", ")} (a newer database)`;
  else if (missing.length > 0) why = `it lacks ${missing.join(", ")} (an older database)`;
  else why = `its order differs: ${ledger.join(", ")}`;
  throw new TransitionError(
    `This backup's database is not at the Vision 2.0.0 schema: ${why}. ` +
      `Expected exactly ${expected.join(", ")}.`,
    {
      location: { table: "kysely_migration" },
      hint:
        missing.length > 0 && extra.length === 0
          ? "Open the backup in Vision 2.0.0 first (restore it there; Vision migrates it), make a new backup, and convert that one."
          : "This transition only converts Vision 2.0.0 backups. Use a backup made by Vision 2.0.0.",
    },
  );
}

/** Build the plan, or fail with the first mismatch. */
export function buildPlan(inventory: DumpInventory, target: TargetSchema, checks: SqlValueChecks): TransitionPlan {
  const copiesByTable = new Map<string, CopyBlock>();
  for (const copy of inventory.copies) {
    const key = qualified(copy.schema, copy.table);
    if (copiesByTable.has(key)) throw schemaError(`db.sql has two COPY blocks for ${key}.`);
    copiesByTable.set(key, copy);
  }
  for (const key of copiesByTable.keys()) {
    if (!inventory.tables.has(key)) throw schemaError(`db.sql copies rows into ${key}, which it never creates.`);
  }

  const tables: TablePlan[] = [];
  const skippedDumpTables: TransitionPlan["skippedDumpTables"] = [];
  const droppedGeneratedColumns: TransitionPlan["droppedGeneratedColumns"] = [];
  const fedTargets = new Set<string>();

  const dumpTables = [...inventory.tables.values()].sort((a, b) =>
    compareText(qualified(a.schema, a.name), qualified(b.schema, b.name)),
  );
  for (const dumpTable of dumpTables) {
    const key = qualified(dumpTable.schema, dumpTable.name);
    const copy = copiesByTable.get(key);
    if (copy === undefined) throw schemaError(`db.sql creates ${key} but has no COPY block for it.`);
    const skipReason = DUMP_TABLES_WITHOUT_TARGET.get(key);
    if (skipReason !== undefined) {
      skippedDumpTables.push({ name: key, rows: copy.rowCount, reason: skipReason });
      continue;
    }
    if (dumpTable.schema !== "public") {
      throw schemaError(`db.sql has a table ${key} outside schema public, which the SQLite schema cannot hold.`);
    }
    const targetTable = target.tables.get(dumpTable.name);
    if (targetTable === undefined || TARGET_TABLES_NOT_FROM_DUMP.has(dumpTable.name)) {
      throw schemaError(`Table ${dumpTable.name} (${copy.rowCount} rows in the dump) has no SQLite table to go to.`);
    }
    fedTargets.add(dumpTable.name);
    tables.push(planTable(inventory, dumpTable, copy, targetTable, checks, droppedGeneratedColumns));
  }

  const targetOnlyTables: TransitionPlan["targetOnlyTables"] = [];
  for (const name of [...target.tables.keys()].sort(compareText)) {
    if (fedTargets.has(name)) continue;
    const reason = TARGET_TABLES_NOT_FROM_DUMP.get(name);
    if (reason === undefined) {
      throw schemaError(`SQLite table ${name} has no counterpart in the dump, so it would stay empty.`);
    }
    targetOnlyTables.push({ name, reason });
  }

  return {
    tables,
    skippedDumpTables,
    droppedGeneratedColumns,
    targetOnlyTables,
    sequences: planSequences(inventory, target),
  };
}

function planTable(
  inventory: DumpInventory,
  dumpTable: DumpTable,
  copy: CopyBlock,
  target: TargetTable,
  checks: SqlValueChecks,
  dropped: TransitionPlan["droppedGeneratedColumns"],
): TablePlan {
  const name = dumpTable.name;
  const dumpColumns = new Map(dumpTable.columns.map((c) => [c.name, c]));
  const targetColumns = new Map(target.columns.map((c) => [c.name, c]));
  // Every stored PostgreSQL column must be in COPY, and nothing else.
  const stored = dumpTable.columns.filter((c) => !c.generated).map((c) => c.name);
  if (stored.length !== copy.columns.length || stored.some((c) => !copy.columns.includes(c))) {
    throw schemaError(
      `COPY for ${name} lists (${copy.columns.join(", ")}) but the table stores (${stored.join(", ")}).`,
      "The dump is not an intact pg_dump of Vision 2.0. Make a new backup in Vision 2.0.",
    );
  }
  for (const column of dumpTable.columns) {
    if (!column.generated || targetColumns.has(column.name)) continue;
    const key = `public.${name}.${column.name}`;
    const reason = DUMP_GENERATED_COLUMNS_DROPPED.get(key);
    if (reason === undefined) throw schemaError(`Generated column ${name}.${column.name} has no SQLite column.`);
    dropped.push({ name: key, reason });
  }
  const columns: ColumnPlan[] = copy.columns.map((columnName, copyIndex) => {
    const targetColumn = targetColumns.get(columnName);
    if (targetColumn === undefined) {
      throw schemaError(`Column ${name}.${columnName} holds data in the dump but has no SQLite column.`);
    }
    if (targetColumn.hidden !== 0) {
      throw schemaError(`Column ${name}.${columnName} is a generated column in SQLite but stored data in PostgreSQL.`);
    }
    const dumpColumn = dumpColumns.get(columnName);
    if (dumpColumn === undefined) throw schemaError(`COPY for ${name} names an unknown column ${columnName}.`);
    const enumLabels = inventory.enums.get(dumpColumn.type);
    let converter: ColumnConverter;
    try {
      converter = planColumnConversion(
        {
          table: name,
          column: columnName,
          declaredType: targetColumn.declaredType,
          pgType: dumpColumn.type,
          enumLabels: enumLabels === undefined ? undefined : new Set(enumLabels),
        },
        checks,
      );
    } catch (err) {
      if (err instanceof SchemaMismatchError) throw schemaError(err.message);
      throw err;
    }
    return { name: columnName, copyIndex, converter };
  });
  for (const targetColumn of target.insertable) {
    if (!copy.columns.includes(targetColumn.name)) {
      throw schemaError(`SQLite column ${name}.${targetColumn.name} has no data in the dump.`);
    }
  }
  const primaryKey = target.primaryKey.map((pk) => {
    const index = columns.findIndex((c) => c.name === pk);
    if (index < 0) throw schemaError(`Primary key column ${name}.${pk} is not in the dump.`);
    return index;
  });
  const checksumOrder = columns
    .map((c, i) => ({ name: c.name, i }))
    .sort((a, b) => compareText(a.name, b.name))
    .map((c) => c.i);
  return { name, dump: dumpTable, copy, target, columns, primaryKey, checksumOrder };
}

function planSequences(inventory: DumpInventory, target: TargetSchema): SequencePlan[] {
  const plans: SequencePlan[] = [];
  const seen = new Set<string>();
  // Which SQLite columns draw from a vision_sequences sequence.
  const users = new Map<string, Array<{ table: string; column: string }>>();
  for (const table of target.tables.values()) {
    for (const [column, sequence] of table.nextvalDefaults) {
      const list = users.get(sequence) ?? [];
      list.push({ table: table.name, column });
      users.set(sequence, list);
    }
  }
  for (const setval of inventory.setvals) {
    const key = qualified(setval.schema, setval.sequence);
    if (seen.has(key)) throw schemaError(`db.sql sets sequence ${key} twice.`);
    seen.add(key);
    const sequence = inventory.sequences.get(key);
    if (sequence === undefined) throw schemaError(`db.sql sets ${key}, which it never creates.`);
    if (sequence.increment !== 1n) {
      throw schemaError(`Sequence ${key} increments by ${sequence.increment}; SQLite sequences increment by 1.`);
    }
    if (setval.schema !== "public") throw schemaError(`Sequence ${key} is outside schema public.`);
    const lastValue = setval.isCalled ? setval.value : setval.value - 1n;
    if (lastValue < 0n) throw schemaError(`Sequence ${key} is set below 1 (${setval.value}).`);
    let planTarget: SequenceTarget | undefined;
    let planUsers: Array<{ table: string; column: string }> = [];
    if (target.sequences.has(setval.sequence)) {
      planTarget = { kind: "vision_sequences", name: setval.sequence };
      planUsers = users.get(setval.sequence) ?? [];
    } else if (sequence.ownedBy !== undefined) {
      const owner = target.tables.get(sequence.ownedBy.table);
      const pk = owner?.primaryKey;
      if (
        owner?.autoincrement === true &&
        pk?.length === 1 &&
        pk[0] === sequence.ownedBy.column &&
        sequence.ownedBy.schema === "public"
      ) {
        planTarget = { kind: "sqlite_sequence", table: owner.name };
        planUsers = [{ table: owner.name, column: sequence.ownedBy.column }];
      }
    }
    if (planTarget === undefined) {
      throw schemaError(
        `Sequence ${key}${sequence.ownedBy ? ` (owned by ${sequence.ownedBy.table}.${sequence.ownedBy.column})` : ""} ` +
          "has no SQLite counterpart: neither a vision_sequences row nor an AUTOINCREMENT key.",
      );
    }
    plans.push({ sequence: key, setval, lastValue, target: planTarget, users: planUsers });
  }
  for (const name of target.sequences) {
    if (!plans.some((p) => p.target.kind === "vision_sequences" && p.target.name === name)) {
      throw schemaError(`vision_sequences row ${name} has no setval() in the dump, so its state would be lost.`);
    }
  }
  for (const table of target.tables.values()) {
    if (!table.autoincrement) continue;
    if (TARGET_TABLES_NOT_FROM_DUMP.has(table.name)) continue;
    if (!plans.some((p) => p.target.kind === "sqlite_sequence" && p.target.table === table.name)) {
      throw schemaError(`AUTOINCREMENT table ${table.name} has no PostgreSQL sequence in the dump.`);
    }
  }
  return plans.sort((a, b) => compareText(a.sequence, b.sequence));
}
