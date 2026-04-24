import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';
import { recordSuccess as recordProviderSuccess, recordError as recordProviderError } from './providerHealthService.js';

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

let memoryCache = null; // { rates: Array<{ month: string, monthly_rate: number }>, timestamp: number }
let statbelFailureLogState = { lastWarnAt: 0, suppressed: 0 };
let backgroundRefreshPromise = null;

function isTruthy(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logStatbelFallbackWarning(error) {
  const now = Date.now();
  if (now - statbelFailureLogState.lastWarnAt >= STATBEL_WARN_THROTTLE_MS) {
    logger.warn('Failed to fetch external inflation rates; falling back to database', {
      error: error?.message,
      suppressed_since_last_warning: statbelFailureLogState.suppressed,
    });
    statbelFailureLogState = { lastWarnAt: now, suppressed: 0 };
    return;
  }

  statbelFailureLogState.suppressed += 1;
  logger.debug('External inflation fetch failed; warning suppressed during throttle window', {
    error: error?.message,
    suppressed: statbelFailureLogState.suppressed,
  });
}

function normalizeMonthInput(value) {
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

function monthKeyFromDatabaseValue(value) {
  if (value === null || value === undefined) return undefined;

  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 7);
  }

  const normalized = normalizeMonthInput(value);
  if (normalized) return normalized;

  const parsed = new Date(value);
  if (Number.isFinite(parsed.getTime())) {
    return parsed.toISOString().slice(0, 7);
  }

  return undefined;
}

function parseNumeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const sanitized = value.replace(',', '.').replace(/[^0-9.+-]/g, '').trim();
  if (!sanitized) return undefined;
  const parsed = Number(sanitized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const MONTH_NAME_TO_NUMBER = {
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
  december: 12, dec: 12, december: 12, decembre: 12, décembre: 12,
};

function parseMonthName(value) {
  if (!value) return undefined;
  const normalized = String(value).trim().toLowerCase();
  return MONTH_NAME_TO_NUMBER[normalized];
}

function parseMonthFromRow(row) {
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

  if (!Number.isFinite(year)) return undefined;

  const monthNumber = parseNumeric(rawMonth) ?? parseMonthName(rawMonth);
  if (!Number.isFinite(monthNumber) || monthNumber < 1 || monthNumber > 12) return undefined;

  return `${Math.trunc(year)}-${String(Math.trunc(monthNumber)).padStart(2, '0')}`;
}

function parseMonthlyRateFromRow(row) {
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

  let rawValue;
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
  if (!Number.isFinite(parsed)) return undefined;

  // Accept both decimal form (0.0025) and percentage form (0.25 or 2.5).
  // Belgian monthly inflation is expected to be in low single-digit percentages.
  if (Math.abs(parsed) > 1) return parsed / 100;
  if (Math.abs(parsed) > 0.05) return parsed / 100;
  return parsed;
}

function extractObjectRows(payload) {
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => extractObjectRows(item));
  }

  if (!payload || typeof payload !== 'object') return [];

  const values = Object.values(payload);
  const objectValues = values.filter((value) => value && typeof value === 'object');

  const looksLikeRow = Object.values(payload).some((value) => ['string', 'number'].includes(typeof value));
  const nestedRows = objectValues.flatMap((value) => extractObjectRows(value));

  return looksLikeRow ? [payload, ...nestedRows] : nestedRows;
}

