import { withTransaction } from '../database/connection.ts';
import { queryRows } from '../database/rowContracts.ts';
import { belgianInflationMonthRowSchema } from '../database/rows/info.ts';
import { logger } from '../config/logger.ts';
import { recordSuccess as recordProviderSuccess, recordError as recordProviderError } from './providerHealthService.ts';
import { roundMoney } from '../lib/money.ts';

import type { BelgianInflationRate } from '../types/rows.ts';

export type { BelgianInflationRate };

/** An object parsed from an untrusted provider JSON payload. */
type JsonObject = Record<string, unknown>;

/** The subset of the Statbel response read here; nothing in it is validated. */
type StatbelPayload = { facts?: JsonObject[] };

/** The subset of the Eurostat JSON-stat response read here; nothing in it is validated. */
type EurostatIndexPayload = {
  dimension?: { time?: { category?: { index?: JsonObject } } };
  value?: JsonObject;
};

export interface InflationRatesResult {
  source: string;
  rates: BelgianInflationRate[];
}

// belgian_inflation_rates.monthly_rate is NUMERIC(10,8): keep the full 8 dp of
// stored scale. Rounding to 6 dp here threw away precision the column could
// hold, and the truncation compounds multiplicatively in snapshotBuilder.
const RATE_DECIMALS = 8;

const CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000;
const STATBEL_REQUEST_TIMEOUT_MS = 10_000;
const STATBEL_MAX_RETRIES_PER_URL = 2;
const STATBEL_RETRY_BASE_DELAY_MS = 500;
const STATBEL_WARN_THROTTLE_MS = 30 * 60 * 1000;

const STATBEL_CANDIDATE_URLS = [
  'https://bestat.statbel.fgov.be/bestat/api/views/86586e27-90ac-47c6-87ce-64b63194e605/result/JSON',
  'https://bestat.economie.fgov.be/bestat/api/views/86586e27-90ac-47c6-87ce-64b63194e605/result/JSON',
];

const EUROSTAT_HICP_INDEX_URL =
  'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_midx?geo=BE&coicop=CP00&unit=I15';

let memoryCache: { rates: BelgianInflationRate[], timestamp: number } | null = null;
let statbelFailureLogState = { lastWarnAt: 0, suppressed: 0 };
let backgroundRefreshPromise: Promise<void> | null = null;

function isTruthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }
  return false;
}

// Deliberately global-setTimeout-based (not node:timers/promises): the retry
// throttle test drives this with vi.useFakeTimers(), which patches the global
// but cannot fake timers/promises.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}

function logStatbelFallbackWarning(error: unknown) {
  const now = Date.now();
  if (now - statbelFailureLogState.lastWarnAt >= STATBEL_WARN_THROTTLE_MS) {
    logger.warn('Failed to fetch external inflation rates; falling back to database', {
      error: errorMessage(error),
      suppressed_since_last_warning: statbelFailureLogState.suppressed,
    });
    statbelFailureLogState = { lastWarnAt: now, suppressed: 0 };
    return;
  }

  statbelFailureLogState.suppressed += 1;
  logger.debug('External inflation fetch failed; warning suppressed during throttle window', {
    error: errorMessage(error),
    suppressed: statbelFailureLogState.suppressed,
  });
}

/** @returns 'YYYY-MM' */
function normalizeMonthInput(value: unknown): string | undefined {
  if (!value) return undefined;
  const text = String(value).trim();
  const direct = text.match(/^(\d{4})-(\d{2})$/);
  if (direct) return `${direct[1]}-${direct[2]}`;

  const isoDate = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoDate) return `${isoDate[1]}-${isoDate[2]}`;

  const slashDate = text.match(/^(\d{4})\/(\d{2})/);
  if (slashDate) return `${slashDate[1]}-${slashDate[2]}`;

  return undefined;
}

