/**
 * SQLite errors as the PostgreSQL errors Vision's code already handles
 * (ADR-263).
 *
 * Services check `err.code` for SQLSTATEs (23505 unique, 23503 foreign key,
 * 23514 check, 23502 not null, 42P01 undefined table, 57014 cancelled) and
 * sometimes read `err.constraint`. SQLite reports extended result codes and
 * messages such as "UNIQUE constraint failed: recipients.normalized_name".
 * This module maps them, and resolves the unique index name from the table
 * and column list through the schema, so `constraint` keeps naming the index
 * a PostgreSQL error would have named.
 *
 * Triggers raise `RAISE(ABORT, 'vision:<sqlstate>:<constraint>:<message>')`;
 * the prefix becomes `code` and `constraint`.
 */

export interface DatabaseError extends Error {
  code: string;
  constraint?: string;
  table?: string;
  column?: string;
  detail?: string;
  /** SQLite's extended result code, kept for diagnostics. */
  sqliteCode?: number;
}

const SQLITE_CONSTRAINT_CHECK = 275;
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;
const SQLITE_CONSTRAINT_NOTNULL = 1299;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_TRIGGER = 1811;
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_DATATYPE = 3091;
const SQLITE_BUSY = 5;
const SQLITE_INTERRUPT = 9;

export type UniqueIndexResolver = (table: string, columns: readonly string[]) => string | undefined;

function sqliteCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { errcode?: unknown }).errcode;
  return typeof code === "number" ? code : undefined;
}

function make(
  original: Error,
  code: string,
  extra: { constraint?: string | undefined; table?: string | undefined; column?: string | undefined; detail?: string | undefined; message?: string },
): DatabaseError {
  const err = new Error(extra.message ?? original.message, { cause: original }) as DatabaseError;
  err.name = "DatabaseError";
  err.code = code;
  if (extra.constraint !== undefined) err.constraint = extra.constraint;
  if (extra.table !== undefined) err.table = extra.table;
  if (extra.column !== undefined) err.column = extra.column;
  if (extra.detail !== undefined) err.detail = extra.detail;
  const sc = sqliteCode(original);
  if (sc !== undefined) err.sqliteCode = sc;
  if (original.stack) err.stack = `${err.name}: ${err.message}\n${original.stack.split("\n").slice(1).join("\n")}`;
  return err;
}

const TRIGGER_MESSAGE = /^vision:([0-9A-Z]{5}):([^:]*):([\s\S]*)$/;

/**
 * Translate an error thrown by node:sqlite. Errors that already carry a
 * SQLSTATE (thrown by Vision's SQL functions) pass through unchanged.
 */
export function translateSqliteError(err: unknown, resolveUnique?: UniqueIndexResolver): unknown {
  if (!(err instanceof Error)) return err;
  const code = sqliteCode(err);
  if (code === undefined) return err;
  const message = err.message;
  switch (code) {
    case SQLITE_CONSTRAINT_UNIQUE:
    case SQLITE_CONSTRAINT_PRIMARYKEY: {
      const m = /constraint failed: (.+)$/.exec(message);
      const cols = (m?.[1] ?? "").split(",").map((s) => s.trim());
      const table = cols[0]?.split(".")[0];
      const columns = cols.map((c) => c.split(".").slice(1).join("."));
      const constraint = !table
        ? undefined
        : code === SQLITE_CONSTRAINT_PRIMARYKEY
          ? `${table}_pkey`
          : resolveUnique?.(table, columns);
      return make(err, "23505", {
        constraint,
        table,
        detail: `Key (${columns.join(", ")}) already exists.`,
        message: `duplicate key value violates unique constraint${constraint ? ` "${constraint}"` : ""}`,
      });
    }
    case SQLITE_CONSTRAINT_FOREIGNKEY:
      return make(err, "23503", {
        message: "insert or update violates a foreign key constraint",
      });
    case SQLITE_CONSTRAINT_CHECK: {
      const m = /CHECK constraint failed: (.+)$/.exec(message);
      const constraint = m?.[1]?.trim();
      return make(err, "23514", {
        constraint,
        message: `new row violates check constraint${constraint ? ` "${constraint}"` : ""}`,
      });
    }
    case SQLITE_CONSTRAINT_NOTNULL: {
      const m = /NOT NULL constraint failed: ([^.]+)\.(.+)$/.exec(message);
      return make(err, "23502", {
        table: m?.[1],
        column: m?.[2],
        message: `null value in column "${m?.[2] ?? "?"}" violates not-null constraint`,
      });
    }
    case SQLITE_CONSTRAINT_DATATYPE:
      return make(err, "22P02", {});
    case SQLITE_CONSTRAINT_TRIGGER: {
      const m = TRIGGER_MESSAGE.exec(message);
      if (m) {
        return make(err, m[1] ?? "P0001", {
          constraint: m[2] ? m[2] : undefined,
          message: m[3] ?? message,
        });
      }
      return make(err, "P0001", {});
    }
    case SQLITE_BUSY:
      return make(err, "55P03", {});
    case SQLITE_INTERRUPT:
      return make(err, "57014", { message: "canceling statement due to statement timeout" });
    default:
      break;
  }
  if (/^no such table: /.test(message)) return make(err, "42P01", {});
  if (/^no such column: /.test(message)) return make(err, "42703", {});
  if (/^no such function: /.test(message)) return make(err, "42883", {});
  if (/syntax error/.test(message)) return make(err, "42601", {});
  return err;
}
