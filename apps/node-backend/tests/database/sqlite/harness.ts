/**
 * Shared helpers for the SQLite dialect golden tests: an in-memory
 * connection with Vision's functions registered, and fixture loading. The
 * fixtures hold outputs captured from PostgreSQL 18.6 (C locale), so the
 * tests run without a PostgreSQL server.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { registerFunctions } from "../../../src/database/sqlite/functions.ts";

export type SqlArg = null | number | string;

export function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  registerFunctions(db, { transactionStart: null, statementStart: null });
  return db;
}

export function loadFixture<V>(name: string): V[] {
  const text = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
  return (JSON.parse(text) as { vectors: V[] }).vectors;
}

/** The single value of a one-column SELECT. */
export function scalar(db: DatabaseSync, sql: string, ...args: SqlArg[]): unknown {
  const row = db.prepare(sql).get(...args) as Record<string, unknown> | undefined;
  if (row === undefined) return undefined;
  return Object.values(row)[0];
}

/** Run `fn`; return its value or the SQLSTATE-like `code` of what it threw. */
export function outcome<T>(fn: () => T): { value: T } | { error: string } {
  try {
    return { value: fn() };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return { error: typeof code === "string" ? code : `thrown: ${String(err)}` };
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
