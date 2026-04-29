/**
 * Price Provider Service — thin orchestrator
 *
 * Delegates to:
 *   - prices/priceCache.js — in-memory TTL cache + DB persistence
 *   - prices/priceProviderRegistry.js — provider strategies (Binance, Yahoo, custom, Kinesis)
 */

import { logger } from '../config/logger.js';
import { recordSuccess as recordProviderSuccess, recordError as recordProviderError } from './providerHealthService.js';
import {
  cacheGet,
  cacheSet,
  loadHistoricalPointsFromDatabase,
  normalizeHistoryPoints,
  filterPointsByRange,
  needsHistoryRefresh,
  countChangedPointPrices,
  toNumber,
  isValidPrice,
} from './prices/priceCache.js';
import {
  PROVIDERS,
  resolveYahooSymbol,
  resolveCustomHistoryConfig,
  resolveKinesisConfig,
  sanitizeKinesisIsolatedSpikes,
  parseCustomHistoryPoints,
  yahooFinance,
} from './prices/priceProviderRegistry.js';

export {
  saveHistoricalPointsToDatabase,
  resetPriceCache as __resetPriceCache,
} from './prices/priceCache.js';

export { getHistoricalPriceAt } from './prices/priceProviderRegistry.js';

export const SUPPORTED_PROVIDERS = [
  { key: 'manual', name: 'Manual', description: 'Set price manually' },
  { key: 'binance', name: 'Binance', description: 'Free crypto prices (use symbol, e.g. "BTCUSDT", "ETHUSDT", "BNBEUR")' },
  { key: 'yahoo', name: 'Yahoo Finance', description: 'Stocks, ETFs & metals (use ticker, e.g. "AAPL", "VWCE.DE", "GC=F")' },
  { key: 'custom', name: 'Custom JSON', description: 'Any JSON endpoint with a configurable price path' },
  { key: 'kinesis', name: 'Kinesis', description: 'Precious metals & commodities (use symbol, e.g. "KAU_USD", "XAU_USD", "XAG_USD")' },
];

// ─── Live price fetching ──────────────────────────────────────────────────────

export async function fetchLivePrices(investments) {
  const detailed = await fetchLivePricesDetailed(investments);
  return Object.fromEntries(
    Object.entries(detailed).map(([id, data]) => [id, data.price])
  );
}

