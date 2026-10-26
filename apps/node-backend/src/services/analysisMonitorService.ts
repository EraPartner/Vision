/** Local-only deterministic monitor checks and durable in-app inbox. */

import { createHash, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { z } from "zod";
import type { AnalysisDefinition } from "@vision/types/analysis";
import { sql } from "kysely";
import { withTransaction } from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import type { Json } from "../database/schema.generated.ts";
import {
  analysisMonitorRowSchema,
  analysisMonitorWithObservationRowSchema,
  countNRowSchema,
  monitorDossierRowSchema,
  monitorDossierTargetRowSchema,
  monitorNotificationCountsRowSchema,
  monitorNotificationRowSchema,
  monitorObservationRowSchema,
  monitorRunRowSchema,
  monitorSavedAnalysisTargetRowSchema,
  refreshModeRowSchema,
  runStatusRowSchema,
  savedAnalysisDefinitionRowSchema,
  textIdRowSchema,
} from "../database/rows/analysis.ts";
import type {
  AnalysisMonitorRow,
  MonitorNotificationRow,
  MonitorObservationJson,
  MonitorObservationRow,
  MonitorRunRow,
} from "../database/rows/analysis.ts";
import { monitorRunIdOf, runSavedAnalysis } from "./savedAnalysisService.ts";
import { valueText } from "./valueText.ts";
import { errorMessage } from "../lib/errors.ts";
import { isRecord } from "../lib/typeGuards.ts";

/** A stored observation, or the latest one as `MONITOR_SELECT` embeds it. */
type ObservationRow = MonitorObservationRow | MonitorObservationJson;
type MonitorRow = AnalysisMonitorRow & {
  /** Present on MONITOR_SELECT rows: the latest observation as JSON. */
  last_observation?: MonitorObservationJson | null;
};
type NotificationRow = MonitorNotificationRow;
type MonitorTargetRow = {
  id: string;
  name?: string;
  title?: string;
  refresh_mode?: string;
};

interface MonitorFinding {
  status: string;
  reasonCode?: string;
  reason?: string;
  value?: string;
  definitionVersion?: number;
  evidenceHash?: string;
  evidenceVersion?: number;
  runId?: string | null;
  runStatus?: string | null;
  runWindow?: unknown;
}

type PageInput = { limit?: unknown; offset?: unknown };

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const uuid = z.uuid();
const decimalString = z
  .string()
  .max(100)
  .regex(DECIMAL)
  .refine((value) => new Decimal(value).isFinite());
const common = {
  title: z.string().trim().min(1).max(200),
  intervalMinutes: z.number().int().min(15).max(10080).default(1440),
  cooldownMinutes: z.number().int().min(0).max(10080).default(1440),
};
const intervalMinutes = z.number().int().min(15).max(10080);
const cooldownMinutes = z.number().int().min(0).max(10080);
const createSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("analysis-threshold"),
      savedAnalysisId: uuid,
      fieldId: z.string().min(1).max(100),
      operator: z.enum(["above", "below"]),
      threshold: decimalString,
      ...common,
    })
    .strict(),
  z
    .object({
      kind: z.literal("dossier-evidence"),
      dossierId: uuid,
      ...common,
    })
    .strict(),
]);
const patchSchema = z
  .object({
    title: common.title.optional(),
    enabled: z.boolean().optional(),
    fieldId: z.string().min(1).max(100).optional(),
    operator: z.enum(["above", "below"]).optional(),
    threshold: decimalString.optional(),
    intervalMinutes: intervalMinutes.optional(),
    cooldownMinutes: cooldownMinutes.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "No changes supplied");

const COVERAGE = {
  status: "unknown",
  reason: "The local result has no verified source-coverage proof.",
};
const LEASE_MINUTES = 3;
const MAX_DUE_PER_TICK = 4;

function fail(
  message: string,
  status = 400,
  code = "INVALID_MONITOR_REQUEST",
): never {
  throw Object.assign(new Error(message), { status, code });
}

function parsed<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success)
    fail(result.error.issues[0]?.message ?? "Invalid monitor input");
  return result.data;
}

function monitorId(id: string) {
  return parsed(uuid, id);
}

