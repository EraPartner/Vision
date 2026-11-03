/**
 * Isolated, bounded SQL execution over the approved analysis views only
 * (ADR-263).
 *
 * A statement runs in the analysis sandbox (analysisSandbox.ts): a child
 * process with a fresh in-memory SQLite database and an environment that
 * holds only the time zone. The executor reads the rows of the approved
 * `vision_analysis_*` views the statement names from one read snapshot and
 * hands them to the process, which serves them as `vision_analysis.<view>`
 * with `query_only` on. The process never sees the database file or its
 * path. One sandbox runs at a time; a statement gets 5 s, after which the
 * request fails with SQLSTATE 57014 and the process is killed, even when
 * SQLite is still busy inside one statement.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withReadSnapshot } from "../database/connection.ts";
import type { PgPoolClient } from "../database/connection.ts";
import { toSqlParam } from "../database/sqlite/values.ts";
import { APPROVED_ANALYSIS_RELATIONS } from "./analysisCatalog.ts";
import type {
  SandboxColumn,
  SandboxKind,
  SandboxMessage,
  SandboxRequest,
  SandboxTable,
  SandboxValue,
} from "./analysisSandbox.ts";
import { SANDBOX_FLAG, encodeRequest } from "./analysisSandbox.ts";
import { nanToZero, nonZeroOr } from "../lib/math.ts";

const MAX_ROWS = 1000;
const DEFAULT_ROWS = 500;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_SQL_BYTES = 100_000;
const STATEMENT_TIMEOUT_MS = 5_000;
/** Copying the views into the sandbox, before the statement starts. */
const LOAD_TIMEOUT_MS = 60_000;
/** How long a request waits for the sandbox another request is using. */
const QUEUE_TIMEOUT_MS = 30_000;
/** The sandbox stops itself at the deadline; this is how long the executor waits before killing it. */
const TERMINATE_GRACE_MS = 250;
/** The sandbox's JavaScript heap where the runtime takes a limit (Node; Bun has no such flag). */
const SANDBOX_HEAP_MB = 1024;
/** What the sandbox may write to stderr that the executor keeps, for a crash message. */
const STDERR_KEEP_BYTES = 4096;
/**
 * The bundled sandbox in a packaged app, relative to the directory of the
 * backend executable. packaging/electron/runtime/native.ts names the same path.
 */
export const PACKAGED_ANALYSIS_SANDBOX = "tools/analysis-sandbox.js";
const EXECUTOR = "sqlite-sandbox-v1";

