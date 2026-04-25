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

const inMemoryFallback = new Map();
let missingTableWarned = false;
let accuracyTableHealthy = true;

function fallbackKey(userId, methodId, asOfMonth) {
  return `${userId}|${methodId}|${asOfMonth}`;
}

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

function isTableMissingError(err) {
  if (FALLBACK_PG_CODES.has(err?.code)) return true;
  return typeof err?.message === 'string' && err.message.includes('cashflow_forecast_accuracy');
}

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

export async function getAccuracyHistory({ userId, methodId, limitMonths = 24 }) {
  return withFallback(
    () => accuracyRepo.getHistory({ userId, methodId, limitMonths }),
    () => {
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

export async function getLatestAccuracyByMethod({ userId }) {
  return withFallback(
    () => accuracyRepo.getLatestByMethod({ userId }),
    () => {
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

export async function getAllAccuracyHistory({ userId, limitMonths = 24 }) {
  return withFallback(
    () => accuracyRepo.getAllHistory({ userId, limitMonths }),
    () => {
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