export async function fetchLivePricesDetailed(investments, { cachedPricesByInvestmentId = {} } = {}) {
  const results = {};
  const stale = { binance: [], yahoo: [], custom: [], kinesis: [] };

  for (const inv of investments) {
    const provider = inv.price_provider || 'manual';
    if (provider === 'manual') continue;

    const providerKey = provider === 'yahoo'
      ? resolveYahooSymbol(inv)
      : (inv.price_provider_id || '');
    if (!providerKey && provider !== 'custom' && provider !== 'kinesis') continue;

    const cacheKey = (provider === 'custom' || provider === 'kinesis')
      ? `${provider}:${inv.id}`
      : `${provider}:${providerKey}`;

    const cached = cacheGet(cacheKey);
    const cachedPrice = toNumber(cached?.price ?? cached);
    if (isValidPrice(cachedPrice)) {
      results[inv.id] = { price: cachedPrice, source: cached?.source || 'live' };
    } else if (stale[provider]) {
      stale[provider].push(inv);
    }
  }

  const providerTasks = [];

  if (stale.binance.length) {
    providerTasks.push((async () => {
      try {
        const ids = [...new Set(stale.binance.map(inv => (inv.price_provider_id || '').toUpperCase()).filter(Boolean))];
        const prices = await PROVIDERS.binance(ids);
        for (const inv of stale.binance) {
          const pid = (inv.price_provider_id || '').toUpperCase();
          if (prices[pid]) {
            results[inv.id] = { price: prices[pid].price, source: prices[pid].source || 'live' };
            cacheSet(`binance:${pid}`, { price: prices[pid].price, source: prices[pid].source || 'live' });
          }
        }
        recordProviderSuccess('binance');
      } catch (err) {
        logger.error('Binance batch fetch failed', { error: err.message });
        recordProviderError('binance', err);
      }
    })());
  }

  if (stale.yahoo.length) {
    providerTasks.push((async () => {
      try {
        const ids = [...new Set(stale.yahoo.map(resolveYahooSymbol).filter(Boolean))];
        const prices = await PROVIDERS.yahoo(ids);
        for (const inv of stale.yahoo) {
          const pid = resolveYahooSymbol(inv);
          if (prices[pid]) {
            results[inv.id] = { price: prices[pid].price, source: prices[pid].source || 'live' };
            cacheSet(`yahoo:${pid}`, { price: prices[pid].price, source: prices[pid].source || 'live' });
          }
        }
        recordProviderSuccess('yahoo');
      } catch (err) {
        logger.error('Yahoo Finance batch fetch failed', { error: err.message });
        recordProviderError('yahoo', err);
      }
    })());
  }

  if (stale.custom.length) {
    providerTasks.push((async () => {
      try {
        const prices = await PROVIDERS.custom(stale.custom);
        for (const inv of stale.custom) {
          const data = prices[inv.id];
          if (data !== undefined && isValidPrice(data.price)) {
            results[inv.id] = { price: data.price, source: 'live' };
            cacheSet(`custom:${inv.id}`, { price: data.price, source: 'live' });
          }
        }
        recordProviderSuccess('custom');
      } catch (err) {
        logger.error('Custom price fetch failed', { error: err.message });
        recordProviderError('custom', err);
      }
    })());
  }

  if (stale.kinesis.length) {
    providerTasks.push((async () => {
      try {
        const prices = await PROVIDERS.kinesis(stale.kinesis);
        for (const inv of stale.kinesis) {
          const data = prices[inv.id];
          if (data !== undefined && isValidPrice(data.price)) {
            results[inv.id] = { price: data.price, source: 'live' };
            cacheSet(`kinesis:${inv.id}`, { price: data.price, source: 'live' });
          }
        }
        recordProviderSuccess('kinesis');
      } catch (err) {
        logger.error('Kinesis price fetch failed', { error: err.message });
        recordProviderError('kinesis', err);
      }
    })());
  }

  if (providerTasks.length > 0) {
    await Promise.allSettled(providerTasks);
  }

  for (const inv of investments) {
    if (results[inv.id] !== undefined) continue;
    const cachedPrice = toNumber(cachedPricesByInvestmentId[inv.id]);
    if (isValidPrice(cachedPrice)) {
      results[inv.id] = { price: cachedPrice, source: 'cached' };
    }
  }

  // Final offline-safety fallback: pull the most recent persisted historical
  // price from `asset_price_history`. Prevents portfolio valuations from
  // silently dropping investments when both the live provider and the
  // in-memory/DB-warm caches are unavailable (e.g. machine offline).
  for (const inv of investments) {
    if (results[inv.id] !== undefined) continue;
    if ((inv.price_provider || 'manual') === 'manual') continue;

    try {
      const points = await loadHistoricalPointsFromDatabase(inv.id);
      if (Array.isArray(points) && points.length > 0) {
        const last = points[points.length - 1];
        const price = toNumber(last?.price);
        if (isValidPrice(price)) {
          results[inv.id] = {
            price,
            source: 'historical_fallback',
            stale_as_of_ms: Number.isFinite(last?.timestampMs) ? last.timestampMs : null,
          };
        }
      }
    } catch (err) {
      logger.warn('Historical price fallback failed', { investmentId: inv.id, error: err.message });
    }
  }

  return results;
}

// ─── Historical price fetching ────────────────────────────────────────────────

function _filterHistoricalPoints(points, fromMs, toMs) {
  return filterPointsByRange(points, { fromMs, toMs });
}

function _fallbackHistoricalPoints(cachedDbPoints, fromMs, toMs) {
  return _filterHistoricalPoints(cachedDbPoints, fromMs, toMs);
}

async function _persistAndResolve(investmentId, points, source, cachedDbPoints, { fromMs, toMs } = {}) {
  const { saveHistoricalPointsToDatabase } = await import('./prices/priceCache.js');
  // Only persist points within the requested range — providers (Yahoo, Binance, Kinesis)
  // return data beyond the window bounds, which would otherwise accumulate and be deleted
  // by cleanupStaleQuotes on every restart.
  const pointsInRange = _filterHistoricalPoints(points, fromMs, toMs);
  await saveHistoricalPointsToDatabase(investmentId, pointsInRange, source);
  const persisted = await loadHistoricalPointsFromDatabase(investmentId, { fromMs, toMs });
  const resolved = persisted.length > 0
    ? persisted
    : normalizeHistoryPoints([...(cachedDbPoints || []), ...(pointsInRange || [])]);
  return _filterHistoricalPoints(resolved, fromMs, toMs);
}

