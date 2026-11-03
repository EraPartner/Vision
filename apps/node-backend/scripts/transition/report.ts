/**
 * The transition report: a JSON file with everything the run checked, and
 * the short summary printed on stdout.
 */
import path from "node:path";
import type { DecimalTotal, Failure, CheckResult, TableVerification } from "./verify.ts";
import { writeNewFile, sha256Text } from "./files.ts";
import { TYPE_MAPPING } from "./typeMapping.ts";

export const REPORT_FORMAT = 1;

export type RunMode = "install" | "dry-run" | "to-backup" | "output";
export type RunStatus = "installed" | "verified" | "backup-written" | "database-written" | "failed";

export interface TransitionReport {
  reportFormat: typeof REPORT_FORMAT;
  tool: "vision-v2-to-sqlite";
  toolVersion: string;
  mode: RunMode;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  timingsMs: Record<string, number>;
  environment: { runtime: string; platform: string; sqliteVersion: string | null };
  input: { file: string; bytes: number; sha256: string; encrypted: boolean | null; unchangedAfterRun: boolean | null };
  bundle: {
    metadata: Readonly<Record<string, unknown>> | null;
    dumpSha256: string | null;
    dumpBytes: number | null;
    postgresVersion: string | null;
    pgDumpVersion: string | null;
    migrationLedger: string[];
    frontendStateKeys: number | null;
  };
  target: {
    schemaVersion: number | null;
    migrations: string[];
    schemaFingerprint: string | null;
    databaseSha256: string | null;
    databaseBytes: number | null;
  };
  typeMapping: Array<{ sqlite: string; postgres: string; storage: string; conversion: string }>;
  tables: Array<
    TableVerification & { columns: number; replacedReferenceRows: number; notes: Record<string, number> }
  >;
  totals: { tables: number; rows: number; values: number };
  decimalTotals: DecimalTotal[];
  sequences: Array<{ sequence: string; target: string; expected: string; actual: string | null; ok: boolean }>;
  skippedDumpTables: Array<{ name: string; rows: number; reason: string }>;
  droppedGeneratedColumns: Array<{ name: string; reason: string }>;
  tablesNotFromDump: Array<{ name: string; reason: string }>;
  attachments: {
    files: number;
    bytes: number;
    rows: number;
    sha256: Record<string, string>;
    copied: number | null;
    alreadyPresent: number | null;
    destination: string | null;
  };
  customSqlAnalyses: Array<{ savedAnalysisId: string; version: number }>;
  checks: CheckResult[];
  warnings: string[];
  failures: Failure[];
  error: string | null;
  output: {
    database: string | null;
    record: string | null;
    transitionSource: string | null;
    backup: string | null;
    backupSha256: string | null;
    backupEncrypted: boolean | null;
    backupFormat: number | null;
  };
  notVerifiable: string[];
}

export function emptyReport(toolVersion: string, mode: RunMode, startedAt: Date, file: string): TransitionReport {
  return {
    reportFormat: REPORT_FORMAT,
    tool: "vision-v2-to-sqlite",
    toolVersion,
    mode,
    status: "failed",
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    timingsMs: {},
    environment: {
      runtime: typeof process.versions.bun === "string" ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
      platform: `${process.platform} ${process.arch}`,
      sqliteVersion: null,
    },
    input: { file, bytes: 0, sha256: "", encrypted: null, unchangedAfterRun: null },
    bundle: {
      metadata: null,
      dumpSha256: null,
      dumpBytes: null,
      postgresVersion: null,
      pgDumpVersion: null,
      migrationLedger: [],
      frontendStateKeys: null,
    },
    target: { schemaVersion: null, migrations: [], schemaFingerprint: null, databaseSha256: null, databaseBytes: null },
    typeMapping: TYPE_MAPPING.map((r) => ({ sqlite: r.sqlite, postgres: r.postgres, storage: r.storage, conversion: r.conversion })),
    tables: [],
    totals: { tables: 0, rows: 0, values: 0 },
    decimalTotals: [],
    sequences: [],
    skippedDumpTables: [],
    droppedGeneratedColumns: [],
    tablesNotFromDump: [],
    attachments: { files: 0, bytes: 0, rows: 0, sha256: {}, copied: null, alreadyPresent: null, destination: null },
    customSqlAnalyses: [],
    checks: [],
    warnings: [],
    failures: [],
    error: null,
    output: {
      database: null,
      record: null,
      transitionSource: null,
      backup: null,
      backupSha256: null,
      backupEncrypted: null,
      backupFormat: null,
    },
    notVerifiable: [],
  };
}

/**
 * What the run cannot prove from the backup alone. Printed on every
 * successful run and stored in the report.
 */
