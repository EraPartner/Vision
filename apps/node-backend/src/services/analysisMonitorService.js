/** Local-only deterministic monitor checks and durable in-app inbox. */

import { createHash, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { z } from "zod";
import { query, withTransaction } from "../database/connection.js";
import { runSavedAnalysis } from "./savedAnalysisService.js";

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const uuid = z.string().uuid();
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

function fail(message, status = 400, code = "INVALID_MONITOR_REQUEST") {
  throw Object.assign(new Error(message), { status, code });
}

function parsed(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success)
    fail(result.error.issues[0]?.message ?? "Invalid monitor input");
  return result.data;
}

function monitorId(id) {
  return parsed(uuid, id);
}

function page(input = {}) {
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

function mapMonitor(row) {
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
    threshold: row.threshold === null ? null : String(row.threshold),
    intervalMinutes: row.interval_minutes,
    cooldownMinutes: row.cooldown_minutes,
    nextDueAt: row.next_due_at,
    lastCheckedAt: row.last_checked_at,
    lastStatus: row.last_status,
    lastObservation: row.last_observation ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapObservation(row) {
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

function mapNotification(row) {
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

const MONITOR_SELECT = `SELECT m.*, row_to_json(o.*) AS last_observation
  FROM analysis_monitors m
  LEFT JOIN LATERAL (
    SELECT id, monitor_id, status, previous_value, current_value,
      previous_evidence_version, current_evidence_version, analysis_definition_version, analysis_run_id,
      historical_analysis_run_id, analysis_run_status, analysis_window_json,
      coverage_json, reason_code, reason, checked_at
    FROM analysis_monitor_observations
    WHERE monitor_id=m.id ORDER BY checked_at DESC, id DESC LIMIT 1
  ) o ON true`;

async function getMonitor(id) {
  monitorId(id);
  const row = (await query(`${MONITOR_SELECT} WHERE m.id=$1`, [id])).rows[0];
  if (!row) fail("Monitor not found", 404, "MONITOR_NOT_FOUND");
  const monitor = mapMonitor(row);
  if (row.last_observation)
    monitor.lastObservation = mapObservation(row.last_observation);
  return monitor;
}

export async function listAnalysisMonitors(input) {
  const { limit, offset } = page(input);
  const { rows } = await query(
    `${MONITOR_SELECT} ORDER BY m.created_at DESC, m.id DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  const total = Number(
    (await query("SELECT count(*) AS n FROM analysis_monitors")).rows[0].n,
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

export async function createAnalysisMonitor(input) {
  const value = parsed(createSchema, input);
  const target =
    value.kind === "analysis-threshold"
      ? (
          await query(
            "SELECT id,name,refresh_mode FROM saved_analyses WHERE id=$1",
            [value.savedAnalysisId],
          )
        ).rows[0]
      : (
          await query("SELECT id,title FROM research_dossiers WHERE id=$1", [
            value.dossierId,
          ])
        ).rows[0];
  if (!target)
    fail("Monitor target not found", 404, "MONITOR_TARGET_NOT_FOUND");
  if (target.refresh_mode === "frozen")
    fail("Frozen saved analyses cannot be monitored");
  if (value.kind === "analysis-threshold") {
    const definition = (
      await query(
        `SELECT v.definition_json FROM saved_analyses a JOIN saved_analysis_definition_versions v
      ON v.saved_analysis_id=a.id AND v.version=a.current_version WHERE a.id=$1`,
        [target.id],
      )
    ).rows[0]?.definition_json;
    if (
      !definition?.expectedResult?.columns?.some(
        (column) =>
          column.id === value.fieldId &&
          ["decimal", "number", "integer", "currency"].includes(column.type),
      )
    )
      fail("Field must be a declared numeric result column");
  }
  const id = randomUUID();
  await query(
    `INSERT INTO analysis_monitors
    (id,kind,title,saved_analysis_id,dossier_id,historical_target_id,target_label,field_id,operator,threshold,interval_minutes,cooldown_minutes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric,$11,$12)`,
    [
      id,
      value.kind,
      value.title,
      value.kind === "analysis-threshold" ? target.id : null,
      value.kind === "dossier-evidence" ? target.id : null,
      String(target.id),
      target.name ?? target.title,
      value.kind === "analysis-threshold" ? value.fieldId : null,
      value.kind === "analysis-threshold" ? value.operator : null,
      value.kind === "analysis-threshold" ? value.threshold : null,
      value.intervalMinutes,
      value.cooldownMinutes,
    ],
  );
  return getMonitor(id);
}

export async function patchAnalysisMonitor(id, input) {
  monitorId(id);
  const value = parsed(patchSchema, input);
  await withTransaction(async (client) => {
    const current = (
      await client.query(
        "SELECT * FROM analysis_monitors WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
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
      const definition = (
        await client.query(
          `SELECT v.definition_json FROM saved_analyses a JOIN saved_analysis_definition_versions v
        ON v.saved_analysis_id=a.id AND v.version=a.current_version WHERE a.id=$1`,
          [current.saved_analysis_id],
        )
      ).rows[0]?.definition_json;
      if (
        !definition?.expectedResult?.columns?.some(
          (column) =>
            column.id === value.fieldId &&
            ["decimal", "number", "integer", "currency"].includes(column.type),
        )
      )
        fail("Field must be a declared numeric result column");
    }
    const conditionChanged =
      value.fieldId !== undefined ||
      value.operator !== undefined ||
      value.threshold !== undefined;
    await client.query(
      `UPDATE analysis_monitors SET
      title=$2,enabled=$3,field_id=$4,operator=$5,threshold=$6::numeric,
      interval_minutes=$7,cooldown_minutes=$8,
      next_due_at=CASE WHEN $9 OR ($10 AND NOT enabled) THEN now() ELSE next_due_at END,
      active_episode_key=CASE WHEN $9 THEN NULL ELSE active_episode_key END,
      pending_signature=CASE WHEN $9 THEN NULL ELSE pending_signature END,
      pending_since=CASE WHEN $9 THEN NULL ELSE pending_since END,
      condition_revision=condition_revision+CASE WHEN $9 THEN 1 ELSE 0 END,
      updated_at=now() WHERE id=$1`,
      [
        id,
        value.title ?? current.title,
        value.enabled ?? current.enabled,
        value.fieldId ?? current.field_id,
        value.operator ?? current.operator,
        value.threshold ?? current.threshold,
        value.intervalMinutes ?? current.interval_minutes,
        value.cooldownMinutes ?? current.cooldown_minutes,
        conditionChanged,
        value.enabled === true,
      ],
    );
  });
  return getMonitor(id);
}

export async function deleteAnalysisMonitor(id) {
  monitorId(id);
  if (
    !(await query("DELETE FROM analysis_monitors WHERE id=$1", [id])).rowCount
  )
    fail("Monitor not found", 404, "MONITOR_NOT_FOUND");
}

export async function listMonitorObservations(id, input) {
  monitorId(id);
  await getMonitor(id);
  const { limit, offset } = page(input);
  const { rows } = await query(
    `SELECT * FROM analysis_monitor_observations WHERE monitor_id=$1
    ORDER BY checked_at DESC,id DESC LIMIT $2 OFFSET $3`,
    [id, limit, offset],
  );
  const total = Number(
    (
      await query(
        "SELECT count(*) AS n FROM analysis_monitor_observations WHERE monitor_id=$1",
        [id],
      )
    ).rows[0].n,
  );
  return { items: rows.map(mapObservation), total, limit, offset };
}

export async function listMonitorNotifications(input) {
  const { limit, offset } = page(input);
  const { rows } = await query(
    `SELECT * FROM analysis_monitor_notifications
    ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  const counts = (
    await query(`SELECT count(*) AS total, count(*) FILTER (WHERE read_at IS NULL) AS unread
    FROM analysis_monitor_notifications`)
  ).rows[0];
  return {
    items: rows.map(mapNotification),
    total: Number(counts.total),
    unreadCount: Number(counts.unread),
    limit,
    offset,
  };
}

export async function readMonitorNotification(id) {
  monitorId(id);
  const row = (
    await query(
      `UPDATE analysis_monitor_notifications SET read_at=coalesce(read_at,now())
    WHERE id=$1 RETURNING *`,
      [id],
    )
  ).rows[0];
  if (!row)
    fail("Notification not found", 404, "MONITOR_NOTIFICATION_NOT_FOUND");
  return mapNotification(row);
}

function evaluateThreshold({
  previousValue,
  currentValue,
  operator,
  threshold,
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

function evidenceHash(evidence) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])]),
      );
    return value;
  };
  const sorted = [...evidence].sort((a, b) =>
    String(a?.id).localeCompare(String(b?.id)),
  );
  return createHash("sha256")
    .update(JSON.stringify(canonical(sorted)))
    .digest("hex");
}

