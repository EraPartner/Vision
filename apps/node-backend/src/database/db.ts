/**
 * Typed query builder over the generated schema (ADR-226).
 *
 * `db` builds SQL with Kysely and runs it through `query()` from
 * connection.ts, so a built query joins the ambient `withTransaction()`,
 * keeps the slow-query log and stays visible to tests that mock `query()`.
 * Open transactions with `withTransaction()`, never `db.transaction()`.
 */
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import type {
  CompiledQuery,
  DatabaseConnection,
  Dialect,
  Driver,
  QueryResult,
  RawBuilder,
} from "kysely";
import { query } from "./connection.ts";
import { queryOne, queryRows } from "./rowContracts.ts";
import type { RowSchema } from "./rowContracts.ts";
import type { DB } from "./schema.generated.ts";
import type { QueryRunner } from "../types/rows.ts";

const connection: DatabaseConnection = {
  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const result = await query<R>(compiled.sql, compiled.parameters);
    return result.rowCount === null || compiled.query.kind === "SelectQueryNode"
      ? { rows: result.rows }
      : { rows: result.rows, numAffectedRows: BigInt(result.rowCount) };
  },
  streamQuery() {
    throw new Error("Streaming is not supported; use a paged query");
  },
};

function noTransactions(): never {
  throw new Error("Use withTransaction() from connection.ts, not db.transaction()");
}

const driver: Driver = {
  async init() {},
  async acquireConnection() {
    return connection;
  },
  beginTransaction: noTransactions,
  commitTransaction: noTransactions,
  rollbackTransaction: noTransactions,
  async releaseConnection() {},
  async destroy() {},
};

const dialect: Dialect = {
  createAdapter: () => new PostgresAdapter(),
  createDriver: () => driver,
  createIntrospector: (kysely) => new PostgresIntrospector(kysely),
  createQueryCompiler: () => new PostgresQueryCompiler(),
};

export const db = new Kysely<DB>({ dialect });

interface Compilable {
  compile(): CompiledQuery;
}

/** A query builder, or a `sql` template built with Kysely's `sql` tag. */
export type BuiltQuery = Compilable | RawBuilder<unknown>;

/** Compile a built query to SQL text and bound parameters. */
export function compileQuery(builder: BuiltQuery): CompiledQuery {
  return "isRawBuilder" in builder ? builder.compile(db) : builder.compile();
}

/**
 * Run a built query and check its rows against a row schema (ADR-193). Use it
 * where the rows already have a schema in rowSchemas.ts or rows/. Pass
 * `client` only for a connection outside `withTransaction()`.
 */
export async function checkedRows<T>(
  schema: RowSchema<T>,
  builder: BuiltQuery,
  client?: QueryRunner,
): Promise<T[]> {
  const { sql, parameters } = compileQuery(builder);
  return queryRows(schema, sql, parameters, client);
}

/** {@link checkedRows} for at most one row: the first row, or `undefined`. */
export async function checkedRow<T>(
  schema: RowSchema<T>,
  builder: BuiltQuery,
  client?: QueryRunner,
): Promise<T | undefined> {
  const { sql, parameters } = compileQuery(builder);
  return queryOne(schema, sql, parameters, client);
}
