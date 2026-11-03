/**
 * Read the SQLite schema catalog of the test database (ADR-263) for schema
 * contract tests: what PostgreSQL's pg_catalog and information_schema answered.
 * SQLite keeps constraint names only in the CREATE TABLE text, so
 * `constraintNames` reads them from there.
 */
import { getTestPool } from "../setup/db.ts";

export type SchemaObjectType = "table" | "view" | "index" | "trigger";

export interface CatalogColumn {
  name: string;
  /** The declared type, for example DECIMAL_TEXT(18,2) or DATE_TEXT. */
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  /** 0 ordinary, 2 or 3 generated. */
  hidden: number;
}

export interface CatalogForeignKey {
  /** The referenced table. */
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
}

export interface CatalogIndex {
  name: string;
  unique: number;
  /** c = CREATE INDEX, u = UNIQUE constraint, pk = PRIMARY KEY. */
  origin: string;
  partial: number;
}

const pool = getTestPool();

/** The type of a schema object, or null when it does not exist. */
export async function objectType(name: string): Promise<SchemaObjectType | null> {
  const { rows } = await pool.query<{ type: SchemaObjectType }>(
    "SELECT type FROM sqlite_schema WHERE name = $1",
    [name],
  );
  return rows[0]?.type ?? null;
}

/** Names of the schema objects of one type, sorted. */
export async function objectNames(type: SchemaObjectType, like = "%"): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE type = $1 AND name LIKE $2 AND name NOT LIKE 'sqlite_%' ORDER BY name",
    [type, like],
  );
  return rows.map((row) => row.name);
}

/** The CREATE statement of a schema object. */
export async function objectSql(name: string): Promise<string> {
  const { rows } = await pool.query<{ sql: string | null }>(
    "SELECT sql FROM sqlite_schema WHERE name = $1",
    [name],
  );
  const text = rows[0]?.sql;
  if (typeof text !== "string") throw new Error(`no schema object named ${name}`);
  return text;
}

/**
 * Named constraints of a table, sorted, without the storage-type CHECKs
 * (`<table>_<column>__vtype`), which stand for PostgreSQL column types.
 */
export async function constraintNames(table: string): Promise<string[]> {
  const text = await objectSql(table);
  const names = [...text.matchAll(/\bCONSTRAINT\s+("?)(\w+)\1/giu)].map((match) => match[2] ?? "");
  return names.filter((name) => !name.endsWith("__vtype")).sort();
}

export async function columns(table: string): Promise<CatalogColumn[]> {
  const { rows } = await pool.query<CatalogColumn>(
    "SELECT name, type, \"notnull\", dflt_value, pk, hidden FROM pragma_table_xinfo($1) ORDER BY cid",
    [table],
  );
  return rows;
}

export async function column(table: string, name: string): Promise<CatalogColumn | undefined> {
  return (await columns(table)).find((entry) => entry.name === name);
}

export async function foreignKeys(table: string): Promise<CatalogForeignKey[]> {
  const { rows } = await pool.query<CatalogForeignKey>(
    'SELECT "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list($1) ORDER BY "table", "from"',
    [table],
  );
  return rows;
}

export async function indexes(table: string): Promise<CatalogIndex[]> {
  const { rows } = await pool.query<CatalogIndex>(
    "SELECT name, \"unique\", origin, partial FROM pragma_index_list($1) ORDER BY name",
    [table],
  );
  return rows;
}

/** The indexed column names (or NULL for expression parts) of one index. */
export async function indexColumns(index: string): Promise<Array<string | null>> {
  const { rows } = await pool.query<{ name: string | null }>(
    "SELECT name FROM pragma_index_info($1) ORDER BY seqno",
    [index],
  );
  return rows.map((row) => row.name);
}

/** Triggers on a table with their CREATE text. */
export async function triggers(table: string): Promise<Array<{ name: string; sql: string }>> {
  const { rows } = await pool.query<{ name: string; sql: string }>(
    "SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = $1 ORDER BY name",
    [table],
  );
  return rows;
}
