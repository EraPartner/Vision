/** Isolated, bounded SQL execution over the approved analysis views only. */

import pg from "pg";
import settings from "../config/config.js";
import { APPROVED_ANALYSIS_RELATIONS } from "./analysisCatalog.js";

const MAX_ROWS = 1000;
const DEFAULT_ROWS = 500;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_SQL_BYTES = 100_000;
const activeQueries = new Map();

const pool = new pg.Pool({
  connectionString: settings.database.analysisUrl,
  max: 2,
  idleTimeoutMillis: 15_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 5_000,
  application_name: "vision-analysis-executor",
});

// Keep one connection outside the execution pool so cancellation still works
// when every query slot is occupied by a long-running statement.
const cancellationPool = new pg.Pool({
  connectionString: settings.database.analysisUrl,
  max: 1,
  idleTimeoutMillis: 15_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 2_000,
  application_name: "vision-analysis-canceller",
});

function maskSql(sql) {
  let out = "";
  let state = "code";
  let dollar = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out += "\n";
      } else out += " ";
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        out += "  ";
        i++;
        state = "code";
      } else out += ch === "\n" ? "\n" : " ";
      continue;
    }
    if (state === "single") {
      if (ch === "'" && next === "'") {
        out += "  ";
        i++;
      } else if (ch === "'") {
        out += " ";
        state = "code";
      } else out += ch === "\n" ? "\n" : " ";
      continue;
    }
    if (state === "double") {
      if (ch === '"' && next === '"') {
        out += '""';
        i++;
      } else if (ch === '"') {
        out += '"';
        state = "code";
      } else out += ch;
      continue;
    }
    if (state === "dollar") {
      if (sql.startsWith(dollar, i)) {
        out += " ".repeat(dollar.length);
        i += dollar.length - 1;
        state = "code";
      } else out += ch === "\n" ? "\n" : " ";
      continue;
    }
    if (ch === "-" && next === "-") {
      out += "  ";
      i++;
      state = "line";
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i++;
      state = "block";
      continue;
    }
    if (ch === "'") {
      out += " ";
      state = "single";
      continue;
    }
    if (ch === '"') {
      out += '"';
      state = "double";
      continue;
    }
    if (ch === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollar = match[0];
        out += " ".repeat(dollar.length);
        i += dollar.length - 1;
        state = "dollar";
        continue;
      }
    }
    out += ch;
  }
  return out;
}