function finiteResultValue(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const str = String(value);
  if (!DECIMAL.test(str)) return null;
  const decimal = new Decimal(str);
  return decimal.isFinite() ? decimal.toString() : null;
}

async function claimMonitor(id, dueOnly) {
  monitorId(id);
  const token = randomUUID();
  const row = (
    await query(
      `UPDATE analysis_monitors SET lease_token=$2,
      lease_expires_at=now()+($3 || ' minutes')::interval
    WHERE id=$1 AND enabled AND (lease_token IS NULL OR lease_expires_at < now())
      AND ($4::boolean=false OR next_due_at <= now())
    RETURNING *`,
      [id, token, String(LEASE_MINUTES), dueOnly],
    )
  ).rows[0];
  if (!row && !dueOnly) {
    const exists =
      (await query("SELECT 1 FROM analysis_monitors WHERE id=$1", [id])).rows
        .length > 0;
    fail(
      exists ? "Monitor is disabled or already running" : "Monitor not found",
      exists ? 409 : 404,
      exists ? "MONITOR_BUSY" : "MONITOR_NOT_FOUND",
    );
  }
  return row ? { row, token } : null;
}

async function inspectAnalysis(row) {
  if (!row.saved_analysis_id)
    return {
      status: "failed",
      reasonCode: "analysis-deleted",
      reason: "The saved analysis was deleted.",
    };
  const saved = (
    await query("SELECT refresh_mode FROM saved_analyses WHERE id=$1", [
      row.saved_analysis_id,
    ])
  ).rows[0];
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
  } catch (error) {
    const failedRun = error.monitorRunId
      ? (
          await query("SELECT status FROM saved_analysis_runs WHERE id=$1", [
            error.monitorRunId,
          ])
        ).rows[0]
      : null;
    return {
      status: "failed",
      reasonCode: "analysis-execution-failed",
      reason: `Analysis failed: ${error.message}`.slice(0, 1000),
      runId: error.monitorRunId ?? null,
      runStatus: failedRun?.status ?? null,
    };
  }
  const run = (
    await query(
      `SELECT r.id,r.status,r.result_json,r.definition_version,
         a.current_version,v.definition_json
       FROM saved_analysis_runs r
       JOIN saved_analyses a ON a.id=r.saved_analysis_id
       JOIN saved_analysis_definition_versions v
         ON v.saved_analysis_id=a.id AND v.version=a.current_version
       WHERE r.id=$1`,
      [runId],
    )
  ).rows[0];
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
  if (
    !run.definition_json?.expectedResult?.columns?.some(
      (column) =>
        column.id === row.field_id &&
        ["decimal", "number", "integer", "currency"].includes(column.type),
    )
  )
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