function page(input: PageInput = {}) {
  const limit = input.limit === undefined ? 50 : Number(input.limit);
  const offset = input.offset === undefined ? 0 : Number(input.offset);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 1_000_000
  )
    fail("Invalid pagination");
  return { limit, offset };
}

function mapMonitor(row: MonitorRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    enabled: row.enabled,
    savedAnalysisId: row.saved_analysis_id,
    dossierId: row.dossier_id,
    historicalTargetId: row.historical_target_id,
    targetLabel: row.target_label,
    targetAvailable:
      row.kind === "analysis-threshold"
        ? row.saved_analysis_id !== null
        : row.dossier_id !== null,
    fieldId: row.field_id,
    operator: row.operator,
    threshold: row.threshold,
    intervalMinutes: row.interval_minutes,
    cooldownMinutes: row.cooldown_minutes,
    nextDueAt: row.next_due_at,
    lastCheckedAt: row.last_checked_at,
    lastStatus: row.last_status,
    // Widened so callers can replace the raw row with its mapped form.
    lastObservation: (row.last_observation ?? null) as
      ObservationRow | MonitorObservation | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type MonitorObservation = ReturnType<typeof mapObservation>;

function mapObservation(row: ObservationRow) {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    status: row.status,
    previousValue: row.previous_value,
    currentValue: row.current_value,
    previousEvidenceVersion: row.previous_evidence_version,
    currentEvidenceVersion: row.current_evidence_version,
    analysisDefinitionVersion: row.analysis_definition_version,
    analysisRunId: row.analysis_run_id,
    historicalAnalysisRunId: row.historical_analysis_run_id,
    analysisRunStatus: row.analysis_run_status,
    analysisWindow: row.analysis_window_json,
    coverage: row.coverage_json,
    reasonCode: row.reason_code,
    reason: row.reason,
    checkedAt: row.checked_at,
  };
}

function mapNotification(row: NotificationRow) {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    observationId: row.observation_id,
    kind: row.kind,
    title: row.title,
    reasonCode: row.reason_code,
    reason: row.reason,
    previousValue: row.previous_value,
    currentValue: row.current_value,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

function selectMonitors() {
  return db
    .selectFrom("analysis_monitors as m")
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom("analysis_monitor_observations")
          .select([
            "id",
            "monitor_id",
            "status",
            "previous_value",
            "current_value",
            "previous_evidence_version",
            "current_evidence_version",
            "analysis_definition_version",
            "analysis_run_id",
            "historical_analysis_run_id",
            "analysis_run_status",
            "analysis_window_json",
            "coverage_json",
            "reason_code",
            "reason",
            "checked_at",
          ])
          .whereRef("monitor_id", "=", "m.id")
          .orderBy("checked_at", "desc")
          .orderBy("id", "desc")
          .limit(1)
          .as("o"),
      (join) => join.onTrue(),
    )
    .selectAll("m")
    .select(
      sql<MonitorObservationJson | null>`row_to_json(o.*)`.as(
        "last_observation",
      ),
    );
}

function lockMonitor(id: string) {
  return db
    .selectFrom("analysis_monitors")
    .selectAll()
    .where("id", "=", id)
    .forUpdate();
}

function savedDefinition(savedAnalysisId: string | null) {
  return db
    .selectFrom("saved_analyses as a")
    .innerJoin("saved_analysis_definition_versions as v", (join) =>
      join
        .onRef("v.saved_analysis_id", "=", "a.id")
        .onRef("v.version", "=", "a.current_version"),
    )
    .select("v.definition_json")
    .where("a.id", "=", savedAnalysisId);
}

function addMinutes(minutes: number) {
  return sql<Date>`now()+(${String(minutes)} || ' minutes')::interval`;
}

async function getMonitor(id: string) {
  monitorId(id);
  const row = await checkedRow(
    analysisMonitorWithObservationRowSchema,
    selectMonitors().where("m.id", "=", id),
  );
  if (!row) fail("Monitor not found", 404, "MONITOR_NOT_FOUND");
  const monitor = mapMonitor(row);
  if (row.last_observation)
    monitor.lastObservation = mapObservation(row.last_observation);
  return monitor;
}