/** @returns 'YYYY-MM' */
function monthKeyFromDatabaseValue(
  value: Date | string | null | undefined,
): string | undefined {
  if (value === null || value === undefined) return undefined;

  if (value instanceof Date && Number.isFinite(value.getTime())) {
    // pg reads month_date (first-of-month DATE) as LOCAL midnight; UTC
    // extraction (toISOString) rendered it as the last day of the PREVIOUS
    // month east of UTC, labeling every rate with the prior month's key.
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
  }

  const normalized = normalizeMonthInput(value);
  if (normalized) return normalized;

  const parsed = new Date(value);
  if (Number.isFinite(parsed.getTime())) {
    return parsed.toISOString().slice(0, 7);
  }

  return undefined;
}

function parseNumeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const sanitized = value.replace(',', '.').replace(/[^0-9.+-]/g, '').trim();
  if (!sanitized) return undefined;
  const parsed = Number(sanitized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const MONTH_NAME_TO_NUMBER: Record<string, number> = {
  january: 1, jan: 1, januari: 1, janvier: 1,
  february: 2, feb: 2, februari: 2, fevrier: 2, février: 2,
  march: 3, mar: 3, maart: 3, mars: 3,
  april: 4, avr: 4,
  may: 5, mei: 5, mai: 5,
  june: 6, jun: 6, juni: 6, juin: 6,
  july: 7, jul: 7, juli: 7, juillet: 7,
  august: 8, aug: 8, augustus: 8, aout: 8, août: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, oktober: 10, octobre: 10,
  november: 11, nov: 11,
  december: 12, dec: 12, decembre: 12, décembre: 12,
};

// Own keys only: an upstream "constructor" must not resolve to Object.prototype.
function monthNumberForName(name: string): number | undefined {
  return Object.hasOwn(MONTH_NAME_TO_NUMBER, name)
    ? MONTH_NAME_TO_NUMBER[name]
    : undefined;
}

function parseMonthName(value: unknown): number | undefined {
  if (!value) return undefined;
  const normalized = String(value).trim().toLowerCase();
  return monthNumberForName(normalized);
}

/**
 * @param row raw provider payload row — key set varies by upstream (EN/NL/FR).
 * @returns 'YYYY-MM'
 */
function parseMonthFromRow(row: JsonObject): string | undefined {
  const directMonth = normalizeMonthInput(
    row.month
    ?? row.maand
    ?? row.mois
    ?? row.period
    ?? row.periode
    ?? row.time
    ?? row.date
  );
  if (directMonth) return directMonth;

  const year = parseNumeric(row.year ?? row.jaar ?? row.annee ?? row.année);
  const rawMonth = row.month_number ?? row.monthnr ?? row.maand_nr ?? row.mois_nr ?? row.month ?? row.maand ?? row.mois;

  if (year === undefined || !Number.isFinite(year)) return undefined;

  const monthNumber = parseNumeric(rawMonth) ?? parseMonthName(rawMonth);
  if (monthNumber === undefined || !Number.isFinite(monthNumber) || monthNumber < 1 || monthNumber > 12) return undefined;

  return `${Math.trunc(year)}-${String(Math.trunc(monthNumber)).padStart(2, '0')}`;
}

/** @param row raw provider payload row — key set varies by upstream (EN/NL/FR). */
function parseMonthlyRateFromRow(row: JsonObject): number | undefined {
  const candidateKeys = [
    'monthly_rate',
    'monthly_inflation_rate',
    'inflation_monthly',
    'inflation_rate_monthly',
    'inflatie_maandelijks',
    'taux_inflation_mensuel',
    'inflation',
    'inflatie',
    'value',
    'valeur',
  ];

  let rawValue: unknown;
  for (const key of candidateKeys) {
    if (row[key] !== undefined) {
      rawValue = row[key];
      break;
    }
  }

  if (rawValue === undefined) {
    const numericCandidates = Object.entries(row)
      .filter(([k]) => !['year', 'jaar', 'annee', 'année', 'month', 'maand', 'mois', 'period', 'periode', 'time', 'date'].includes(k))
      .map(([, v]) => parseNumeric(v))
      .filter((v) => Number.isFinite(v));
    rawValue = numericCandidates[0];
  }

  const parsed = parseNumeric(rawValue);
  if (parsed === undefined || !Number.isFinite(parsed)) return undefined;

  // Accept both decimal form (0.0025) and percentage form (0.25 or 2.5).
  // Belgian monthly inflation is expected to be in low single-digit percentages.
  if (Math.abs(parsed) > 1) return parsed / 100;
  if (Math.abs(parsed) > 0.05) return parsed / 100;
  return parsed;
}

/**
 * Recursively flatten a nested provider JSON payload (structure varies by
 * upstream) down to the leaf "row-like" objects — those with at least one
 * string/number property, which is `parseMonthFromRow`/`parseMonthlyRateFromRow`'s
 * signal that an object is a data row rather than a container.
 */
function extractObjectRows(payload: unknown): JsonObject[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => extractObjectRows(item));
  }

  if (!isJsonObject(payload)) return [];

  const values = Object.values(payload);
  const objectValues = values.filter((value) => value && typeof value === 'object');

  const looksLikeRow = Object.values(payload).some((value) => ['string', 'number'].includes(typeof value));
  const nestedRows = objectValues.flatMap((value) => extractObjectRows(value));

  return looksLikeRow ? [payload, ...nestedRows] : nestedRows;
}