export function notVerifiableStatement(report: TransitionReport): string[] {
  const lines = [
    "The checks prove that the new database holds exactly the rows and values of this backup's PostgreSQL dump " +
      "(every value compared, exact money totals, checksums, schema identical to a fresh install). They cannot prove:",
    "- that this backup is your latest data: anything entered in Vision 2.0 after the backup was made is not in it;",
    "- that Vision behaves the same on your data: screens, reports and imports run new SQLite queries, so open the " +
      "main pages (accounts, transactions, budget, portfolio) and compare a few balances and totals with Vision 2.0 " +
      "or with the totals in this report;",
    "- the summary tables mv_monthly_summary and mv_category_totals, which are rebuilt by Vision when it starts, not " +
      "copied;",
    "- real (float4) columns: SQLite stores them as double precision; the stored number is exactly the value Vision " +
      "2.0 displayed, but arithmetic on it is now done in double precision;",
    "- enum ordering: SQLite orders enum values as text, not in their declared order (only matters where a screen " +
      "sorts by such a column without an explicit order).",
  ];
  if (report.customSqlAnalyses.length > 0) {
    lines.push(
      `- your ${report.customSqlAnalyses.length} saved custom-SQL analysis version(s) were written for PostgreSQL ` +
        "and are copied as text, not run: open each saved custom-SQL analysis once and check that it still runs.",
    );
  }
  if (report.bundle.frontendStateKeys !== null && report.mode !== "to-backup") {
    lines.push(
      `- the ${report.bundle.frontendStateKeys} browser-storage preference(s) in frontend-state.json (theme, last ` +
        "page, ...) live in the app's renderer storage, which this script cannot write; Vision starts with defaults " +
        "for them (use --to-backup and restore that bundle in Vision to keep them).",
    );
  }
  if (report.warnings.length > 0) lines.push("- the warnings listed above, which the checks report but cannot resolve.");
  return lines;
}

export async function writeReport(file: string, report: TransitionReport): Promise<{ file: string; sha256: string }> {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  await writeNewFile(file, text);
  return { file: path.resolve(file), sha256: sha256Text(text) };
}

export function reportFileName(at: Date): string {
  return `transition-report-${at.toISOString().replace(/[:.]/g, "-")}.json`;
}

function money(total: DecimalTotal): string {
  return `${total.table}.${total.column}: ${total.dump.count} values, sum ${total.dump.sum ?? "-"}`;
}

/** The short human summary. */
export function summary(report: TransitionReport, reportPath: string | null): string[] {
  const lines: string[] = [];
  const ok = report.status !== "failed";
  lines.push("");
  lines.push(ok ? "Vision 2.0 -> SQLite transition: all checks passed." : "Vision 2.0 -> SQLite transition FAILED.");
  lines.push(`  input       ${report.input.file}`);
  lines.push(`              SHA-256 ${report.input.sha256}${report.input.encrypted === true ? " (encrypted)" : ""}`);
  if (report.bundle.metadata !== null) {
    const m = report.bundle.metadata;
    lines.push(`  backup      made by Vision ${String(m.appVersion)} on ${String(m.createdAt)}, schema ${String(m.schemaHead)}`);
  }
  if (report.totals.tables > 0) {
    lines.push(
      `  converted   ${report.totals.rows.toLocaleString("en-US")} rows in ${report.totals.tables} tables, ` +
        `${report.totals.values.toLocaleString("en-US")} values compared one by one`,
    );
    const largest = [...report.decimalTotals]
      .filter((t) => t.dump.count > 0)
      .sort((a, b) => b.dump.count - a.dump.count)
      .slice(0, 3);
    for (const t of largest) lines.push(`  money       ${money(t)} (exact)`);
    lines.push(`  attachments ${report.attachments.files} files, ${report.attachments.bytes.toLocaleString("en-US")} bytes`);
  }
  for (const check of report.checks) lines.push(`  ${check.ok ? "ok  " : "FAIL"}        ${check.name}`);
  for (const warning of report.warnings) lines.push(`  warning     ${warning}`);
  if (!ok) {
    for (const failure of report.failures.slice(0, 10)) {
      const where = [failure.table, failure.column].filter((x) => x !== undefined).join(".");
      lines.push(`  failure     ${failure.message}`);
      if (where !== "" || failure.rowKey !== undefined) {
        lines.push(`              at ${where}${failure.rowKey !== undefined ? ` row ${failure.rowKey}` : ""}`);
      }
      if (failure.dumpValue !== undefined) lines.push(`              dump value   ${failure.dumpValue}`);
      if (failure.storedValue !== undefined) lines.push(`              stored value ${failure.storedValue}`);
    }
    if (report.failures.length > 10) lines.push(`  ... ${report.failures.length - 10} more failures in the report`);
  } else {
    if (report.output.database !== null) lines.push(`  database    ${report.output.database}`);
    if (report.output.transitionSource !== null) lines.push(`  source copy ${report.output.transitionSource}`);
    if (report.attachments.destination !== null) lines.push(`  attachments ${report.attachments.destination}`);
    if (report.output.backup !== null) {
      lines.push(
        `  backup      ${report.output.backup} (bundle format ${String(report.output.backupFormat)}` +
          `${report.output.backupEncrypted === true ? ", encrypted with the same passphrase" : ""})`,
      );
    }
    lines.push("");
    lines.push(...report.notVerifiable);
  }
  lines.push("");
  lines.push(`Report: ${reportPath ?? "(not written)"}`);
  return lines;
}