export async function listAnalysisMonitors(input?: PageInput) {
  const { limit, offset } = page(input);
  const rows = await checkedRows(
    analysisMonitorWithObservationRowSchema,
    selectMonitors()
      .orderBy("m.created_at", "desc")
      .orderBy("m.id", "desc")
      .limit(limit)
      .offset(offset),
  );
  const total = Number(
    (
      await checkedRow(
        countNRowSchema,
        db
          .selectFrom("analysis_monitors")
          .select(sql<string>`count(*)`.as("n")),
      )
    )?.n,
  );
  return {
    items: rows.map((row) => {
      const item = mapMonitor(row);
      if (row.last_observation)
        item.lastObservation = mapObservation(row.last_observation);
      return item;
    }),
    total,
    limit,
    offset,
  };
}

export async function createAnalysisMonitor(input: unknown) {
  const value = parsed(createSchema, input);
  const target: MonitorTargetRow | undefined =
    value.kind === "analysis-threshold"
      ? await checkedRow(
          monitorSavedAnalysisTargetRowSchema,
          db
            .selectFrom("saved_analyses")
            .select(["id", "name", "refresh_mode"])
            .where("id", "=", value.savedAnalysisId),
        )
      : await checkedRow(
          monitorDossierTargetRowSchema,
          db
            .selectFrom("research_dossiers")
            .select(["id", "title"])
            .where("id", "=", value.dossierId),
        );
  if (!target)
    fail("Monitor target not found", 404, "MONITOR_TARGET_NOT_FOUND");
  if (target.refresh_mode === "frozen")
    fail("Frozen saved analyses cannot be monitored");
  if (value.kind === "analysis-threshold") {
    const definition = (
      await checkedRow(
        savedAnalysisDefinitionRowSchema,
        savedDefinition(target.id),
      )
    )?.definition_json;
    if (!declaresNumericColumn(definition, value.fieldId))
      fail("Field must be a declared numeric result column");
  }
  const id = randomUUID();
  await db
    .insertInto("analysis_monitors")
    .values({
      id,
      kind: value.kind,
      title: value.title,
      saved_analysis_id: value.kind === "analysis-threshold" ? target.id : null,
      dossier_id: value.kind === "dossier-evidence" ? target.id : null,
      historical_target_id: target.id,
      target_label: sql<string>`${target.name ?? target.title}`,
      field_id: value.kind === "analysis-threshold" ? value.fieldId : null,
      operator: value.kind === "analysis-threshold" ? value.operator : null,
      threshold: sql<string | null>`${
        value.kind === "analysis-threshold" ? value.threshold : null
      }::numeric`,
      interval_minutes: value.intervalMinutes,
      cooldown_minutes: value.cooldownMinutes,
    })
    .execute();
  return getMonitor(id);
}

export async function patchAnalysisMonitor(id: string, input: unknown) {
  monitorId(id);
  const value = parsed(patchSchema, input);
  await withTransaction(async () => {
    const current = await checkedRow(analysisMonitorRowSchema, lockMonitor(id));
    if (!current) fail("Monitor not found", 404, "MONITOR_NOT_FOUND");
    if (
      current.lease_expires_at &&
      new Date(current.lease_expires_at).getTime() > Date.now()
    )
      fail(
        "Monitor is running; retry the edit after this check",
        409,
        "MONITOR_BUSY",
      );
    if (
      current.kind !== "analysis-threshold" &&
      (value.fieldId !== undefined ||
        value.operator !== undefined ||
        value.threshold !== undefined)
    )
      fail("Evidence monitors have no numeric condition");
    if (value.fieldId !== undefined && current.kind === "analysis-threshold") {
      const definition: AnalysisDefinition | undefined = (
        await checkedRow(
          savedAnalysisDefinitionRowSchema,
          savedDefinition(current.saved_analysis_id),
        )
      )?.definition_json;
      if (!declaresNumericColumn(definition, value.fieldId))
        fail("Field must be a declared numeric result column");
    }
    const conditionChanged =
      value.fieldId !== undefined ||
      value.operator !== undefined ||
      value.threshold !== undefined;
    const changed = sql<boolean>`${conditionChanged}::boolean`;
    const enabling = sql<boolean>`${value.enabled === true}::boolean`;
    await db
      .updateTable("analysis_monitors")
      .set({
        title: value.title ?? current.title,
        enabled: value.enabled ?? current.enabled,
        field_id: value.fieldId ?? current.field_id,
        operator: value.operator ?? current.operator,
        threshold: sql<
          string | null
        >`${value.threshold ?? current.threshold}::numeric`,
        interval_minutes: value.intervalMinutes ?? current.interval_minutes,
        cooldown_minutes: value.cooldownMinutes ?? current.cooldown_minutes,
        next_due_at: sql<Date>`CASE WHEN ${changed} OR (${enabling} AND NOT enabled) THEN now() ELSE next_due_at END`,
        active_episode_key: sql<
          string | null
        >`CASE WHEN ${changed} THEN NULL ELSE active_episode_key END`,
        pending_signature: sql<
          string | null
        >`CASE WHEN ${changed} THEN NULL ELSE pending_signature END`,
        pending_since: sql<Date | null>`CASE WHEN ${changed} THEN NULL ELSE pending_since END`,
        condition_revision: sql<number>`condition_revision+CASE WHEN ${changed} THEN 1 ELSE 0 END`,
        updated_at: sql<Date>`now()`,
      })
      .where("id", "=", id)
      .execute();
  });
  return getMonitor(id);
}