function normalizeRatesFromPayload(payload) {
  const rows = extractObjectRows(payload);
  const byMonth = new Map();

  for (const row of rows) {
    const month = parseMonthFromRow(row);
    const monthlyRate = parseMonthlyRateFromRow(row);
    if (!month || !Number.isFinite(monthlyRate)) continue;
    byMonth.set(month, {
      month,
      monthly_rate: Math.round(monthlyRate * 1_000_000) / 1_000_000,
    });
  }

  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

function parseStatbelMonthString(value) {
  if (!value) return undefined;
  const parts = String(value).trim().split(/\s+/);
  if (parts.length < 2) return undefined;
  const monthNum = MONTH_NAME_TO_NUMBER[parts[0].toLowerCase()];
  const year = parseNumeric(parts[parts.length - 1]);
  if (!monthNum || !Number.isFinite(year) || year < 1900 || year > 2100) return undefined;
  return `${Math.trunc(year)}-${String(monthNum).padStart(2, '0')}`;
}

function normalizeRatesFromStatbelPayload(payload) {
  const facts = payload?.facts;
  if (!Array.isArray(facts) || facts.length === 0) return [];

  const globalRows = facts.filter((row) => row['Level 1'] === null || row['Level 1'] === undefined);
  const indexed = globalRows
    .map((row) => {
      const month = parseStatbelMonthString(row['Month']);
      const cpi = parseNumeric(row['Consumer price index']);
      return month && Number.isFinite(cpi) && cpi > 0 ? { month, cpi } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.month.localeCompare(b.month));

  if (indexed.length < 2) return [];

  const rates = [];
  for (let i = 1; i < indexed.length; i += 1) {
    const prev = indexed[i - 1];
    const curr = indexed[i];
    const monthlyRate = (curr.cpi / prev.cpi) - 1;
    if (!Number.isFinite(monthlyRate) || Math.abs(monthlyRate) > 1) continue;
    rates.push({ month: curr.month, monthly_rate: Math.round(monthlyRate * 1_000_000) / 1_000_000 });
  }

  return rates;
}

function normalizeRatesFromEurostatIndexPayload(payload) {
  const timeIndex = payload?.dimension?.time?.category?.index;
  const values = payload?.value;
  if (!timeIndex || typeof timeIndex !== 'object' || !values || typeof values !== 'object') return [];

  const sortedTimeline = Object.entries(timeIndex)
    .map(([rawMonth, rawIndex]) => ({
      month: normalizeMonthInput(rawMonth),
      index: parseNumeric(rawIndex),
    }))
    .filter((item) => item.month && Number.isFinite(item.index))
    .sort((a, b) => a.index - b.index);

  if (sortedTimeline.length < 2) return [];

  const monthlyIndex = [];
  for (const item of sortedTimeline) {
    const rawValue = values[item.index] ?? values[String(item.index)];
    const indexValue = parseNumeric(rawValue);
    if (!Number.isFinite(indexValue) || indexValue <= 0) continue;
    monthlyIndex.push({ month: item.month, indexValue });
  }

  if (monthlyIndex.length < 2) return [];

  const rates = [];
  for (let i = 1; i < monthlyIndex.length; i += 1) {
    const previous = monthlyIndex[i - 1];
    const current = monthlyIndex[i];
    if (!previous || !current) continue;

    const monthlyRate = (current.indexValue / previous.indexValue) - 1;
    if (!Number.isFinite(monthlyRate) || Math.abs(monthlyRate) > 1) continue;

    rates.push({
      month: current.month,
      monthly_rate: Math.round(monthlyRate * 1_000_000) / 1_000_000,
    });
  }

  return rates;
}

async function fetchFromStatbel() {
  const fetchWithRetries = async (url) => {
    let lastError;

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
            logger.info('Fetched Belgian inflation rates from Statbel', { url, count: rates.length, attempt: attempt + 1 });
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

  let lastError;
  for (const url of STATBEL_CANDIDATE_URLS) {
    try {
      return await fetchWithRetries(url);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('Failed to fetch Belgian inflation rates from Statbel');
}

async function fetchFromEurostat() {
  let lastError;

  for (let attempt = 0; attempt <= STATBEL_MAX_RETRIES_PER_URL; attempt += 1) {
    try {
      const response = await fetch(EUROSTAT_HICP_INDEX_URL, { signal: AbortSignal.timeout(STATBEL_REQUEST_TIMEOUT_MS) });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} from Eurostat HICP endpoint`);
      } else {
        const payload = await response.json();
        const rates = normalizeRatesFromEurostatIndexPayload(payload);
        if (rates.length > 0) {
          logger.info('Fetched Belgian inflation rates from Eurostat HICP index', {
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
    logger.debug('Statbel inflation fetch failed; trying Eurostat fallback', { error: statbelError?.message });
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
      logger.info('Belgian inflation background refresh completed', {
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

async function loadFromDatabase(startMonth, endMonth) {
  const result = await query(
    `SELECT month_date, monthly_rate
     FROM belgian_inflation_rates
     WHERE ($1::date IS NULL OR month_date >= $1::date)
       AND ($2::date IS NULL OR month_date <= $2::date)
     ORDER BY month_date ASC`,
    [startMonth ? `${startMonth}-01` : null, endMonth ? `${endMonth}-01` : null]
  );

  return result.rows
    .map((row) => ({
      month: monthKeyFromDatabaseValue(row.month_date),
      monthly_rate: Number(row.monthly_rate),
    }))
    .filter((row) => row.month);
}

async function saveToDatabase(rates, source = 'statbel') {
  if (!Array.isArray(rates) || rates.length === 0) return;

  await query('BEGIN');
  try {
    for (const rate of rates) {
      await query(
        `INSERT INTO belgian_inflation_rates (month_date, monthly_rate, source)
         VALUES ($1::date, $2, $3)
         ON CONFLICT (month_date)
         DO UPDATE SET
            monthly_rate = EXCLUDED.monthly_rate,
            source = EXCLUDED.source,
            fetched_at = NOW(),
            updated_at = NOW()`,
        [`${rate.month}-01`, rate.monthly_rate, source]
      );
    }
    await query('COMMIT');
  } catch (error) {
    await query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function filterRates(rates, startMonth, endMonth) {
  return rates.filter((rate) => {
    if (startMonth && rate.month < startMonth) return false;
    if (endMonth && rate.month > endMonth) return false;
    return true;
  });
}

export async function getInflationRates({
  startMonth,
  endMonth,
  forceRefresh = false,
  dbOnly = false,
  scheduleBackgroundRefresh = false,
} = {}) {
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
    const fallbackRates = dbRates.length > 0 ? dbRates : await loadFromDatabase(normalizedStart, normalizedEnd);
    memoryCache = { rates: fallbackRates, timestamp: Date.now() };
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