export interface AnalysisSqlRequest {
  requestId?: string | undefined;
  sql: string;
  values?: unknown[] | undefined;
  datasetIds?: string[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export type AnalysisSqlWindow =
  | {
      kind: "truncated";
      returnedRows: number;
      enforcedLimit: number;
      reason: string;
    }
  | {
      kind: "page";
      offset: number;
      limit: number;
      hasMore: boolean;
      returnedRows: number;
    };

export interface AnalysisSqlResult {
  requestId: string | undefined;
  startedAt: string;
  completedAt: string;
  executor: string;
  rows: Record<string, unknown>[];
  columns: Array<{ id: string; type: string }>;
  window: AnalysisSqlWindow;
  byteLength: number;
}

const RELATIONS_BY_DATASET: Record<string, string[]> = {
  transactions: [
    "vision_analysis.transactions_v1",
    "vision_analysis.transactions_v2",
  ],
  accounts: ["vision_analysis.accounts_v1"],
  holdings: ["vision_analysis.holding_events_v1"],
  "cash-flows": [
    "vision_analysis.cash_flows_v1",
    "vision_analysis.cash_flows_v2",
  ],
};

/**
 * Declared types for the view columns the baseline computes with an
 * expression, which SQLite reports without a type; they are the PostgreSQL
 * view's column types.
 */
const COMPUTED_COLUMN_TYPES: Record<string, Record<string, string>> = {
  accounts_v1: { statement_balances: "JSON_TEXT" },
  cash_flows_v1: {
    flow_type: "TEXT",
    spending_amount: "DECIMAL_TEXT",
    positive_flow_amount: "DECIMAL_TEXT",
  },
  cash_flows_v2: {
    flow_type: "TEXT",
    spending_amount: "DECIMAL_TEXT",
    positive_flow_amount: "DECIMAL_TEXT",
    category_path_segments: "TEXT_ARRAY",
    category_path_ids: "TEXT_ARRAY",
  },
  holding_events_v1: { fees: "DECIMAL_TEXT", taxes: "DECIMAL_TEXT" },
  transactions_v2: {
    category_path_segments: "TEXT_ARRAY",
    category_path_ids: "TEXT_ARRAY",
  },
};
/** TEXT_ARRAY columns that were PostgreSQL integer[] (the others were text[]). */
const INTEGER_ARRAY_COLUMNS = new Set(["category_path_ids"]);

/**
 * Blank out comments and string literals, keeping identifiers, so the
 * checks below see only SQL keywords and names. Follows SQLite's lexer:
 * '...' strings, "..."/`...`/[...] identifiers, -- and /* comments. `$`
 * starts a parameter in SQLite, not a quoted string.
 */
function maskSql(sql: string) {
  let out = "";
  let state = "code";
  let close = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i] ?? "";
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
    if (state === "identifier") {
      if (ch === close && close !== "]" && next === close) {
        out += ch + ch;
        i++;
      } else if (ch === close) {
        out += '"';
        state = "code";
      } else out += ch;
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
    if (ch === '"' || ch === "`" || ch === "[") {
      // Every identifier quote becomes ", so the relation checks see one form.
      out += '"';
      close = ch === "[" ? "]" : ch;
      state = "identifier";
      continue;
    }
    out += ch;
  }
  return out;
}

interface CheckedSql {
  /** The statement to run: the input, trimmed, without a final semicolon. */
  sql: string;
  /** The same text with comments and strings blanked out. */
  masked: string;
}

function checkAnalysisSql(sql: unknown, datasetIds: string[] = []): CheckedSql {
  if (typeof sql !== "string" || !sql.trim())
    throw new Error("SQL is required");
  if (Buffer.byteLength(sql) > MAX_SQL_BYTES)
    throw new Error("SQL exceeds the 100 KB limit");
  const masked = maskSql(sql);
  const trimmed = masked.trim().replace(/;\s*$/, "");
  if (!/^(select|with|values)\b/i.test(trimmed))
    throw new Error("Only SELECT queries are allowed");
  if (trimmed.includes(";"))
    throw new Error("Exactly one SQL statement is allowed");
  const forbidden =
    /\b(insert|update|delete|merge|create|alter|drop|truncate|copy|call|do|grant|revoke|set|reset|vacuum|analyze|refresh|lock|listen|notify|prepare|execute|deallocate|discard|reindex|cluster|load|into|attach|detach|pragma|begin|commit|rollback|savepoint|release)\b/i;
  if (forbidden.test(trimmed))
    throw new Error("SQL contains a forbidden operation");
  if (
    /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|dblink|pg_sleep|set_config|load_extension|readfile|writefile|edit|fts3_tokenizer|pragma_[a-z0-9_]+)\s*\(/i.test(
      trimmed,
    )
  ) {
    throw new Error("SQL contains a forbidden function");
  }
  if (
    /\b(pg_catalog|information_schema|public|sqlite_master|sqlite_schema|sqlite_temp_master|sqlite_temp_schema)\s*\./i.test(
      trimmed,
    )
  ) {
    throw new Error("Only approved analysis datasets may be queried");
  }
  if (!Array.isArray(datasetIds) || datasetIds.length === 0) {
    throw new Error("At least one approved dataset must be declared");
  }
  const cteNames = new Set(
    [
      ...trimmed.matchAll(/(?:\bwith\b|,)\s*([a-z_][a-z0-9_]*)\s+as\s*\(/gi),
      // Group 1 is mandatory in both patterns, so it is always a string.
    ].map((match) => (match[1] ?? "").toLowerCase()),
  );
  const relations = [
    ...trimmed.matchAll(
      /\b(?:from|join)\s+((?:"[^"]+"|[a-z_][a-z0-9_]*)(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_]*))?)/gi,
    ),
  ].map((match) =>
    (match[1] ?? "").replace(/"/g, "").replace(/\s/g, "").toLowerCase(),
  );
  for (const relation of relations) {
    if (cteNames.has(relation)) continue;
    if (!APPROVED_ANALYSIS_RELATIONS.has(relation)) {
      throw new Error(
        `Relation is not an approved analysis dataset: ${relation}`,
      );
    }
  }
  const unknownDataset = datasetIds.find(
    (id) => !Object.hasOwn(RELATIONS_BY_DATASET, id),
  );
  if (unknownDataset) {
    throw new Error(`Dataset is not approved: ${unknownDataset}`);
  }
  const expected = new Set(
    datasetIds.flatMap((id) => RELATIONS_BY_DATASET[id] ?? []),
  );
  if (
    relations.some(
      (relation) => !cteNames.has(relation) && !expected.has(relation),
    )
  ) {
    throw new Error("SQL references a dataset not declared by the analysis");
  }
  return { sql: sql.trim().replace(/;\s*$/, ""), masked };
}

export function __validateAnalysisSql(
  sql: unknown,
  datasetIds: string[] = [],
): string {
  return checkAnalysisSql(sql, datasetIds).sql;
}

/**
 * The views of the declared datasets that the statement names. A view can
 * only be read by naming it, so a view the masked text never mentions is
 * not copied; one named in a comment or a string is not a reference.
 */
function referencedViews(masked: string, datasetIds: string[]): string[] {
  const views = new Set<string>();
  for (const relation of datasetIds.flatMap(
    (id) => RELATIONS_BY_DATASET[id] ?? [],
  )) {
    const view = relation.slice("vision_analysis.".length);
    if (new RegExp(`(?<![A-Za-z0-9_$])${view}(?![A-Za-z0-9_$])`, "i").test(masked))
      views.add(view);
  }
  return [...views];
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function columnKind(column: string, declaredType: string): SandboxKind | null {
  const type = declaredType.trim().toUpperCase();
  if (type === "") return null;
  if (type === "BOOLEAN") return "boolean";
  if (type === "BIGINT") return "bigint";
  if (type.startsWith("DECIMAL_TEXT")) return "decimal";
  if (type === "DATE_TEXT") return "date";
  if (type === "TIMESTAMPTZ_TEXT") return "datetime";
  if (type === "JSON_TEXT" || type === "JSONB_TEXT") return "json";
  if (type === "TEXT_ARRAY")
    return INTEGER_ARRAY_COLUMNS.has(column) ? "integer[]" : "string[]";
  if (type.includes("INT")) return "integer";
  if (type === "REAL") return "decimal";
  // UUID_TEXT, TEXT and anything else the views add later.
  return "string";
}

/**
 * The alias hint that reads a column's stored value unchanged: integers and
 * booleans as exact decimal text (the copy's INTEGER and NUMERIC affinity
 * stores them as integers again), date, timestamp and JSON text as text.
 */
function storedValueHint(declaredType: string): string {
  const type = declaredType.trim().toUpperCase();
  if (type === "BOOLEAN" || type.includes("INT")) return "::bigint";
  if (
    ["DATE_TEXT", "TIMESTAMPTZ_TEXT", "JSON_TEXT", "JSONB_TEXT", "TEXT_ARRAY"].includes(type)
  )
    return "::text";
  return "";
}

async function copyView(client: PgPoolClient, view: string): Promise<SandboxTable> {
  const source = `vision_analysis_${view}`;
  const info = await client.query<{ name: string; type: string }>(
    "SELECT name, type FROM pragma_table_info($1) ORDER BY cid",
    [source],
  );
  if (info.rows.length === 0)
    throw Object.assign(new Error(`Analysis view ${source} is missing`), {
      code: "XX000",
    });
  const computed = COMPUTED_COLUMN_TYPES[view] ?? {};
  const columns: SandboxColumn[] = info.rows.map(({ name, type }) => {
    const declaredType = type || computed[name] || "";
    return { name, declaredType, kind: columnKind(name, declaredType) };
  });
  const list = columns
    .map(
      ({ name, declaredType }) =>
        `${quoteIdent(name)} AS ${quoteIdent(`${name}${storedValueHint(declaredType)}`)}`,
    )
    .join(", ");
  const result = await client.query(`SELECT ${list} FROM ${quoteIdent(source)}`);
  return {
    view,
    columns,
    // The hints give text, integers and floats, and NULL.
    rows: result.rows.map((row) =>
      columns.map(({ name }) => (row[name] ?? null) as SandboxValue),
    ),
  };
}

// ---------------------------------------------------------------------------
// The sandbox slot: one process at a time
// ---------------------------------------------------------------------------

interface Job {
  requestId: string;
  /** Set by cancelAnalysisQuery(). */
  cancelled: Error | null;
  /** While the sandbox runs: fail the request and kill the process. */
  abort: ((error: Error) => void) | null;
}

interface Waiter {
  job: Job;
  grant: () => void;
  refuse: (error: Error) => void;
}

let slotHeld = false;
const waiters: Waiter[] = [];
const jobs = new Map<string, Job>();
const runningSandboxes = new Set<ChildProcess>();
let statementTimeoutMs = STATEMENT_TIMEOUT_MS;

function cancelledError(message: string) {
  return Object.assign(new Error(message), { code: "57014" });
}

const timeoutError = () =>
  cancelledError("canceling statement due to statement timeout");
const userCancelError = () =>
  cancelledError("canceling statement due to user request");

function acquireSlot(job: Job): Promise<void> {
  if (!slotHeld) {
    slotHeld = true;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiter.refuse(
        cancelledError(
          "canceling statement due to statement timeout: another analysis is still running",
        ),
      );
    }, QUEUE_TIMEOUT_MS);
    timer.unref();
    const waiter: Waiter = {
      job,
      grant: () => {
        clearTimeout(timer);
        resolve();
      },
      refuse: (error) => {
        clearTimeout(timer);
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(error);
      },
    };
    waiters.push(waiter);
  });
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) next.grant();
  else slotHeld = false;
}

interface SandboxCommand {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/**
 * How to start the sandbox. A compiled backend (`bun build --compile`) runs
 * the bundled tool beside it as Bun (BUN_BE_BUN=1), as the database tool
 * runs. From source, the same runtime runs analysisSandbox.ts (Node strips
 * the types). The environment holds only the time zone, so SQL today() and
 * now()'s local date agree with the backend's, and nothing names the
 * database file.
 */
function sandboxCommand(): SandboxCommand {
  const env: Record<string, string> = {
    TZ: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  const bunMain = (globalThis as { Bun?: { main?: unknown } }).Bun?.main;
  if (typeof bunMain === "string" && bunMain.startsWith("/$bunfs/")) {
    const tool = path.join(
      path.dirname(process.execPath),
      ...PACKAGED_ANALYSIS_SANDBOX.split("/"),
    );
    return {
      bin: process.execPath,
      args: [tool, SANDBOX_FLAG],
      cwd: path.dirname(tool),
      env: { ...env, BUN_BE_BUN: "1" },
    };
  }
  const source = fileURLToPath(new URL("./analysisSandbox.ts", import.meta.url));
  const args = process.versions.bun
    ? [source, SANDBOX_FLAG]
    : [`--max-old-space-size=${SANDBOX_HEAP_MB}`, "--no-warnings", source, SANDBOX_FLAG];
  return { bin: process.execPath, args, cwd: path.dirname(source), env };
}

type SandboxResultMessage = Extract<SandboxMessage, { kind: "result" }>;

function sandboxFailure(error: Error): Error {
  return Object.assign(
    new Error(`The analysis sandbox failed: ${error.message}`),
    { code: "XX000" },
  );
}

/** The error for a process that ended without an answer. */
function crashError(exitCode: number | null, signal: string | null, stderr: string): Error {
  if (/out of memory/i.test(stderr))
    return Object.assign(new Error("out of memory"), { code: "53200" });
  const how = signal ? `signal ${signal}` : `exit code ${String(exitCode)}`;
  return Object.assign(
    new Error(`The analysis sandbox stopped unexpectedly (${how})`),
    { code: "XX000" },
  );
}

/** Puts back the non-finite numbers JSON could not carry. */
function restoreSpecialNumbers(message: SandboxResultMessage): SandboxResultMessage {
  for (const [index, key, value] of message.special ?? []) {
    const row = message.rows[index];
    if (row) row[key] = Number(value);
  }
  const { special: _special, ...rest } = message;
  return rest;
}

/**
 * Start one sandbox process and stream its JSON-line messages to `onMessage`.
 * `exited` settles when the process has ended.
 */
function spawnSandbox(
  request: SandboxRequest,
  onMessage: (message: SandboxMessage) => void,
  onEnd: (error: Error | null) => void,
): { child: ChildProcess; exited: Promise<void> } {
  const command = sandboxCommand();
  const child = spawn(command.bin, command.args, {
    cwd: command.cwd,
    env: command.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  runningSandboxes.add(child);
  let stdout = "";
  let stderr = "";
  let spawnError: Error | null = null;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    let newline = stdout.indexOf("\n");
    while (newline >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (line.trim() !== "") onMessage(JSON.parse(line) as SandboxMessage);
      newline = stdout.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEEP_BYTES);
  });
  // A process that ends early closes stdin under the request; the exit says why.
  child.stdin.on("error", () => undefined);
  child.on("error", (error: Error) => {
    spawnError = error;
  });
  const exited = new Promise<void>((resolve) => {
    child.once("close", (exitCode: number | null, signal: string | null) => {
      runningSandboxes.delete(child);
      onEnd(spawnError ? sandboxFailure(spawnError) : crashError(exitCode, signal, stderr));
      resolve();
    });
  });
  child.stdin.end(encodeRequest(request));
  return { child, exited };
}

/** Test hook: run the sandbox directly, without the executor's SQL checks. */
export function __runSandbox(request: SandboxRequest): Promise<SandboxMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: SandboxMessage[] = [];
    spawnSandbox(
      request,
      (message) => messages.push(message),
      (error) => {
        if (messages.length === 0 && error) reject(error);
        else resolve(messages);
      },
    );
  });
}