export async function fetchHistoricalPrices(investment, { fromMs, toMs, dbOnly = false } = {}) {
  if (!investment) return [];
  const provider = investment.price_provider || 'manual';
  const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : undefined;
  const to = Number.isFinite(Number(toMs)) ? Number(toMs) : undefined;
  const dbOnlyMode = dbOnly === true || dbOnly === 'true' || dbOnly === 1 || dbOnly === '1';

  const cachedDbPoints = await loadHistoricalPointsFromDatabase(investment.id, { fromMs: from, toMs: to });

  if (dbOnlyMode) {
    if (provider === 'kinesis') {
      return _filterHistoricalPoints(sanitizeKinesisIsolatedSpikes(cachedDbPoints), from, to);
    }
    return _filterHistoricalPoints(cachedDbPoints, from, to);
  }

  if (!needsHistoryRefresh(cachedDbPoints, { fromMs: from, toMs: to })) {
    if (provider === 'kinesis') {
      const sanitized = sanitizeKinesisIsolatedSpikes(cachedDbPoints);
      const changed = countChangedPointPrices(cachedDbPoints, sanitized);
      if (changed > 0) {
        const { saveHistoricalPointsToDatabase } = await import('./prices/priceCache.js');
        await saveHistoricalPointsToDatabase(investment.id, sanitized, 'kinesis');
      }
      return _filterHistoricalPoints(sanitized, from, to);
    }
    return _filterHistoricalPoints(cachedDbPoints, from, to);
  }

  if (provider === 'yahoo') {
    const symbol = resolveYahooSymbol(investment);
    if (!symbol) return [];

    const cacheKey = `yahoo-history:${symbol}`;
    const cached = cacheGet(cacheKey);
    let points = Array.isArray(cached?.points) ? cached.points : undefined;

    if (!points) {
      try {
        const chart = await yahooFinance.chart(symbol, {
          period1: new Date(from || (Date.now() - 5 * 365 * 24 * 60 * 60 * 1000)),
          interval: '1d',
          includePrePost: false,
        });

        points = normalizeHistoryPoints((chart?.quotes || [])
          .map((q) => ({
            timestampMs: q?.date ? new Date(q.date).getTime() : Number.NaN,
            price: toNumber(q?.close),
          }))
          .filter((p) => Number.isFinite(p.timestampMs) && isValidPrice(p.price)));

        cacheSet(cacheKey, { points, source: 'live' });
      } catch (err) {
        logger.warn(`Yahoo history fetch error for ${symbol}: ${err.message}`);
        return _fallbackHistoricalPoints(cachedDbPoints, from, to);
      }
    }

    return _persistAndResolve(investment.id, points, 'yahoo', cachedDbPoints, { fromMs: from, toMs: to });
  }

  if (provider === 'binance') {
    const symbol = (investment.price_provider_id || '').trim().toUpperCase();
    if (!symbol) return [];

    let days = 365;
    if (from) {
      const daysDiff = Math.ceil((Date.now() - from) / (24 * 60 * 60 * 1000));
      if (daysDiff > 0) days = Math.min(daysDiff, 365);
    }

    const KNOWN_QUOTE_SUFFIXES = ['EUR', 'USDT', 'USDC', 'BUSD', 'BTC', 'ETH'];
    const hasKnownQuote = KNOWN_QUOTE_SUFFIXES.some((suffix) => symbol.endsWith(suffix));
    const binanceSymbol = hasKnownQuote ? symbol : `${symbol}USDT`;
    const cacheKey = `binance-history:${symbol}:${days}`;
    const cached = cacheGet(cacheKey);
    let points = Array.isArray(cached?.points) ? cached.points : undefined;

    if (!points) {
      try {
        const url = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(binanceSymbol)}&interval=1d&limit=${days}`;
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
        const data = await res.json();

        points = normalizeHistoryPoints((Array.isArray(data) ? data : [])
          .map((kline) => ({
            timestampMs: Number(kline[0]),
            price: toNumber(kline[4]),
          }))
          .filter((p) => Number.isFinite(p.timestampMs) && isValidPrice(p.price)));

        cacheSet(cacheKey, { points, source: 'live' });
      } catch (err) {
        logger.warn(`Binance history fetch error for ${symbol}: ${err.message}`);
        return _fallbackHistoricalPoints(cachedDbPoints, from, to);
      }
    }

    return _persistAndResolve(investment.id, points, 'binance', cachedDbPoints, { fromMs: from, toMs: to });
  }

  if (provider === 'kinesis') {
    const { symbol, timeframe, fromDate } = resolveKinesisConfig(investment);

    if (!symbol) {
      logger.warn(`Kinesis history: no symbol configured for investment ${investment.id}`);
      return _fallbackHistoricalPoints(cachedDbPoints, from, to);
    }

    const cacheKey = `kinesis-history:${symbol}:${timeframe}`;
    const cached = cacheGet(cacheKey);
    let points = Array.isArray(cached?.points) ? cached.points : undefined;

    if (!points) {
      try {
        const url = `${(await import('../config/kinesisConfig.js')).KINESIS_BASE_URL}?symbolIds=${encodeURIComponent(symbol)}&timeFrame=${timeframe}&fromDate=${fromDate}`;
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          logger.warn(`Kinesis history API error: ${res.status} for ${symbol}`);
          return _fallbackHistoricalPoints(cachedDbPoints, from, to);
        }

        const data = await res.json();
        const rawPoints = data?.[symbol];
        if (!Array.isArray(rawPoints)) {
          logger.warn(`Kinesis history: invalid data for ${symbol}`);
          return _fallbackHistoricalPoints(cachedDbPoints, from, to);
        }

        const { _parseKinesisTrendlinePoints } = await import('./prices/priceProviderRegistry.js');
        points = _parseKinesisTrendlinePoints(rawPoints);
        cacheSet(cacheKey, { points, source: 'live' });
      } catch (err) {
        logger.warn(`Kinesis history fetch error for ${symbol}: ${err.message}`);
        return _fallbackHistoricalPoints(cachedDbPoints, from, to);
      }
    }

    return _persistAndResolve(investment.id, points, 'kinesis', cachedDbPoints, { fromMs: from, toMs: to });
  }

  if (provider !== 'custom') {
    return _fallbackHistoricalPoints(cachedDbPoints, from, to);
  }

  const config = resolveCustomHistoryConfig(investment);
  if (!config.historyUrl) return [];

  const cacheKey = `custom-history:${investment.id}:${config.historyUrl}:${config.historyPath}:${config.timestampPath}:${config.pricePath}`;
  const cached = cacheGet(cacheKey);
  let points = Array.isArray(cached?.points) ? cached.points : undefined;

  if (!points) {
    try {
      const res = await fetch(config.historyUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      points = normalizeHistoryPoints(parseCustomHistoryPoints(data, config));
      cacheSet(cacheKey, { points, source: 'live' });
    } catch (err) {
      logger.warn(`Custom history fetch error for investment ${investment.id}: ${err.message}`);
      return _fallbackHistoricalPoints(cachedDbPoints, from, to);
    }
  }

  return _persistAndResolve(investment.id, points, 'custom', cachedDbPoints, { fromMs: from, toMs: to });
}

// ─── Kinesis DB sanitization ──────────────────────────────────────────────────

export async function sanitizePersistedKinesisHistory() {
  const investmentsResult = await (await import('../database/connection.js')).query(
    `SELECT id FROM investments WHERE price_provider = 'kinesis'`,
    []
  );

  const investments = investmentsResult.rows || [];
  if (investments.length === 0) {
    logger.info('Kinesis history sanitization skipped: no kinesis investments');
    return { processed: 0, updated: 0, correctedPoints: 0, failed: 0 };
  }

  const { saveHistoricalPointsToDatabase } = await import('./prices/priceCache.js');
  let updated = 0;
  let correctedPoints = 0;
  let failed = 0;

  for (const investment of investments) {
    try {
      const points = await loadHistoricalPointsFromDatabase(investment.id);
      if (!Array.isArray(points) || points.length < 3) continue;

      const sanitized = sanitizeKinesisIsolatedSpikes(points);
      const changed = countChangedPointPrices(points, sanitized);
      if (changed > 0) {
        await saveHistoricalPointsToDatabase(investment.id, sanitized, 'kinesis');
        updated += 1;
        correctedPoints += changed;
      }
    } catch (error) {
      failed += 1;
      logger.warn('Kinesis history sanitization failed for investment', {
        investmentId: investment.id,
        error: error?.message,
      });
    }
  }

  const sanitizationStats = { processed: investments.length, updated, correctedPoints, failed };
  if (correctedPoints > 0 || failed > 0) {
    logger.info('Kinesis history sanitization complete', sanitizationStats);
  } else {
    logger.debug('Kinesis history sanitization complete', sanitizationStats);
  }

  return { processed: investments.length, updated, correctedPoints, failed };
}