export async function deleteAnalysisMonitor(id: string) {
  monitorId(id);
  if (
    (
      await db
        .deleteFrom("analysis_monitors")
        .where("id", "=", id)
        .executeTakeFirst()
    ).numDeletedRows === 0n
  )
    fail("Monitor not found", 404, "MONITOR_NOT_FOUND");
}

export async function listMonitorObservations(id: string, input?: PageInput) {
  monitorId(id);
  await getMonitor(id);
  const { limit, offset } = page(input);
  const rows = await checkedRows(
    monitorObservationRowSchema,
    db
      .selectFrom("analysis_monitor_observations")
      .selectAll()
      .where("monitor_id", "=", id)
      .orderBy("checked_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .offset(offset),
  );
  const total = Number(
    (
      await checkedRow(
        countNRowSchema,
        db
          .selectFrom("analysis_monitor_observations")
          .select(sql<string>`count(*)`.as("n"))
          .where("monitor_id", "=", id),
      )
    )?.n,
  );
  return { items: rows.map(mapObservation), total, limit, offset };
}

export async function listMonitorNotifications(input?: PageInput) {
  const { limit, offset } = page(input);
  const rows = await checkedRows(
    monitorNotificationRowSchema,
    db
      .selectFrom("analysis_monitor_notifications")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .offset(offset),
  );
  const counts = await checkedRow(
    monitorNotificationCountsRowSchema,
    db
      .selectFrom("analysis_monitor_notifications")
      .select([
        sql<string>`count(*)`.as("total"),
        sql<string>`count(*) FILTER (WHERE read_at IS NULL)`.as("unread"),
      ]),
  );
  return {
    items: rows.map(mapNotification),
    total: Number(counts?.total),
    unreadCount: Number(counts?.unread),
    limit,
    offset,
  };
}

export async function readMonitorNotification(id: string) {
  monitorId(id);
  const row = await checkedRow(
    monitorNotificationRowSchema,
    db
      .updateTable("analysis_monitor_notifications")
      .set({ read_at: sql<Date>`coalesce(read_at,now())` })
      .where("id", "=", id)
      .returningAll(),
  );
  if (!row)
    fail("Notification not found", 404, "MONITOR_NOTIFICATION_NOT_FOUND");
  return mapNotification(row);
}

function evaluateThreshold({
  previousValue,
  currentValue,
  operator,
  threshold,
}: {
  previousValue: string | null;
  currentValue: string;
  operator: string | null;
  threshold: string;
}) {
  const current = new Decimal(currentValue);
  const boundary = new Decimal(threshold);
  const met =
    operator === "above"
      ? current.greaterThan(boundary)
      : current.lessThan(boundary);
  const previousMet =
    previousValue === null
      ? null
      : operator === "above"
        ? new Decimal(previousValue).greaterThan(boundary)
        : new Decimal(previousValue).lessThan(boundary);
  return { met, crossed: previousMet === false && met };
}

/** Stored definitions are JSON; one may not declare its result columns. */
interface StoredResultColumns {
  expectedResult?:
    | { columns?: ReadonlyArray<{ id: string; type: string }> | undefined }
    | undefined;
}

function declaresNumericColumn(
  definition: StoredResultColumns | null | undefined,
  fieldId: string | null,
): boolean {
  return (
    definition?.expectedResult?.columns?.some(
      (column) =>
        column.id === fieldId &&
        ["decimal", "number", "integer", "currency"].includes(column.type),
    ) ?? false
  );
}

/** `String(evidence?.id)` for an untyped evidence entry. */
function evidenceId(entry: unknown): string {
  return valueText(
    typeof entry === "object" && entry !== null
      ? Reflect.get(entry, "id")
      : undefined,
  );
}

function evidenceHash(evidence: unknown[]) {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (isRecord(value)) {
      const record = value;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, canonical(record[key])]),
      );
    }
    return value;
  };
  const sorted = [...evidence].sort((a, b) =>
    evidenceId(a).localeCompare(evidenceId(b)),
  );
  return createHash("sha256")
    .update(JSON.stringify(canonical(sorted)))
    .digest("hex");
}