function startSandbox(
  job: Job,
  request: SandboxRequest,
): { result: Promise<SandboxResultMessage>; exited: Promise<void> } {
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let child: ChildProcess | null = null;
  let resolveResult!: (message: SandboxResultMessage) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<SandboxResultMessage>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const settle = () => {
    settled = true;
    clearTimeout(timer);
    job.abort = null;
  };
  const stop = (error: Error) => {
    if (settled) return;
    settle();
    rejectResult(error);
    child?.kill("SIGKILL");
  };
  const started = spawnSandbox(
    request,
    (message) => {
      if (settled) return;
      if (message.kind === "ready") {
        clearTimeout(timer);
        timer = setTimeout(
          () => stop(timeoutError()),
          request.statementTimeoutMs + TERMINATE_GRACE_MS,
        );
        return;
      }
      settle();
      if (message.kind === "result") resolveResult(restoreSpecialNumbers(message));
      else
        rejectResult(
          Object.assign(
            new Error(message.message),
            message.code ? { code: message.code } : {},
          ),
        );
      child?.kill("SIGKILL");
    },
    (error) => {
      if (error) stop(error);
    },
  );
  child = started.child;
  timer = setTimeout(() => {
    stop(
      cancelledError(
        "canceling statement due to statement timeout: loading the analysis data took too long",
      ),
    );
  }, LOAD_TIMEOUT_MS);
  job.abort = stop;
  return { result, exited: started.exited };
}

