import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
const equivalentDividendChecks = new Set([
  "CHECK (((dividend_amount_convention)::text = ANY ((ARRAY['gross'::character varying, 'net'::character varying, 'unknown'::character varying])::text[])))",
  "CHECK (((dividend_amount_convention)::text = ANY (ARRAY[('gross'::character varying)::text, ('net'::character varying)::text, ('unknown'::character varying)::text])))",
]);

function restoreFingerprintSql(exactSql) {
  const inventorySql = exactSql.replace(
    /SELECT encode\(public\.digest[\s\S]*?FROM objects;\s*$/,
    "SELECT kind, name, definition FROM objects;",
  );
  if (inventorySql === exactSql)
    throw new Error("Schema inventory query changed");
  return inventorySql;
}

export function normalizeSchemaInventory(objects) {
  const normalized = objects.map(({ kind, name, definition }) => {
    const value = [...definition];
    if (kind === "column") value[0] = 0;
    if (
      kind === "constraint" &&
      name ===
        "public.portfolio_transactions.chk_portfolio_transactions_dividend_amount_convention" &&
      equivalentDividendChecks.has(value[4])
    ) {
      value[4] = "CHECK dividend_amount_convention IN (gross,net,unknown)";
    }
    return [kind, name, value];
  });
  normalized.sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return normalized;
}

function normalizedRestoreFingerprint(objects) {
  return createHash("sha256")
    .update(JSON.stringify(normalizeSchemaInventory(objects)))
    .digest("hex");
}

/** Catalog only, with dump-equivalent column order and CHECK spelling normalized. */
export async function readBaselineSchemaInventory({
  connectionString,
  repoRoot,
}) {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const fingerprintSql = readFileSync(
      path.join(repoRoot, "alembic", "baseline", "schema_fingerprint.sql"),
      "utf8",
    );
    const inventory = await client.query(restoreFingerprintSql(fingerprintSql));
    await client.query("ROLLBACK");
    return normalizeSchemaInventory(inventory.rows);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

/** Read only; never returns financial rows, only counts and order-independent digests. */
async function readBaselineManifest({
  connectionString,
  repoRoot,
  timestampUtcColumns = {},
}) {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10 * 60_000,
  });
  await client.connect();
  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query('SET LOCAL search_path = "$user", public');
    const version = await client.query(
      "SELECT version_num FROM public.alembic_version",
    );
    if (version.rows.length !== 1) {
      throw new Error("Expected exactly one Alembic revision");
    }
    const fingerprintSql = readFileSync(
      path.join(repoRoot, "alembic", "baseline", "schema_fingerprint.sql"),
      "utf8",
    );
    const fingerprint = await client.query(fingerprintSql);
    const inventory = await client.query(restoreFingerprintSql(fingerprintSql));
    const relations = await client.query(`
      SELECT n.nspname AS schema, c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'vision_analysis')
        AND c.relkind IN ('r', 'm', 'p')
      ORDER BY n.nspname, c.relname
    `);
    const tables = [];
    for (const relation of relations.rows) {
      const identifier = `${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)}`;
      const tableName = `${relation.schema}.${relation.name}`;
      let rowJson = "to_jsonb(item)";
      for (const column of timestampUtcColumns[tableName] || []) {
        if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
          throw new Error("Invalid timestamp normalization column");
        }
        rowJson = `jsonb_set(${rowJson}, ARRAY['${column}'], coalesce(to_jsonb(item.${quoteIdentifier(column)} AT TIME ZONE 'UTC'), 'null'::jsonb), true)`;
      }
      const result = await client.query(`
        SELECT count(*)::text AS rows,
               encode(public.digest(convert_to(
                 coalesce(string_agg(row_hash, '' ORDER BY row_hash), ''),
                 'UTF8'), 'sha256'), 'hex') AS digest
        FROM (
          SELECT encode(public.digest(convert_to(${rowJson}::text, 'UTF8'),
                       'sha256'), 'hex') AS row_hash
          FROM ${identifier} AS item
        ) AS hashed
      `);
      tables.push({
        schema: relation.schema,
        name: relation.name,
        rows: result.rows[0].rows,
        digest: result.rows[0].digest,
      });
    }
    await client.query("COMMIT");
    return {
      revision: version.rows[0].version_num,
      schemaFingerprint: fingerprint.rows[0].schema_fingerprint,
      restoreFingerprint: normalizedRestoreFingerprint(inventory.rows),
      tables,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

export {
  readBaselineManifest as __readBaselineManifest,
};