function finiteResultValue(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const str = String(value);
  if (!DECIMAL.test(str)) return null;
  const decimal = new Decimal(str);
  return decimal.isFinite() ? decimal.toString() : null;
}

async function claimMonitor(id: string, dueOnly: boolean) {
  monitorId(id);
  const token = randomUUID();
  let claim = db
    .updateTable("analysis_monitors")
    .set({ lease_token: token, lease_expires_at: addMinutes(LEASE_MINUTES) })
    .where("id", "=", id)
    .where("enabled", "=", true)
    .where((eb) =>
      eb.or([
        eb("lease_token", "is", null),
        eb("lease_expires_at", "<", sql<Date>`now()`),
      ]),
    );
  if (dueOnly) claim = claim.where("next_due_at", "<=", sql<Date>`now()`);
  const row = await checkedRow(analysisMonitorRowSchema, claim.returningAll());
  if (!row && !dueOnly) {
    const exists =
      (
        await db
          .selectFrom("analysis_monitors")
          .select("id")
          .where("id", "=", id)
          .execute()
      ).length > 0;
    fail(
      exists ? "Monitor is disabled or already running" : "Monitor not found",
      exists ? 409 : 404,
      exists ? "MONITOR_BUSY" : "MONITOR_NOT_FOUND",
    );
  }
  return row ? { row, token } : null;
}

async function inspectAnalysis(row: MonitorRow): Promise<MonitorFinding> {
  if (!row.saved_analysis_id)
    return {
      status: "failed",
      reasonCode: "analysis-deleted",
      reason: "The saved analysis was deleted.",
    };
  const saved = await checkedRow(
    refreshModeRowSchema,
    db
      .selectFrom("saved_analyses")
      .select("refresh_mode")
      .where("id", "=", row.saved_analysis_id),
  );
  if (!saved)
    return {
      status: "failed",
      reasonCode: "analysis-unavailable",
      reason: "The saved analysis is unavailable.",
    };
  if (saved.refresh_mode === "frozen")
    return {
      status: "stale",
      reasonCode: "analysis-frozen",
      reason: "Frozen analyses are not refreshed by monitors.",
    };
  let runId;
  try {
    const response = await runSavedAnalysis(row.saved_analysis_id, {
      includeRunId: true,
    });
    runId = response.runId;
  } catch (caught) {
    // runSavedAnalysis rethrows the execution Error tagged with its run id.
    const monitorRunId = monitorRunIdOf(caught);
    const failedRun = monitorRunId
      ? await checkedRow(
          runStatusRowSchema,
          db
            .selectFrom("saved_analysis_runs")
            .select("status")
            .where("id", "=", monitorRunId),
        )
      : null;
    return {
      status: "failed",
      reasonCode: "analysis-execution-failed",
      reason: `Analysis failed: ${errorMessage(caught)}`.slice(0, 1000),
      runId: monitorRunId ?? null,
      runStatus: failedRun?.status ?? null,
    };
  }
  const run = await checkedRow(
    monitorRunRowSchema,
    db
      .selectFrom("saved_analysis_runs as r")
      .innerJoin("saved_analyses as a", "a.id", "r.saved_analysis_id")
      .innerJoin("saved_analysis_definition_versions as v", (join) =>
        join
          .onRef("v.saved_analysis_id", "=", "a.id")
          .onRef("v.version", "=", "a.current_version"),
      )
      .select([
        "r.id",
        "r.status",
        "r.result_json",
        "r.definition_version",
        "a.current_version",
        "v.definition_json",
      ])
      .where("r.id", "=", runId),
  );
  if (!run)
    return {
      status: "failed",
      reasonCode: "analysis-run-missing",
      reason: "The completed analysis run cannot be found.",
      runId,
    };
  const runMetadata = {
    runId,
    runStatus: run.status,
    runWindow: run.result_json?.window ?? null,
  };
  if (run.definition_version !== run.current_version)
    return {
      status: "stale",
      reasonCode: "analysis-definition-changed",
      reason: "The saved analysis definition changed during this check.",
      ...runMetadata,
    };
  if (!declaresNumericColumn(run.definition_json, row.field_id))
    return {
      status: "stale",
      reasonCode: "analysis-field-changed",
      reason: "The monitored field is no longer a declared numeric column.",
      ...runMetadata,
    };
  return {
    ...classifyMonitorRun(run, row.field_id),
    ...runMetadata,
  };
}