/** Test hook: a shorter statement limit, or null for the 5 s default. */
export function __setAnalysisStatementTimeout(ms: number | null): void {
  statementTimeoutMs = ms ?? STATEMENT_TIMEOUT_MS;
}

function checkParameters(values: unknown): SandboxValue[] {
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
  // Booleans bind as 1/0, the form SQLite stores them in.
  return values.map((value) => toSqlParam(value) as SandboxValue);
}

export async function executeAnalysisSql({
  requestId,
  sql,
  values = [],
  datasetIds = [],
  limit = DEFAULT_ROWS,
  offset = 0,
}: AnalysisSqlRequest): Promise<AnalysisSqlResult> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId || ""))
    throw new Error("A valid request ID is required");
  // Validated non-empty above; `|| ""` only narrows the type.
  const activeId = requestId || "";
  const params = checkParameters(values);
  const checked = checkAnalysisSql(sql, datasetIds);
  const views = referencedViews(checked.masked, datasetIds);
  const pageLimit = Math.min(
    Math.max(nonZeroOr(limit, DEFAULT_ROWS), 1),
    MAX_ROWS,
  );
  const pageOffset = Math.max(nanToZero(offset), 0);
  const job: Job = { requestId: activeId, cancelled: null, abort: null };
  jobs.set(activeId, job);
  let exited: Promise<void> | null = null;
  try {
    await acquireSlot(job);
  } catch (error) {
    if (jobs.get(activeId) === job) jobs.delete(activeId);
    throw error;
  }
  try {
    const startedAt = new Date().toISOString();
    const tables = await withReadSnapshot(async (client) => {
      const copies: SandboxTable[] = [];
      for (const view of views) copies.push(await copyView(client, view));
      return copies;
    });
    if (job.cancelled) throw job.cancelled;
    const sandbox = startSandbox(job, {
      sql: checked.sql,
      params,
      limit: pageLimit,
      offset: pageOffset,
      statementTimeoutMs,
      startedAt,
      tables,
    });
    exited = sandbox.exited;
    const result = await sandbox.result;
    const rows = result.rows;
    let byteLength = Buffer.byteLength(JSON.stringify(rows));
    let byteTruncated = false;
    while (rows.length > 0 && byteLength > MAX_RESULT_BYTES) {
      rows.pop();
      byteTruncated = true;
      byteLength = Buffer.byteLength(JSON.stringify(rows));
    }
    return {
      requestId,
      startedAt,
      completedAt: new Date().toISOString(),
      executor: EXECUTOR,
      rows,
      columns: result.columns,
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
            hasMore: result.hasMore,
            returnedRows: rows.length,
          },
      byteLength,
    };
  } finally {
    if (jobs.get(activeId) === job) jobs.delete(activeId);
    // The slot frees when the process has ended, so two sandboxes never run at once.
    if (exited) void exited.then(releaseSlot);
    else releaseSlot();
  }
}

export function cancelAnalysisQuery(
  requestId: string,
): Promise<{ cancelled: boolean; reason?: string }> {
  const job = jobs.get(requestId);
  if (!job) return Promise.resolve({ cancelled: false, reason: "not-running" });
  const error = userCancelError();
  job.cancelled = error;
  const waiter = waiters.find((entry) => entry.job === job);
  if (waiter) waiter.refuse(error);
  job.abort?.(error);
  return Promise.resolve({ cancelled: true });
}

/** Cancel queued and running analyses and wait (up to 1 s) for the sandbox to end. */
export async function closeAnalysisPool() {
  for (const waiter of [...waiters]) waiter.refuse(userCancelError());
  for (const job of jobs.values()) {
    // A job still copying its views stops before it starts a sandbox.
    job.cancelled = userCancelError();
    job.abort?.(job.cancelled);
  }
  const ended = Promise.all(
    [...runningSandboxes].map(
      (child) =>
        new Promise<void>((resolve) => {
          child.once("close", () => resolve());
          child.kill("SIGKILL");
        }),
    ),
  );
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    ended,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 1_000);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
}
