/**
 * Provider Health Service
 *
 * Manages health state for all external data providers.
 * Called by each provider service on success/error.
 * Supports on-demand probes for the admin UI.
 */

import { logger } from '../config/logger.js';
import providerHealthRepository from '../repositories/providerHealthRepository.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 10_000;

/** All known providers with their kind and a lightweight probe function. */
const PROVIDER_DEFINITIONS = {
  binance: {
    kind: 'price',
    label: 'Binance',
    probe: () => probeUrl('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'),
  },
  yahoo: {
    kind: 'price',
    label: 'Yahoo Finance',
    probe: () => probeYahoo(),
  },
  kinesis: {
    kind: 'price',
    label: 'Kinesis',
    probe: () => probeKinesis(),
  },
  ecb: {
    kind: 'fx',
    label: 'ECB',
    probe: () => probeUrl('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'),
  },
  'open.er-api': {
    kind: 'fx',
    label: 'open.er-api.com',
    probe: () => probeUrl('https://open.er-api.com/v6/latest/EUR'),
  },
  statbel: {
    kind: 'inflation',
    label: 'Statbel',
    probe: () => probeUrl(
      'https://bestat.statbel.fgov.be/bestat/api/views/86586e27-90ac-47c6-87ce-64b63194e605/result/JSON',
    ),
  },
  eurostat: {
    kind: 'inflation',
    label: 'Eurostat',
    probe: () => probeUrl(
      'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_midx?geo=BE&coicop=CP00&unit=I15',
    ),
  },
};

// ─── Probe helpers ────────────────────────────────────────────────────────────

async function probeUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function probeYahoo() {
  const { default: YahooFinance } = await import('yahoo-finance2');
  const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // yahoo-finance2 may not wire AbortSignal in all published versions;
    // race against a rejection promise to guarantee the timeout fires.
    await Promise.race([
      yf.quote('AAPL', { fields: ['regularMarketPrice'] }, { signal: controller.signal }),
      new Promise((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(new Error('Yahoo probe timed out')))
      ),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function probeKinesis() {
  // Kinesis may not be configured; treat missing base URL as probe failure.
  const { env } = await import('../config/env.js');
  const base = env.KINESIS_BASE_URL;
  if (!base) throw new Error('KINESIS_BASE_URL not configured');
  await probeUrl(`${base}/trendline?symbol=KAU_USD&timeframe=60&take=1`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a successful operation for a provider.
 * Call from provider services after a successful fetch.
 * @param {string} provider  Key from PROVIDER_DEFINITIONS
 */
export async function recordSuccess(provider) {
  const def = PROVIDER_DEFINITIONS[provider];
  if (!def) return;
  try {
    await providerHealthRepository.recordSuccess(provider, def.kind);
  } catch (err) {
    logger.debug('Failed to record provider success', { provider, error: err.message });
  }
}

/**
 * Record a failed operation for a provider.
 * Call from provider services after a fetch error.
 * @param {string} provider
 * @param {Error|string} error
 */
export async function recordError(provider, error) {
  const def = PROVIDER_DEFINITIONS[provider];
  if (!def) return;
  const message = error instanceof Error ? error.message : String(error);
  try {
    await providerHealthRepository.recordError(provider, def.kind, message);
  } catch (err) {
    logger.debug('Failed to record provider error', { provider, error: err.message });
  }
}

/**
 * Return health rows for all known providers, merging stored state with
 * PROVIDER_DEFINITIONS metadata (label, kind). Providers with no stored row
 * are returned with null timestamps.
 * @returns {Promise<Object[]>}
 */
export async function listProviderHealth() {
  const stored = await providerHealthRepository.listAll();
  const byKey = Object.fromEntries(stored.map((r) => [r.provider, r]));

  return Object.entries(PROVIDER_DEFINITIONS).map(([key, def]) => {
    const row = byKey[key];
    return {
      provider: key,
      label: def.label,
      kind: def.kind,
      last_success_at: row?.last_success_at ?? null,
      last_error_at: row?.last_error_at ?? null,
      last_error: row?.last_error ?? null,
      consecutive_failures: row?.consecutive_failures ?? 0,
      updated_at: row?.updated_at ?? null,
    };
  });
}

/**
 * Run an active probe for a single provider. Updates the DB record and returns
 * the result.
 * @param {string} provider
 * @returns {Promise<{ ok: boolean, error?: string, provider: Object }>}
 */
export async function probeProvider(provider) {
  const def = PROVIDER_DEFINITIONS[provider];
  if (!def) {
    throw Object.assign(new Error(`Unknown provider: ${provider}`), { status: 404 });
  }

  try {
    await def.probe();
    await providerHealthRepository.recordSuccess(provider, def.kind);
    logger.info('Provider probe succeeded', { provider });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await providerHealthRepository.recordError(provider, def.kind, message);
    logger.warn('Provider probe failed', { provider, error: message });
    const row = await providerHealthRepository.findByProvider(provider);
    return { ok: false, error: message, provider: enrichRow(provider, def, row) };
  }

  const row = await providerHealthRepository.findByProvider(provider);
  return { ok: true, provider: enrichRow(provider, def, row) };
}

function enrichRow(key, def, row) {
  return {
    provider: key,
    label: def.label,
    kind: def.kind,
    last_success_at: row?.last_success_at ?? null,
    last_error_at: row?.last_error_at ?? null,
    last_error: row?.last_error ?? null,
    consecutive_failures: row?.consecutive_failures ?? 0,
    updated_at: row?.updated_at ?? null,
  };
}

export { PROVIDER_DEFINITIONS };