function classifyMonitorRun(
  run: Pick<MonitorRunRow, "status" | "result_json" | "definition_version">,
  fieldId: string | null,
): MonitorFinding {
  if (run.status !== "completed")
    return {
      status: "partial",
      reasonCode: "analysis-run-incomplete",
      reason: `Analysis run status is ${run.status}; it cannot prove the condition.`,
    };
  const result = run.result_json;
  if (
    result?.window?.kind !== "page" ||
    result.window.offset !== 0 ||
    result.window.hasMore !== false ||
    result.window.returnedRows !== 1 ||
    !Array.isArray(result.rows) ||
    result.rows.length !== 1
  )
    return {
      status: "partial",
      reasonCode: "analysis-window-incomplete",
      reason:
        "Analysis result is truncated, incomplete, or not exactly one row.",
    };
  if (Array.isArray(result.formulaErrors) && result.formulaErrors.length > 0)
    return {
      status: "partial",
      reasonCode: "analysis-formula-incomplete",
      reason: "Analysis formulas are incomplete.",
    };
  // Exactly one row (checked above).
  const value = finiteResultValue(result.rows[0]?.[String(fieldId)]);
  if (value === null)
    return {
      status: "partial",
      reasonCode: "analysis-nonnumeric",
      reason: `Field ${fieldId} is not a finite numeric result.`,
    };
  return {
    status: "valid",
    value,
    definitionVersion: run.definition_version,
  };
}

async function inspectDossier(row: MonitorRow): Promise<MonitorFinding> {
  if (!row.dossier_id)
    return {
      status: "failed",
      reasonCode: "dossier-deleted",
      reason: "The research dossier was deleted.",
    };
  const dossier = await checkedRow(
    monitorDossierRowSchema,
    db
      .selectFrom("research_dossiers")
      .select(["version", "content_json"])
      .where("id", "=", row.dossier_id),
  );
  if (!dossier)
    return {
      status: "failed",
      reasonCode: "dossier-unavailable",
      reason: "The research dossier is unavailable.",
    };
  const evidence = dossier.content_json.evidence;
  if (!Array.isArray(evidence))
    return {
      status: "partial",
      reasonCode: "dossier-evidence-invalid",
      reason: "Dossier evidence is not a valid list.",
    };
  return {
    status: "valid",
    evidenceHash: evidenceHash(evidence),
    evidenceVersion: dossier.version,
  };
}