function normalizeRatesFromPayload(payload: unknown): BelgianInflationRate[] {
  const rows = extractObjectRows(payload);
  const byMonth = new Map<string, BelgianInflationRate>();

  for (const row of rows) {
    const month = parseMonthFromRow(row);
    const monthlyRate = parseMonthlyRateFromRow(row);
    if (!month || monthlyRate === undefined || !Number.isFinite(monthlyRate)) continue;
    byMonth.set(month, {
      month,
      monthly_rate: roundMoney(monthlyRate, RATE_DECIMALS),
    });
  }

  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * @param value e.g. 'January 2024'.
 * @returns 'YYYY-MM'
 */
function parseStatbelMonthString(value: unknown): string | undefined {
  if (!value) return undefined;
  const parts = String(value).trim().split(/\s+/);
  const [monthName] = parts;
  const yearPart = parts.at(-1);
  if (parts.length < 2 || monthName === undefined || yearPart === undefined) return undefined;
  const monthNum = monthNumberForName(monthName.toLowerCase());
  const year = parseNumeric(yearPart);
  if (!monthNum || year === undefined || !Number.isFinite(year) || year < 1900 || year > 2100) return undefined;
  return `${Math.trunc(year)}-${String(monthNum).padStart(2, '0')}`;
}

function normalizeRatesFromStatbelPayload(payload: unknown): BelgianInflationRate[] {
  const facts = (payload as StatbelPayload | null | undefined)?.facts;
  if (!Array.isArray(facts) || facts.length === 0) return [];

  const globalRows = facts.filter((row) => row['Level 1'] === null || row['Level 1'] === undefined);
  const indexed = globalRows
    .map((row) => {
      const month = parseStatbelMonthString(row['Month']);
      const cpi = parseNumeric(row['Consumer price index']);
      return month && cpi !== undefined && Number.isFinite(cpi) && cpi > 0 ? { month, cpi } : null;
    })
    .filter((item): item is { month: string, cpi: number } => Boolean(item))
    .sort((a, b) => a.month.localeCompare(b.month));

  if (indexed.length < 2) return [];

  const rates: BelgianInflationRate[] = [];
  for (const [i, curr] of indexed.entries()) {
    const prev = indexed[i - 1];
    if (prev === undefined) continue;
    const monthlyRate = (curr.cpi / prev.cpi) - 1;
    if (!Number.isFinite(monthlyRate) || Math.abs(monthlyRate) > 1) continue;
    rates.push({ month: curr.month, monthly_rate: roundMoney(monthlyRate, RATE_DECIMALS) });
  }

  return rates;
}

function normalizeRatesFromEurostatIndexPayload(payload: unknown): BelgianInflationRate[] {
  const eurostat = payload as EurostatIndexPayload | null | undefined;
  const timeIndex = eurostat?.dimension?.time?.category?.index;
  const values = eurostat?.value;
  if (!timeIndex || typeof timeIndex !== 'object' || !values || typeof values !== 'object') return [];

  const sortedTimeline = Object.entries(timeIndex)
    .map(([rawMonth, rawIndex]) => ({
      month: normalizeMonthInput(rawMonth),
      index: parseNumeric(rawIndex),
    }))
    .filter(
      (item): item is { month: string, index: number } =>
        Boolean(item.month) && Number.isFinite(item.index),
    )
    .sort((a, b) => a.index - b.index);

  if (sortedTimeline.length < 2) return [];

  const monthlyIndex: { month: string, indexValue: number }[] = [];
  for (const item of sortedTimeline) {
    const rawValue = values[item.index] ?? values[String(item.index)];
    const indexValue = parseNumeric(rawValue);
    if (indexValue === undefined || !Number.isFinite(indexValue) || indexValue <= 0) continue;
    monthlyIndex.push({ month: item.month, indexValue });
  }

  if (monthlyIndex.length < 2) return [];

  const rates: BelgianInflationRate[] = [];
  for (let i = 1; i < monthlyIndex.length; i += 1) {
    const previous = monthlyIndex[i - 1];
    const current = monthlyIndex[i];
    if (!previous || !current) continue;

    const monthlyRate = (current.indexValue / previous.indexValue) - 1;
    if (!Number.isFinite(monthlyRate) || Math.abs(monthlyRate) > 1) continue;

    rates.push({
      month: current.month,
      monthly_rate: roundMoney(monthlyRate, RATE_DECIMALS),
    });
  }

  return rates;
}

async function fetchFromStatbel(): Promise<BelgianInflationRate[]> {
  const fetchWithRetries = async (url: string): Promise<BelgianInflationRate[]> => {
    let lastError: unknown;

    for (let attempt = 0; attempt <= STATBEL_MAX_RETRIES_PER_URL; attempt += 1) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(STATBEL_REQUEST_TIMEOUT_MS) });
        if (!response.ok) {
          lastError = new Error(`HTTP ${response.status} from ${url}`);
        } else {
          const payload = await response.json();
          const statbelRates = normalizeRatesFromStatbelPayload(payload);
          const rates = statbelRates.length > 0 ? statbelRates : normalizeRatesFromPayload(payload);
          if (rates.length > 0) {
            logger.debug('Fetched Belgian inflation rates from Statbel', { url, count: rates.length, attempt: attempt + 1 });
            return rates;
          }
          lastError = new Error(`No monthly rates parsed from ${url}`);
        }
      } catch (error) {
        lastError = error;
      }

      if (attempt < STATBEL_MAX_RETRIES_PER_URL) {
        const delayMs = STATBEL_RETRY_BASE_DELAY_MS * (attempt + 1);
        await sleep(delayMs);
      }
    }

    throw lastError ?? new Error(`Failed to fetch Belgian inflation rates from ${url}`);
  };

  let lastError: unknown;
  for (const url of STATBEL_CANDIDATE_URLS) {
    try {
      return await fetchWithRetries(url);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('Failed to fetch Belgian inflation rates from Statbel');
}

async function fetchFromEurostat(): Promise<BelgianInflationRate[]> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= STATBEL_MAX_RETRIES_PER_URL; attempt += 1) {
    try {
      const response = await fetch(EUROSTAT_HICP_INDEX_URL, { signal: AbortSignal.timeout(STATBEL_REQUEST_TIMEOUT_MS) });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} from Eurostat HICP endpoint`);
      } else {
        const payload = await response.json();
        const rates = normalizeRatesFromEurostatIndexPayload(payload);
        if (rates.length > 0) {
          logger.debug('Fetched Belgian inflation rates from Eurostat HICP index', {
            count: rates.length,
            attempt: attempt + 1,
          });
          return rates;
        }
        lastError = new Error('No monthly rates parsed from Eurostat HICP index response');
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < STATBEL_MAX_RETRIES_PER_URL) {
      const delayMs = STATBEL_RETRY_BASE_DELAY_MS * (attempt + 1);
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error('Failed to fetch Belgian inflation rates from Eurostat');
}

async function fetchExternalInflationRates() {
  try {
    const rates = await fetchFromStatbel();
    recordProviderSuccess('statbel');
    return { source: 'statbel', rates };
  } catch (statbelError) {
    logger.debug('Statbel inflation fetch failed; trying Eurostat fallback', { error: errorMessage(statbelError) });
    recordProviderError('statbel', statbelError);
  }

  try {
    const rates = await fetchFromEurostat();
    recordProviderSuccess('eurostat');
    return { source: 'eurostat', rates };
  } catch (eurostatError) {
    recordProviderError('eurostat', eurostatError);
    throw eurostatError;
  }
}

async function refreshFromExternalAndPersist() {
  const external = await fetchExternalInflationRates();
  const fetchedRates = external.rates;
  await saveToDatabase(fetchedRates, external.source);
  memoryCache = { rates: fetchedRates, timestamp: Date.now() };
  return {
    source: external.source,
    rates: fetchedRates,
  };
}

function scheduleBackgroundInflationRefresh() {
  if (backgroundRefreshPromise) return;

  backgroundRefreshPromise = (async () => {
    try {
      const result = await refreshFromExternalAndPersist();
      logger.debug('Belgian inflation background refresh completed', {
        source: result.source,
        count: result.rates.length,
      });
    } catch (error) {
      logStatbelFallbackWarning(error);
    } finally {
      backgroundRefreshPromise = null;
    }
  })();
}

/**
 * @param startMonth 'YYYY-MM'
 * @param endMonth 'YYYY-MM'
 */
async function loadFromDatabase(
  startMonth?: string,
  endMonth?: string,
): Promise<BelgianInflationRate[]> {
  const rows = await queryRows(
    belgianInflationMonthRowSchema,
    `SELECT month_date, monthly_rate
     FROM belgian_inflation_rates
     WHERE ($1::date IS NULL OR month_date >= $1::date)
       AND ($2::date IS NULL OR month_date <= $2::date)
     ORDER BY month_date ASC`,
    [startMonth ? `${startMonth}-01` : null, endMonth ? `${endMonth}-01` : null]
  );

  return rows
    .map((row) => ({
      month: monthKeyFromDatabaseValue(row.month_date),
      monthly_rate: Number(row.monthly_rate),
    }))
    .filter((row): row is BelgianInflationRate => Boolean(row.month));
}

// Postgres caps each query at 65535 bind parameters. With 3 params per row
// (month_date, monthly_rate, source), 1000 rows per chunk leaves headroom.
const INFLATION_INSERT_CHUNK = 1000;

async function saveToDatabase(
  rates: BelgianInflationRate[],
  source = 'statbel',
): Promise<void> {
  if (!Array.isArray(rates) || rates.length === 0) return;

  await withTransaction(async (client) => {
    for (let i = 0; i < rates.length; i += INFLATION_INSERT_CHUNK) {
      const chunk = rates.slice(i, i + INFLATION_INSERT_CHUNK);
      const params: (string | number)[] = [];
      const valueRows = chunk.map((rate, idx) => {
        const offset = idx * 3;
        params.push(`${rate.month}-01`, rate.monthly_rate, source);
        return `($${offset + 1}::date, $${offset + 2}, $${offset + 3})`;
      });

      await client.query(
        `INSERT INTO belgian_inflation_rates (month_date, monthly_rate, source)
         VALUES ${valueRows.join(', ')}
         ON CONFLICT (month_date)
         DO UPDATE SET
            monthly_rate = EXCLUDED.monthly_rate,
            source = EXCLUDED.source,
            fetched_at = NOW(),
            updated_at = NOW()`,
        params
      );
    }
  });
}

/**
 * @param startMonth 'YYYY-MM'
 * @param endMonth 'YYYY-MM'
 */
function filterRates(
  rates: BelgianInflationRate[],
  startMonth: string | undefined,
  endMonth: string | undefined,
): BelgianInflationRate[] {
  return rates.filter((rate) => {
    if (startMonth && rate.month < startMonth) return false;
    if (endMonth && rate.month > endMonth) return false;
    return true;
  });
}

export interface GetInflationRatesOptions {
  /** Any month-like value; normalised to 'YYYY-MM'. */
  startMonth?: unknown;
  endMonth?: unknown;
  forceRefresh?: boolean;
  dbOnly?: boolean;
  scheduleBackgroundRefresh?: boolean;
}

export async function getInflationRates({
  startMonth,
  endMonth,
  forceRefresh = false,
  dbOnly = false,
  scheduleBackgroundRefresh = false,
}: GetInflationRatesOptions = {}): Promise<InflationRatesResult> {
  const normalizedStart = normalizeMonthInput(startMonth);
  const normalizedEnd = normalizeMonthInput(endMonth);
  const forceRefreshMode = isTruthy(forceRefresh);
  const dbOnlyMode = !forceRefreshMode && isTruthy(dbOnly);
  const scheduleBackgroundRefreshMode = !forceRefreshMode && isTruthy(scheduleBackgroundRefresh);

  if (!forceRefreshMode && !dbOnlyMode && memoryCache && Date.now() - memoryCache.timestamp < CACHE_LIFETIME_MS) {
    return {
      source: 'memory',
      rates: filterRates(memoryCache.rates, normalizedStart, normalizedEnd),
    };
  }

  const dbRates = await loadFromDatabase(normalizedStart, normalizedEnd);
  if (!forceRefreshMode && dbRates.length > 0) {
    const allDbRates = await loadFromDatabase();
    memoryCache = { rates: allDbRates, timestamp: Date.now() };

    if (dbOnlyMode && scheduleBackgroundRefreshMode) {
      scheduleBackgroundInflationRefresh();
    }

    return { source: 'database', rates: dbRates };
  }

  if (dbOnlyMode) {
    if (scheduleBackgroundRefreshMode) {
      scheduleBackgroundInflationRefresh();
    }
    return { source: 'database', rates: dbRates };
  }

  try {
    const external = await refreshFromExternalAndPersist();
    return {
      source: external.source,
      rates: filterRates(external.rates, normalizedStart, normalizedEnd),
    };
  } catch (error) {
    logStatbelFallbackWarning(error);
    // Cache the *full* rate set, never a date-range-filtered subset — caching
    // the subset let a later wider-range call get a truncated cache hit.
    const allDbRates = await loadFromDatabase();
    memoryCache = { rates: allDbRates, timestamp: Date.now() };
    const fallbackRates = dbRates.length > 0
      ? dbRates
      : filterRates(allDbRates, normalizedStart, normalizedEnd);
    return { source: 'database', rates: fallbackRates };
  }
}

export async function warmInflationCache() {
  const result = await getInflationRates({
    dbOnly: true,
    scheduleBackgroundRefresh: true,
  });
  logger.info('Belgian inflation cache warm completed', { source: result.source, count: result.rates.length });
  return result;
}

export function clearInflationMemoryCache() {
  memoryCache = null;
  backgroundRefreshPromise = null;
  statbelFailureLogState = { lastWarnAt: 0, suppressed: 0 };
}

export default {
  getInflationRates,
  warmInflationCache,
  clearInflationMemoryCache,
};
