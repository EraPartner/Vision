/**
 * Accuracy persistence store.
 * Delegates to cashflowForecastAccuracyRepository (Postgres, table created
 * by Alembic migration 0012_cashflow_forecast_accuracy).
 *
 * Falls back to an in-memory stub when the DB table does not yet exist
 * (e.g. during development before running migrations) or when Postgres
 * is unreachable (dev/test environments without a running DB). Fallback
 * is silent so the forecast endpoint remains usable in either case.
 */

import accuracyRepo from "../../../repositories/cashflowForecastAccuracyRepository.ts";
import { logger } from "../../../config/logger.ts";
import type {
  AccuracyRow,
  AccuracyUpsert,
} from "../../../repositories/cashflowForecastAccuracyRepository.ts";

/**
 * Uniform store output shape. `accuracyRepo`'s Postgres rows come back
 * snake_case (`AccuracyRow` in cashflowForecastAccuracyRepository.js); the
 * getters below normalize them through `toAccuracyRecord` so both branches of
 * `withFallback` — DB and in-memory — return this same camelCase shape.
 */
export interface AccuracyRecord {
  userId: string;
  methodId: string;
  asOfMonth: string;
  /** NULL in the stored row when the backtest produced no value. */
  mae: number | null;
  rmse: number | null;
  mape: number | null;
  sampleDays: number | null;
  recordedAt: string;
}

function toAccuracyRecord(row: AccuracyRow): AccuracyRecord {
  return {
    userId: row.user_id,
    methodId: row.method_id,
    asOfMonth: row.as_of_month,
    mae: row.mae,
    rmse: row.rmse,
    mape: row.mape,
    sampleDays: row.sample_days,
    recordedAt:
      row.recorded_at instanceof Date
        ? row.recorded_at.toISOString()
        : row.recorded_at,
  };
}

const inMemoryFallback = new Map<string, AccuracyRecord>();
let missingTableWarned = false;
let accuracyTableHealthy = true;

function fallbackKey(userId: string, methodId: string, asOfMonth: string) {
  return `${userId}|${methodId}|${asOfMonth}`;
}

async function withFallback<T, F>(
  dbFn: () => Promise<T>,
  fallbackFn: () => F,
): Promise<T | F> {
  try {
    const result = await dbFn();
    accuracyTableHealthy = true;
    return result;
  } catch (err) {
    if (isTableMissingError(err)) {
      accuracyTableHealthy = false;
      if (!missingTableWarned) {
        missingTableWarned = true;
        logger.error(
          "cashflow_forecast_accuracy table missing — run Alembic migration 0012",
        );
      }
      return fallbackFn();
    }
    throw err;
  }
}

export function isAccuracyTableHealthy() {
  return accuracyTableHealthy;
}

const FALLBACK_PG_CODES = new Set([
  "42P01", // undefined_table — migration not yet applied
  "ECONNREFUSED", // DB unreachable (dev/test env without Postgres)
  "ENOTFOUND", // DB host unresolved
  "ETIMEDOUT", // connection attempt timed out
]);

function isTableMissingError(err: unknown) {
  const e = err as { code?: string; message?: string } | null | undefined;
  if (e?.code !== undefined && FALLBACK_PG_CODES.has(e.code)) return true;
  return (
    typeof e?.message === "string" &&
    e.message.includes("cashflow_forecast_accuracy")
  );
}

export async function recordAccuracy({
  userId,
  methodId,
  asOfMonth,
  mae,
  rmse,
  mape,
  sampleDays,
}: AccuracyUpsert) {
  await withFallback(
    () =>
      accuracyRepo.upsert({
        userId,
        methodId,
        asOfMonth,
        mae,
        rmse,
        mape,
        sampleDays,
      }),
    () => {
      inMemoryFallback.set(fallbackKey(userId, methodId, asOfMonth), {
        userId,
        methodId,
        asOfMonth,
        mae,
        rmse,
        mape,
        sampleDays,
        recordedAt: new Date().toISOString(),
      });
    },
  );
}

async function getAccuracyHistory({
  userId,
  methodId,
  limitMonths = 24,
}: {
  userId: string;
  methodId: string;
  limitMonths?: number;
}): Promise<AccuracyRecord[]> {
  return withFallback(
    async () =>
      (await accuracyRepo.getHistory({ userId, methodId, limitMonths })).map(
        toAccuracyRecord,
      ),
    () => {
      const rows: AccuracyRecord[] = [];
      for (const [k, v] of inMemoryFallback) {
        if (!k.startsWith(`${userId}|${methodId}|`)) continue;
        rows.push(v);
      }
      return rows
        .sort((a, b) => b.asOfMonth.localeCompare(a.asOfMonth))
        .slice(0, limitMonths);
    },
  );
}

export async function getLatestAccuracyByMethod({
  userId,
}: {
  userId: string;
}): Promise<AccuracyRecord[]> {
  return withFallback(
    async () =>
      (await accuracyRepo.getLatestByMethod({ userId })).map(toAccuracyRecord),
    () => {
      const byMethod = new Map<string, AccuracyRecord>();
      for (const [k, v] of inMemoryFallback) {
        if (!k.startsWith(`${userId}|`)) continue;
        const existing = byMethod.get(v.methodId);
        if (!existing || v.asOfMonth > existing.asOfMonth)
          byMethod.set(v.methodId, v);
      }
      return Array.from(byMethod.values());
    },
  );
}

export async function getAllAccuracyHistory({
  userId,
  limitMonths = 24,
}: {
  userId: string;
  limitMonths?: number;
}): Promise<AccuracyRecord[]> {
  return withFallback(
    async () =>
      (await accuracyRepo.getAllHistory({ userId, limitMonths })).map(
        toAccuracyRecord,
      ),
    () => {
      const rows: AccuracyRecord[] = [];
      for (const v of inMemoryFallback.values()) {
        if (v.userId !== userId) continue;
        rows.push(v);
      }
      return rows.sort((a, b) =>
        a.methodId !== b.methodId
          ? a.methodId.localeCompare(b.methodId)
          : a.asOfMonth.localeCompare(b.asOfMonth),
      );
    },
  );
}

function _resetForTests() {
  inMemoryFallback.clear();
}

export default {
  recordAccuracy,
  getAccuracyHistory,
  getLatestAccuracyByMethod,
  getAllAccuracyHistory,
  isAccuracyTableHealthy,
};

export {
  _resetForTests as __resetForTests,
  getAccuracyHistory as __getAccuracyHistory,
};