async function finalizeObservation(
  claim: { row: MonitorRow; token: string },
  finding: MonitorFinding,
) {
  const { row, token } = claim;
  return withTransaction(async () => {
    const locked = await checkedRow(
      analysisMonitorRowSchema,
      lockMonitor(row.id),
    );
    if (!locked || locked.lease_token !== token) return null;
    if (locked.condition_revision !== row.condition_revision) {
      await db
        .updateTable("analysis_monitors")
        .set({
          lease_token: null,
          lease_expires_at: null,
          next_due_at: sql<Date>`now()`,
        })
        .where("id", "=", row.id)
        .execute();
      return null;
    }
    const prior =
      (await checkedRow(
        monitorObservationRowSchema,
        db
          .selectFrom("analysis_monitor_observations")
          .selectAll()
          .where("monitor_id", "=", row.id)
          .where("condition_revision", "=", locked.condition_revision)
          .where("status", "in", [
            "baseline",
            "unchanged",
            "triggered",
            "cooldown-pending",
          ])
          .orderBy("checked_at", "desc")
          .orderBy("id", "desc")
          .limit(1),
      )) ?? null;
    const now = new Date();
    let status = finding.status;
    let reasonCode = finding.reasonCode ?? "monitor-check-failed";
    let reason = finding.reason;
    let previousValue = prior?.current_value ?? null;
    const currentValue = finding.value ?? null;
    let previousEvidenceVersion = prior?.current_evidence_version ?? null;
    const currentEvidenceVersion = finding.evidenceVersion ?? null;
    const hash = finding.evidenceHash ?? null;
    let episodeKey = locked.active_episode_key;
    let pendingSignature = locked.pending_signature;
    let pendingSince: Date | null = locked.pending_since;
    let lastNotifiedAt: Date | null = locked.last_notified_at;
    let notify = false;
    if (finding.status === "valid") {
      if (
        !prior ||
        (row.kind === "analysis-threshold" &&
          prior.analysis_definition_version !== finding.definitionVersion)
      ) {
        status = "baseline";
        reasonCode = "baseline";
        reason =
          "First complete local observation; future changes can be compared.";
        previousValue = null;
        previousEvidenceVersion = null;
        episodeKey = null;
        pendingSignature = null;
        pendingSince = null;
      } else if (row.kind === "analysis-threshold") {
        // Valid analysis findings always carry a finite value.
        const validValue = currentValue;
        if (validValue === null)
          throw new Error("A valid analysis finding is missing its value");
        const evaluation = evaluateThreshold({
          previousValue,
          currentValue: validValue,
          operator: row.operator,
          threshold: String(row.threshold),
        });
        if (!evaluation.met) {
          status = "unchanged";
          reasonCode = "threshold-not-met";
          reason = "The threshold condition is not met.";
          episodeKey = null;
          pendingSignature = null;
          pendingSince = null;
        } else if (evaluation.crossed || pendingSignature === "met") {
          if (evaluation.crossed) episodeKey = randomUUID();
          pendingSignature = "met";
          pendingSince ??= now;
          const cool =
            lastNotifiedAt &&
            now.getTime() - new Date(lastNotifiedAt).getTime() <
              row.cooldown_minutes * 60_000;
          status = cool ? "cooldown-pending" : "triggered";
          reasonCode = cool ? "threshold-cooldown" : "threshold-crossed";
          reason = cool
            ? "Threshold crossed; notification pending cooldown."
            : "Threshold crossed the explicit boundary.";
          notify = !cool;
        } else {
          status = "unchanged";
          reasonCode = "threshold-already-met";
          reason =
            "The threshold remains met; its episode was already handled.";
        }
      } else if (hash !== prior.evidence_hash || pendingSignature === hash) {
        if (hash !== prior.evidence_hash) episodeKey = randomUUID();
        pendingSignature = hash;
        pendingSince ??= now;
        const cool =
          lastNotifiedAt &&
          now.getTime() - new Date(lastNotifiedAt).getTime() <
            row.cooldown_minutes * 60_000;
        status = cool ? "cooldown-pending" : "triggered";
        reasonCode = cool ? "evidence-cooldown" : "evidence-changed";
        reason = cool
          ? "Dossier evidence changed; notification pending cooldown."
          : "The dossier evidence set changed.";
        notify = !cool;
      } else {
        status = "unchanged";
        reasonCode = "evidence-unchanged";
        reason = "The dossier evidence set has not changed.";
      }
      if (notify) {
        pendingSignature = null;
        pendingSince = null;
        lastNotifiedAt = now;
      }
    }
    // Every valid branch above sets a reason; other findings carry one.
    if (reason === undefined)
      throw new Error("A monitor finding is missing its reason");
    const id = randomUUID();
    const observation = await checkedRow(
      monitorObservationRowSchema,
      db
        .insertInto("analysis_monitor_observations")
        .values({
          id,
          monitor_id: row.id,
          status,
          previous_value: previousValue,
          current_value: currentValue,
          previous_evidence_version: previousEvidenceVersion,
          current_evidence_version: currentEvidenceVersion,
          evidence_hash: hash,
          condition_revision: locked.condition_revision,
          analysis_definition_version: finding.definitionVersion ?? null,
          analysis_run_id: finding.runId ?? null,
          historical_analysis_run_id: finding.runId ?? null,
          analysis_run_status: finding.runStatus ?? null,
          analysis_window_json: finding.runWindow
            ? sql<Json>`${JSON.stringify(finding.runWindow)}::jsonb`
            : null,
          coverage_json: sql<Json>`${JSON.stringify(COVERAGE)}::jsonb`,
          reason_code: reasonCode,
          reason: reason.slice(0, 1000),
        })
        .returningAll(),
    );
    if (!observation)
      throw new Error("analysis_monitor_observations insert returned no row");
    if (notify) {
      await db
        .insertInto("analysis_monitor_notifications")
        .values({
          monitor_id: row.id,
          observation_id: id,
          kind: row.kind,
          title: row.title,
          reason_code: reasonCode,
          reason: sql<string>`${reason}`,
          previous_value: previousValue,
          current_value: currentValue,
          episode_key: sql<string>`${episodeKey}`,
        })
        .onConflict((oc) =>
          oc.columns(["monitor_id", "episode_key"]).doNothing(),
        )
        .execute();
    }
    await db
      .updateTable("analysis_monitors")
      .set({
        last_checked_at: sql<Date>`now()`,
        last_status: status,
        next_due_at: addMinutes(row.interval_minutes),
        active_episode_key: episodeKey,
        pending_signature: pendingSignature,
        pending_since: pendingSince,
        last_notified_at: lastNotifiedAt,
        lease_token: null,
        lease_expires_at: null,
        updated_at: sql<Date>`now()`,
      })
      .where("id", "=", row.id)
      .execute();
    return mapObservation(observation);
  });
}