function classifyMonitorRun(run, fieldId) {
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
  const value = finiteResultValue(result.rows[0][fieldId]);
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

async function inspectDossier(row) {
  if (!row.dossier_id)
    return {
      status: "failed",
      reasonCode: "dossier-deleted",
      reason: "The research dossier was deleted.",
    };
  const dossier = (
    await query(
      "SELECT version,content_json FROM research_dossiers WHERE id=$1",
      [row.dossier_id],
    )
  ).rows[0];
  if (!dossier)
    return {
      status: "failed",
      reasonCode: "dossier-unavailable",
      reason: "The research dossier is unavailable.",
    };
  const evidence = dossier.content_json?.evidence;
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

async function finalizeObservation(claim, finding) {
  const { row, token } = claim;
  return withTransaction(async (client) => {
    const locked = (
      await client.query(
        "SELECT * FROM analysis_monitors WHERE id=$1 FOR UPDATE",
        [row.id],
      )
    ).rows[0];
    if (!locked || locked.lease_token !== token) return null;
    if (locked.condition_revision !== row.condition_revision) {
      await client.query(
        `UPDATE analysis_monitors SET lease_token=NULL,lease_expires_at=NULL,
        next_due_at=now() WHERE id=$1`,
        [row.id],
      );
      return null;
    }
    const prior =
      (
        await client.query(
          `SELECT * FROM analysis_monitor_observations
      WHERE monitor_id=$1 AND condition_revision=$2
        AND status IN ('baseline','unchanged','triggered','cooldown-pending')
      ORDER BY checked_at DESC,id DESC LIMIT 1`,
          [row.id, locked.condition_revision],
        )
      ).rows[0] ?? null;
    const now = new Date();
    let status = finding.status;
    let reasonCode = finding.reasonCode ?? "monitor-check-failed";
    let reason = finding.reason;
    let previousValue = prior?.current_value ?? null;
    let currentValue = finding.value ?? null;
    let previousEvidenceVersion = prior?.current_evidence_version ?? null;
    let currentEvidenceVersion = finding.evidenceVersion ?? null;
    let hash = finding.evidenceHash ?? null;
    let episodeKey = locked.active_episode_key;
    let pendingSignature = locked.pending_signature;
    let pendingSince = locked.pending_since;
    let lastNotifiedAt = locked.last_notified_at;
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
        const evaluation = evaluateThreshold({
          previousValue,
          currentValue,
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
    const id = randomUUID();
    const observation = (
      await client.query(
        `INSERT INTO analysis_monitor_observations
      (id,monitor_id,status,previous_value,current_value,previous_evidence_version,current_evidence_version,
        evidence_hash,condition_revision,analysis_definition_version,analysis_run_id,historical_analysis_run_id,
        analysis_run_status,analysis_window_json,coverage_json,reason_code,reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17) RETURNING *`,
        [
          id,
          row.id,
          status,
          previousValue,
          currentValue,
          previousEvidenceVersion,
          currentEvidenceVersion,
          hash,
          locked.condition_revision,
          finding.definitionVersion ?? null,
          finding.runId ?? null,
          finding.runId ?? null,
          finding.runStatus ?? null,
          finding.runWindow ? JSON.stringify(finding.runWindow) : null,
          JSON.stringify(COVERAGE),
          reasonCode,
          reason.slice(0, 1000),
        ],
      )
    ).rows[0];
    if (notify) {
      await client.query(
        `INSERT INTO analysis_monitor_notifications
        (monitor_id,observation_id,kind,title,reason_code,reason,previous_value,current_value,episode_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (monitor_id,episode_key) DO NOTHING`,
        [
          row.id,
          id,
          row.kind,
          row.title,
          reasonCode,
          reason,
          previousValue,
          currentValue,
          episodeKey,
        ],
      );
    }
    await client.query(
      `UPDATE analysis_monitors SET last_checked_at=now(),last_status=$2,
      next_due_at=now()+($3 || ' minutes')::interval,
      active_episode_key=$4,pending_signature=$5,pending_since=$6,last_notified_at=$7,
      lease_token=NULL,lease_expires_at=NULL,updated_at=now()
      WHERE id=$1`,
      [
        row.id,
        status,
        String(row.interval_minutes),
        episodeKey,
        pendingSignature,
        pendingSince,
        lastNotifiedAt,
      ],
    );
    return mapObservation(observation);
  });
}

export async function checkAnalysisMonitor(id, { dueOnly = false } = {}) {
  const claim = await claimMonitor(id, dueOnly);
  if (!claim) return null;
  let finding;
  try {
    finding =
      claim.row.kind === "analysis-threshold"
        ? await inspectAnalysis(claim.row)
        : await inspectDossier(claim.row);
  } catch (error) {
    finding = {
      status: "failed",
      reason: `Monitor check failed: ${error.message}`.slice(0, 1000),
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
    await query(
      `SELECT id FROM analysis_monitors WHERE enabled AND next_due_at <= now()
    AND (lease_token IS NULL OR lease_expires_at < now()) ORDER BY next_due_at,id LIMIT $1`,
      [MAX_DUE_PER_TICK],
    )
  ).rows.map((row) => row.id);
  for (const id of ids) await checkAnalysisMonitor(id, { dueOnly: true });
  return ids.length;
}

export {
  classifyMonitorRun as __classifyMonitorRun,
  evaluateThreshold as __evaluateThreshold,
};