export function __validateAnalysisSql(sql, datasetIds = []) {
  if (typeof sql !== "string" || !sql.trim())
    throw new Error("SQL is required");
  if (Buffer.byteLength(sql) > MAX_SQL_BYTES)
    throw new Error("SQL exceeds the 100 KB limit");
  const masked = maskSql(sql);
  const trimmed = masked.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed))
    throw new Error("Only SELECT queries are allowed");
  if (trimmed.includes(";"))
    throw new Error("Exactly one SQL statement is allowed");
  const forbidden =
    /\b(insert|update|delete|merge|create|alter|drop|truncate|copy|call|do|grant|revoke|set|reset|vacuum|analyze|refresh|lock|listen|notify|prepare|execute|deallocate|discard|reindex|cluster|load|into)\b/i;
  if (forbidden.test(trimmed))
    throw new Error("SQL contains a forbidden operation");
  if (
    /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|dblink|pg_sleep|set_config)\s*\(/i.test(
      trimmed,
    )
  ) {
    throw new Error("SQL contains a forbidden function");
  }
  if (/\b(pg_catalog|information_schema|public)\s*\./i.test(trimmed)) {
    throw new Error("Only approved analysis datasets may be queried");
  }
  if (!Array.isArray(datasetIds) || datasetIds.length === 0) {
    throw new Error("At least one approved dataset must be declared");
  }
  const cteNames = new Set(
    [
      ...trimmed.matchAll(/(?:\bwith\b|,)\s*([a-z_][a-z0-9_]*)\s+as\s*\(/gi),
    ].map((match) => match[1].toLowerCase()),
  );
  const relations = [
    ...trimmed.matchAll(
      /\b(?:from|join)\s+((?:"[^"]+"|[a-z_][a-z0-9_]*)(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_]*))?)/gi,
    ),
  ].map((match) => match[1].replace(/"/g, "").replace(/\s/g, "").toLowerCase());
  for (const relation of relations) {
    if (cteNames.has(relation)) continue;
    if (!APPROVED_ANALYSIS_RELATIONS.has(relation)) {
      throw new Error(
        `Relation is not an approved analysis dataset: ${relation}`,
      );
    }
  }
  const relationByDataset = {
    transactions: "vision_analysis.transactions_v1",
    accounts: "vision_analysis.accounts_v1",
    holdings: "vision_analysis.holding_events_v1",
    "cash-flows": "vision_analysis.cash_flows_v1",
  };
  const unknownDataset = datasetIds.find((id) => !relationByDataset[id]);
  if (unknownDataset) {
    throw new Error(`Dataset is not approved: ${unknownDataset}`);
  }
  const expected = new Set(datasetIds.map((id) => relationByDataset[id]));
  if (
    relations.some(
      (relation) => !cteNames.has(relation) && !expected.has(relation),
    )
  ) {
    throw new Error("SQL references a dataset not declared by the analysis");
  }
  return sql.trim().replace(/;\s*$/, "");
}

function safeValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return undefined;
  return value;
}

function postgresType(oid) {
  if (oid === 16) return "boolean";
  if ([20, 21, 23].includes(oid)) return "integer";
  if ([700, 701, 1700].includes(oid)) return "decimal";
  if (oid === 1082) return "date";
  if ([1114, 1184].includes(oid)) return "datetime";
  if ([114, 3802].includes(oid)) return "json";
  return "string";
}

export async function executeAnalysisSql({
  requestId,
  sql,
  values = [],
  datasetIds = [],
  limit = DEFAULT_ROWS,
  offset = 0,
}) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId || ""))
    throw new Error("A valid request ID is required");
  if (
    !Array.isArray(values) ||
    values.some(
      (value) =>
        value !== null &&
        !["string", "number", "boolean"].includes(typeof value),
    )
  ) {
    throw new Error("SQL parameters must be scalar values");
  }
  const checkedSql = __validateAnalysisSql(sql, datasetIds);
  const pageLimit = Math.min(
    Math.max(Number(limit) || DEFAULT_ROWS, 1),
    MAX_ROWS,
  );
  const pageOffset = Math.max(Number(offset) || 0, 0);
  const client = await pool.connect();
  const startedAt = new Date().toISOString();
  let rollbackFailed = false;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    await client.query(
      "SET LOCAL idle_in_transaction_session_timeout = '5000ms'",
    );
    await client.query("SET LOCAL work_mem = '8MB'");
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    activeQueries.set(requestId, { pid });
    const wrapped = `SELECT * FROM (${checkedSql}) AS vision_analysis_result LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
    const result = await client.query(wrapped, [
      ...values,
      pageLimit + 1,
      pageOffset,
    ]);
    const hasMore = result.rows.length > pageLimit;
    let rows = result.rows
      .slice(0, pageLimit)
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, safeValue(value)]),
        ),
      );
    let byteLength = Buffer.byteLength(JSON.stringify(rows));
    let byteTruncated = false;
    while (rows.length && byteLength > MAX_RESULT_BYTES) {
      rows.pop();
      byteTruncated = true;
      byteLength = Buffer.byteLength(JSON.stringify(rows));
    }
    await client.query("COMMIT");
    return {
      requestId,
      startedAt,
      completedAt: new Date().toISOString(),
      executor: "postgresql-role-v1",
      rows,
      columns: (result.fields ?? []).map((field) => ({
        id: field.name,
        type: postgresType(field.dataTypeID),
      })),
      window: byteTruncated
        ? {
            kind: "truncated",
            returnedRows: rows.length,
            enforcedLimit: pageLimit,
            reason: "byte-limit",
          }
        : {
            kind: "page",
            offset: pageOffset,
            limit: pageLimit,
            hasMore,
            returnedRows: rows.length,
          },
      byteLength,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      rollbackFailed = true;
    }
    throw error;
  } finally {
    activeQueries.delete(requestId);
    client.release(rollbackFailed || undefined);
  }
}

export async function cancelAnalysisQuery(requestId) {
  const active = activeQueries.get(requestId);
  if (!active) return { cancelled: false, reason: "not-running" };
  // PostgreSQL permits a role to cancel its own sessions. Use the same
  // restricted pool so cancellation does not require pg_signal_backend on the
  // wider application role.
  const result = await cancellationPool.query(
    "SELECT pg_cancel_backend($1) AS cancelled",
    [active.pid],
  );
  return { cancelled: result.rows[0]?.cancelled === true };
}

export async function closeAnalysisPool() {
  await Promise.all([pool.end(), cancellationPool.end()]);
}