export async function checkAnalysisMonitor(
  id: string,
  { dueOnly = false }: { dueOnly?: boolean } = {},
) {
  const claim = await claimMonitor(id, dueOnly);
  if (!claim) return null;
  let finding: MonitorFinding;
  try {
    finding =
      claim.row.kind === "analysis-threshold"
        ? await inspectAnalysis(claim.row)
        : await inspectDossier(claim.row);
  } catch (error) {
    finding = {
      status: "failed",
      // Inspection failures are thrown Errors.
      reason: `Monitor check failed: ${errorMessage(error)}`.slice(
        0,
        1000,
      ),
    };
  }
  const observation = await finalizeObservation(claim, finding);
  if (!observation && !dueOnly)
    fail("Monitor check was superseded; retry", 409, "MONITOR_BUSY");
  return observation;
}

/** Each tick claims at most four overdue local rules, sequentially. */
export async function checkDueAnalysisMonitors() {
  const ids = (
    await checkedRows(
      textIdRowSchema,
      db
        .selectFrom("analysis_monitors")
        .select("id")
        .where("enabled", "=", true)
        .where("next_due_at", "<=", sql<Date>`now()`)
        .where((eb) =>
          eb.or([
            eb("lease_token", "is", null),
            eb("lease_expires_at", "<", sql<Date>`now()`),
          ]),
        )
        .orderBy("next_due_at")
        .orderBy("id")
        .limit(MAX_DUE_PER_TICK),
    )
  ).map((row) => row.id);
  for (const id of ids) await checkAnalysisMonitor(id, { dueOnly: true });
  return ids.length;
}

export {
  classifyMonitorRun as __classifyMonitorRun,
  evaluateThreshold as __evaluateThreshold,
};
