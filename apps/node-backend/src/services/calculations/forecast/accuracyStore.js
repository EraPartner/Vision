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

import accuracyRepo from '../../../repositories/cashflowForecastAccuracyRepository.js';
import { logger } from '../../../config/logger.js';

/**
 * Uniform store output shape. `accuracyRepo`'s Postgres rows come back
 * snake_case (`AccuracyRow` in cashflowForecastAccuracyRepository.js); the
 * getters below normalize them through `toAccuracyRecord` so both branches of
 * `withFallback` — DB and in-memory — return this same camelCase shape.
 * @typedef {{
 *   userId: string, methodId: string, asOfMonth: string,
 *   mae: number, rmse: number, mape: number, sampleDays: number,
 *   recordedAt: string,
 * }} AccuracyRecord
 */

/**
 * @param {import('../../../repositories/cashflowForecastAccuracyRepository.js').AccuracyRow} row
 * @returns {AccuracyRecord}
 */
function toAccuracyRecord(row) {
  return {
    userId: row.user_id,
    methodId: row.method_id,
    asOfMonth: row.as_of_month,
    mae: row.mae,
    rmse: row.rmse,
    mape: row.mape,
    sampleDays: row.sample_days,
    recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at,
  };
}

/** @type {Map<string, AccuracyRecord>} */
const inMemoryFallback = new Map();
let missingTableWarned = false;
let accuracyTableHealthy = true;

/**
 * @param {string} userId
 * @param {string} methodId
 * @param {string} asOfMonth
 */
function fallbackKey(userId, methodId, asOfMonth) {
  return `${userId}|${methodId}|${asOfMonth}`;
}

/**
 * @template T
 * @template F
 * @param {() => Promise<T>} dbFn
 * @param {() => F} fallbackFn
 * @returns {Promise<T|F>}
 */
async function withFallback(dbFn, fallbackFn) {
  try {
    const result = await dbFn();
    accuracyTableHealthy = true;
    return result;
  } catch (err) {
    if (isTableMissingError(err)) {
      accuracyTableHealthy = false;
      if (!missingTableWarned) {
        missingTableWarned = true;
        logger.error('cashflow_forecast_accuracy table missing — run Alembic migration 0012');
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
  '42P01',           // undefined_table — migration not yet applied
  'ECONNREFUSED',    // DB unreachable (dev/test env without Postgres)
  'ENOTFOUND',       // DB host unresolved
  'ETIMEDOUT',       // connection attempt timed out
]);

/** @param {unknown} err */
function isTableMissingError(err) {
  const e = /** @type {{ code?: string, message?: string }} */ (err);
  if (FALLBACK_PG_CODES.has(e?.code)) return true;
  return typeof e?.message === 'string' && e.message.includes('cashflow_forecast_accuracy');
}

/**
 * @param {{ userId: string, methodId: string, asOfMonth: string, mae: number, rmse: number, mape: number, sampleDays: number }} params
 */
export async function recordAccuracy({ userId, methodId, asOfMonth, mae, rmse, mape, sampleDays }) {
  await withFallback(
    () => accuracyRepo.upsert({ userId, methodId, asOfMonth, mae, rmse, mape, sampleDays }),
    () => {
      inMemoryFallback.set(fallbackKey(userId, methodId, asOfMonth), {
        userId, methodId, asOfMonth, mae, rmse, mape, sampleDays,
        recordedAt: new Date().toISOString(),
      });
    },
  );
}

/**
 * @param {{ userId: string, methodId: string, limitMonths?: number }} params
 * @returns {Promise<AccuracyRecord[]>}
 */
export async function getAccuracyHistory({ userId, methodId, limitMonths = 24 }) {
  return withFallback(
    async () => (await accuracyRepo.getHistory({ userId, methodId, limitMonths })).map(toAccuracyRecord),
    () => {
      /** @type {AccuracyRecord[]} */
      const rows = [];
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

/**
 * @param {{ userId: string }} params
 * @returns {Promise<AccuracyRecord[]>}
 */
export async function getLatestAccuracyByMethod({ userId }) {
  return withFallback(
    async () => (await accuracyRepo.getLatestByMethod({ userId })).map(toAccuracyRecord),
    () => {
      /** @type {Map<string, AccuracyRecord>} */
      const byMethod = new Map();
      for (const [k, v] of inMemoryFallback) {
        if (!k.startsWith(`${userId}|`)) continue;
        const existing = byMethod.get(v.methodId);
        if (!existing || v.asOfMonth > existing.asOfMonth) byMethod.set(v.methodId, v);
      }
      return Array.from(byMethod.values());
    },
  );
}

/**
 * @param {{ userId: string, limitMonths?: number }} params
 * @returns {Promise<AccuracyRecord[]>}
 */
export async function getAllAccuracyHistory({ userId, limitMonths = 24 }) {
  return withFallback(
    async () => (await accuracyRepo.getAllHistory({ userId, limitMonths })).map(toAccuracyRecord),
    () => {
      /** @type {AccuracyRecord[]} */
      const rows = [];
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

export function _resetForTests() {
  inMemoryFallback.clear();
}

export default { recordAccuracy, getAccuracyHistory, getLatestAccuracyByMethod, getAllAccuracyHistory, isAccuracyTableHealthy };
