/**
 * Price Provider Service
 * Fetches live prices from CoinGecko, Yahoo Finance, Kraken, or custom JSON endpoints.
 */

import { logger } from '../config/logger.js';
import YahooFinance from 'yahoo-finance2';
import { query } from '../database/connection.js';
import {
  KINESIS_BASE_URL,
  KINESIS_DEFAULT_TIMEFRAME,
  KINESIS_DEFAULT_FROM_DATE,
  getKinesisAssetConfig,
} from '../config/kinesisConfig.js';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ─── In-process price cache (5-minute TTL) ───────────────────────────────────
// Key: `${provider}:${providerId}` — Value: { data, expiresAt }
const PRICE_CACHE_TTL_MS = 5 * 60_000;
const HISTORY_DAY_MS = 24 * 60 * 60 * 1000;
const _priceCache = new Map();

function _toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function _isValidPrice(value) {
  const num = _toNumber(value);
  return num !== undefined && num > 0;
}

function _resolveYahooSymbol(inv) {
  const providerId = (inv?.price_provider_id || '').trim();
  if (providerId) return providerId.toUpperCase();
  const symbol = (inv?.symbol || '').trim();
  if (symbol) return symbol.toUpperCase();
  return '';
}

function _cacheGet(key) {
  const entry = _priceCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { _priceCache.delete(key); return undefined; }
  return entry.data;
}

function _cacheSet(key, data) {
  _priceCache.set(key, { data, expiresAt: Date.now() + PRICE_CACHE_TTL_MS });
}

function _toDateOnly(timestampMs) {
  if (!Number.isFinite(timestampMs)) return undefined;
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function _dateOnlyToTimestampMs(dateOnly) {
  if (!dateOnly) return Number.NaN;
  const [y, m, d] = String(dateOnly).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return Number.NaN;
  return Date.UTC(y, m - 1, d, 12, 0, 0, 0);
}

function _normalizeHistoryPoints(points) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const byDate = new Map();

  for (const point of points) {
    const timestampMs = Number(point?.timestampMs);
    const price = _toNumber(point?.price);
    if (!Number.isFinite(timestampMs) || !_isValidPrice(price)) continue;
    const dateOnly = _toDateOnly(timestampMs);
    if (!dateOnly) continue;
    byDate.set(dateOnly, {
      timestampMs: _dateOnlyToTimestampMs(dateOnly),
      price,
    });
  }

  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, point]) => point);
}

function _median(values) {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function _sanitizeKinesisIsolatedSpikes(points) {
  if (!Array.isArray(points) || points.length < 5) return points || [];

  const sanitized = points.map((p) => ({ ...p }));

  const logReturns = [];
  for (let i = 1; i < sanitized.length; i += 1) {
    const prev = _toNumber(sanitized[i - 1]?.price);
    const current = _toNumber(sanitized[i]?.price);
    if (!_isValidPrice(prev) || !_isValidPrice(current)) continue;
    logReturns.push(Math.log(current / prev));
  }

  if (logReturns.length < 4) return sanitized;

  const medianReturn = _median(logReturns) ?? 0;
  const absDeviations = logReturns.map(r => Math.abs(r - medianReturn));
  const mad = _median(absDeviations) ?? 0;
  const robustSigma = Math.max(1.4826 * mad, 0.0015); // floor ~= 0.15% move

  const spikeThreshold = 6 * robustSigma;
  const bridgeThreshold = 4 * robustSigma;
  const minSpikeMove = Math.log(1.18); // require at least 18% jump/drop
  const localNeedleNeighborTolerance = Math.log(1.12); // neighbors should remain within ~12%
  const localNeedleRatio = 1.8; // point should be >=1.8x (or <=~55%) of both neighbors

  for (let i = 1; i < sanitized.length - 1; i += 1) {
    const prev = _toNumber(sanitized[i - 1]?.price);
    const current = _toNumber(sanitized[i]?.price);
    const next = _toNumber(sanitized[i + 1]?.price);
    if (!_isValidPrice(prev) || !_isValidPrice(current) || !_isValidPrice(next)) continue;

    const jump = Math.log(current / prev);
    const revert = Math.log(next / current);
    const bridge = Math.log(next / prev);

    const hasLargeJump = Math.abs(jump - medianReturn) > spikeThreshold && Math.abs(jump) > minSpikeMove;
    const hasLargeRevert = Math.abs(revert - medianReturn) > spikeThreshold && Math.abs(revert) > minSpikeMove;
    const oppositeDirections = (jump > 0 && revert < 0) || (jump < 0 && revert > 0);
    const bridgeLooksNormal = Math.abs(bridge - medianReturn) <= bridgeThreshold;

    const maxNeighbor = Math.max(prev, next);
    const minNeighbor = Math.min(prev, next);
    const localNeedlePeak = current >= maxNeighbor * localNeedleRatio
      && Math.abs(bridge) <= localNeedleNeighborTolerance;
    const localNeedleTrough = current * localNeedleRatio <= minNeighbor
      && Math.abs(bridge) <= localNeedleNeighborTolerance;

    const robustNeedle = hasLargeJump && hasLargeRevert && oppositeDirections && bridgeLooksNormal;

    if (robustNeedle || localNeedlePeak || localNeedleTrough) {
      sanitized[i].price = Math.sqrt(prev * next);
    }
  }

  return sanitized;
}

function _parseKinesisTrendlinePoints(rawPoints) {
  if (!Array.isArray(rawPoints)) return [];

  const points = [];
  for (const point of rawPoints) {
    const createdAt = point?.createdAt;
    const price = _toNumber(point?.price);

    if (!createdAt || !_isValidPrice(price)) continue;

    const timestampMs = new Date(createdAt).getTime();
    if (!Number.isFinite(timestampMs)) continue;
    points.push({ timestampMs, price });
  }

  points.sort((a, b) => a.timestampMs - b.timestampMs);
  return _sanitizeKinesisIsolatedSpikes(points);
}

function _countChangedPointPrices(beforePoints, afterPoints) {
  if (!Array.isArray(beforePoints) || !Array.isArray(afterPoints)) return 0;
  const len = Math.min(beforePoints.length, afterPoints.length);
  let changed = 0;
  for (let i = 0; i < len; i += 1) {
    const beforePrice = _toNumber(beforePoints[i]?.price);
    const afterPrice = _toNumber(afterPoints[i]?.price);
    if (!_isValidPrice(beforePrice) || !_isValidPrice(afterPrice)) continue;
    if (Math.abs(beforePrice - afterPrice) > 1e-9) changed += 1;
  }
  return changed;
}

function _filterPointsByRange(points, { fromMs, toMs } = {}) {
  const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : undefined;
  const to = Number.isFinite(Number(toMs)) ? Number(toMs) : undefined;

  return (Array.isArray(points) ? points : []).filter((p) => {
    if (from !== undefined && p.timestampMs < from) return false;
    if (to !== undefined && p.timestampMs > to) return false;
    return true;
  });
}

function _needsHistoryRefresh(points, { fromMs, toMs } = {}) {
  const normalized = _normalizeHistoryPoints(points);
  if (normalized.length === 0) return true;

  const firstTs = normalized[0]?.timestampMs;
  const lastTs = normalized[normalized.length - 1]?.timestampMs;
  if (!Number.isFinite(firstTs) || !Number.isFinite(lastTs)) return true;

  const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : undefined;
  const to = Number.isFinite(Number(toMs)) ? Number(toMs) : undefined;

  if (from !== undefined && firstTs > from + HISTORY_DAY_MS) return true;
  if (to !== undefined && lastTs < to - HISTORY_DAY_MS) return true;
  return false;
}

async function _loadHistoricalPointsFromDatabase(investmentId, { fromMs, toMs } = {}) {
  if (!Number.isFinite(Number(investmentId))) return [];
  const fromDate = Number.isFinite(Number(fromMs)) ? _toDateOnly(Number(fromMs)) : null;
  const toDate = Number.isFinite(Number(toMs)) ? _toDateOnly(Number(toMs)) : null;

  try {
    const result = await query(
      `SELECT price_date, close_price
       FROM asset_price_history
       WHERE investment_id = $1
         AND ($2::date IS NULL OR price_date >= $2::date)
         AND ($3::date IS NULL OR price_date <= $3::date)
       ORDER BY price_date ASC`,
      [Number(investmentId), fromDate, toDate]
    );

    return _normalizeHistoryPoints(
      result.rows.map((row) => ({
        timestampMs: _dateOnlyToTimestampMs(row.price_date),
        price: _toNumber(row.close_price),
      }))
    );
  } catch (error) {
    if (error?.code === '42P01') {
      return [];
    }
    throw error;
  }
}

async function _saveHistoricalPointsToDatabase(investmentId, points, source) {
  const normalized = _normalizeHistoryPoints(points);
  if (!Number.isFinite(Number(investmentId)) || normalized.length === 0) return;

  const priceDates = [];
  const closePrices = [];

  for (const point of normalized) {
    const dateOnly = _toDateOnly(point.timestampMs);
    if (!dateOnly || !_isValidPrice(point.price)) continue;
    priceDates.push(dateOnly);
    closePrices.push(point.price);
  }

  if (priceDates.length === 0) return;

  const upsertSql = `INSERT INTO asset_price_history (investment_id, price_date, close_price, source)
     SELECT $1, p.price_date::date, p.close_price::numeric, $2
     FROM UNNEST($3::date[], $4::numeric[]) AS p(price_date, close_price)
     ON CONFLICT (investment_id, price_date)
     DO UPDATE SET
       close_price = EXCLUDED.close_price,
       source = EXCLUDED.source,
       fetched_at = NOW(),
       updated_at = NOW()`;
  const upsertArgs = [Number(investmentId), source || 'provider', priceDates, closePrices];

  try {
    await query(upsertSql, upsertArgs);
  } catch (error) {
    if (error?.code === '42P01') return;
    if (error?.code === '23503' && error?.constraint === 'fk_asset_price_history_investment') {
      await _dropAssetPriceHistoryForeignKey();
      await query(upsertSql, upsertArgs);
      return;
    }
    throw error;
  }
}

async function _dropAssetPriceHistoryForeignKey() {
  try {
    await query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_constraint c
          WHERE c.conname = 'fk_asset_price_history_investment'
            AND c.conrelid = 'asset_price_history'::regclass
        ) THEN
          ALTER TABLE asset_price_history
            DROP CONSTRAINT fk_asset_price_history_investment;
        END IF;
      END $$;
    `);
  } catch (error) {
    logger.warn('Failed to drop asset price history FK constraint', { error: error?.message });
  }
}

function _splitPath(path) {
  if (typeof path !== 'string') return [];
  return path
    .trim()
    .split('.')
    .map(seg => seg.trim())
    .filter(Boolean);
}

function _readPathValue(input, path) {
  const segments = _splitPath(path);
  if (segments.length === 0) return input;
  let value = input;
  for (const segment of segments) {
    if (value === undefined || value === null) return undefined;
    value = value[segment];
  }
  return value;
}

function _resolveCustomLatestConfig(inv) {
  const latestUrl = (inv?.price_provider_latest_url || inv?.price_provider_url || inv?.price_provider_history_url || '').trim();
  const latestPath = (inv?.price_provider_latest_path || inv?.price_provider_id || 'price').trim();
  return { latestUrl, latestPath };
}

function _resolveCustomHistoryConfig(inv) {
  const historyUrl = (inv?.price_provider_history_url || inv?.price_provider_latest_url || inv?.price_provider_url || '').trim();
  const historyPath = (inv?.price_provider_history_path || 'points').trim();
  const timestampPath = (inv?.price_provider_history_ts_path || 'timestamp_ms').trim();
  const pricePath = (inv?.price_provider_history_price_path || 'price').trim();
  return {
    historyUrl,
    historyPath,
    timestampPath,
    pricePath,
  };
}

function _resolveKinesisConfig(inv) {
  const providerId = (inv?.price_provider_id || '').trim();
  const assetName = (inv?.name || inv?.symbol || '').toLowerCase().trim();

  let symbol = providerId;
  let timeframe = KINESIS_DEFAULT_TIMEFRAME;
  let fromDate = KINESIS_DEFAULT_FROM_DATE;

  if (!symbol) {
    const assetConfig = getKinesisAssetConfig(assetName);
    if (assetConfig) {
      symbol = assetConfig.symbol;
      timeframe = assetConfig.timeframe || KINESIS_DEFAULT_TIMEFRAME;
      fromDate = assetConfig.fromDate || KINESIS_DEFAULT_FROM_DATE;
    }
  }

  return { symbol, timeframe, fromDate };
}

async function _fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

function _parseCustomHistoryPoints(data, config) {
  const listValue = _readPathValue(data, config.historyPath);
  if (!Array.isArray(listValue)) return [];

  const points = [];
  for (const row of listValue) {
    const tsRaw = _readPathValue(row, config.timestampPath);
    const priceRaw = _readPathValue(row, config.pricePath);
    const timestampMs = Number(tsRaw);
    const price = Number(priceRaw);
    if (!Number.isFinite(timestampMs) || !Number.isFinite(price) || price <= 0) continue;
    points.push({ timestampMs, price });
  }

  points.sort((a, b) => a.timestampMs - b.timestampMs);
  return points;
}

function _deriveLatestPriceFromHistoryPayload(data, historyConfig) {
  const points = _parseCustomHistoryPoints(data, historyConfig);
  if (!points.length) return undefined;
  return points[points.length - 1]?.price;
}

export function getHistoricalPriceAt(points, timestampMs) {
  if (!Array.isArray(points) || points.length === 0) return undefined;

  let left = 0;
  let right = points.length - 1;
  let best;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const p = points[mid];
    if (!p) break;
    if (p.timestampMs <= timestampMs) {
      best = p;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return best?.price;
}

async function _fetchYahooLatestClose(symbol) {
  const chart = await yahooFinance.chart(symbol, {
    period1: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    interval: '1d',
    includePrePost: false,
  });
  const quotes = chart?.quotes || [];

  for (let i = quotes.length - 1; i >= 0; i -= 1) {
    const close = _toNumber(quotes[i]?.close);
    if (_isValidPrice(close)) return close;
  }

  return undefined;
}
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDERS = {
  /**
   * Binance — free public API, no key required.
   * price_provider_id = Binance symbol, e.g. "BTCUSDT", "ETHUSDT", "BNBEUR"
   */
  async binance(providerIds) {
    const symbols = providerIds.map(id => (id || '').toUpperCase());
    const uniqueSymbols = [...new Set(symbols)].filter(Boolean);
    if (uniqueSymbols.length === 0) return {};

    const prices = {};
    try {
      // Fetch all prices in one call
      const url = `https://data-api.binance.vision/api/v3/ticker/price`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
      const data = await res.json();

      // Create a map of symbol -> price
      const priceMap = {};
      for (const item of data) {
        if (item.symbol && item.price) {
          priceMap[item.symbol] = parseFloat(item.price);
        }
      }

      // Match requested symbols
      for (const symbol of uniqueSymbols) {
        if (priceMap[symbol] !== undefined) {
          prices[symbol] = {
            price: priceMap[symbol],
            currency: symbol.endsWith('EUR') ? 'EUR' : 'USD',
            source: 'live',
          };
        }
      }
    } catch (err) {
      logger.warn(`Binance fetch failed: ${err.message}`);
    }
    return prices;
  },

  /**
   * Yahoo Finance — uses the free query API.
   * price_provider_id = ticker symbol, e.g. "AAPL", "MSFT", "VWCE.DE"
   */
  async yahoo(providerIds) {
    const prices = {};
    const resolved = new Set();
    await Promise.all(providerIds.map(async (providerId) => {
      const symbol = (providerId || '').toUpperCase();
      if (!symbol) return;

      try {
        const quote = await yahooFinance.quote(symbol);
        const livePrice = _toNumber(quote?.regularMarketPrice);
        const previousClose = _toNumber(quote?.regularMarketPreviousClose);

        if (_isValidPrice(livePrice)) {
          resolved.add(symbol);
          prices[symbol] = {
            price: livePrice,
            currency: quote?.currency || 'USD',
            source: 'live',
          };
        } else if (_isValidPrice(previousClose)) {
          resolved.add(symbol);
          prices[symbol] = {
            price: previousClose,
            currency: quote?.currency || 'USD',
            source: 'close',
          };
        }
      } catch (err) {
        logger.warn(`Yahoo quote failed for ${symbol}`, { error: err.message });
      }
    }));

    const unresolved = providerIds
      .map(s => (s || '').toUpperCase())
      .filter(Boolean)
      .filter(symbol => !resolved.has(symbol));

    if (unresolved.length) {
      await Promise.all(unresolved.map(async (symbol) => {
        if (prices[symbol]) return;
        try {
          const closePrice = await _fetchYahooLatestClose(symbol);
          if (_isValidPrice(closePrice)) {
            prices[symbol] = {
              price: closePrice,
              currency: 'USD',
              source: 'close',
            };
          }
        } catch (err) {
          logger.warn(`Yahoo chart fallback failed for ${symbol}`, { error: err.message });
        }
      }));
    }

    return prices;
  },

  /**
   * Custom JSON endpoint.
   * price_provider_url = full URL that returns JSON
   * price_provider_id = JSON path to price value (dot notation), e.g. "data.price" or just "price"
   */
  async custom(investments) {
    const prices = {};
    for (const inv of investments) {
      const { latestUrl, latestPath } = _resolveCustomLatestConfig(inv);
      const historyConfig = _resolveCustomHistoryConfig(inv);

      let price;

      try {
        if (latestUrl) {
          const latestData = await _fetchJson(latestUrl);
          price = _toNumber(_readPathValue(latestData, latestPath));

          if (!_isValidPrice(price)) {
            if (historyConfig.historyUrl && historyConfig.historyUrl === latestUrl) {
              price = _deriveLatestPriceFromHistoryPayload(latestData, historyConfig);
            } else if (historyConfig.historyUrl) {
              const historyData = await _fetchJson(historyConfig.historyUrl);
              price = _deriveLatestPriceFromHistoryPayload(historyData, historyConfig);
            }
          }
        } else if (historyConfig.historyUrl) {
          const historyData = await _fetchJson(historyConfig.historyUrl);
          price = _deriveLatestPriceFromHistoryPayload(historyData, historyConfig);
        }
      } catch (err) {
        if (historyConfig.historyUrl && historyConfig.historyUrl !== latestUrl) {
          try {
            const historyData = await _fetchJson(historyConfig.historyUrl);
            price = _deriveLatestPriceFromHistoryPayload(historyData, historyConfig);
          } catch (historyErr) {
            logger.warn(`Custom price fetch error for investment ${inv.id}: ${historyErr.message}`);
          }
        } else {
          logger.warn(`Custom price fetch error for investment ${inv.id}: ${err.message}`);
        }
      }

      if (_isValidPrice(price)) {
        prices[inv.id] = { price };
      }
    }
    return prices;
  },

  /**
   * Kinesis Market Data API — trendlines for precious metals and commodities.
   * price_provider_id = Kinesis symbol (e.g., 'KAU_USD', 'XAU_USD', 'XAG_USD')
   * Or uses configured assets from kinesisConfig.js based on asset name.
   */
  async kinesis(investments) {
    const prices = {};
    for (const inv of investments) {
      const { symbol, timeframe, fromDate } = _resolveKinesisConfig(inv);

      if (!symbol) {
        logger.warn(`Kinesis: no symbol configured for investment ${inv.id}`);
        continue;
      }

      try {
        const url = `${KINESIS_BASE_URL}?symbolIds=${encodeURIComponent(symbol)}&timeFrame=${timeframe}&fromDate=${fromDate}`;
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          logger.warn(`Kinesis API error: ${res.status} for ${symbol}`);
          continue;
        }

        const data = await res.json();
        const rawPoints = data?.[symbol];

        if (!Array.isArray(rawPoints) || rawPoints.length === 0) {
          logger.warn(`Kinesis: no data returned for ${symbol}`);
          continue;
        }

        const parsedPoints = _parseKinesisTrendlinePoints(rawPoints);
        if (!parsedPoints.length) continue;

        // Get the latest price from the most recent point
        const latestPoint = parsedPoints[parsedPoints.length - 1];
        const price = _toNumber(latestPoint?.price);

        if (_isValidPrice(price)) {
          prices[inv.id] = { price, currency: 'USD', source: 'live' };
        }
      } catch (err) {
        logger.warn(`Kinesis fetch failed for ${symbol}: ${err.message}`);
      }
    }
    return prices;
  },
};

/**
 * Fetch live prices for a list of investments.
 * Groups by provider and batches requests where possible.
 * Caches individual symbol prices for PRICE_CACHE_TTL_MS to avoid hammering external APIs.
 * Returns { investmentId: newPrice } map.
 */
export async function fetchLivePrices(investments) {
  const detailed = await fetchLivePricesDetailed(investments);
  return Object.fromEntries(Object.entries(detailed).map(([investmentId, data]) => [investmentId, data.price]));
}

export async function fetchLivePricesDetailed(investments, { cachedPricesByInvestmentId = {} } = {}) {
  const results = {};

  // Serve cached prices immediately; only fetch stale/missing ones
  const stale = { binance: [], yahoo: [], custom: [], kinesis: [] };
  for (const inv of investments) {
    const provider = inv.price_provider || 'manual';
    if (provider === 'manual') continue;
    const providerKey = provider === 'yahoo'
      ? _resolveYahooSymbol(inv)
      : (inv.price_provider_id || '');
    if (!providerKey && provider !== 'custom' && provider !== 'kinesis') continue;

    const cacheKey = (provider === 'custom' || provider === 'kinesis')
      ? `${provider}:${inv.id}`
      : `${provider}:${providerKey}`;
    const cached = _cacheGet(cacheKey);
    const cachedPrice = _toNumber(cached?.price ?? cached);
    if (_isValidPrice(cachedPrice)) {
      results[inv.id] = {
        price: cachedPrice,
        source: cached?.source || 'live',
      };
    } else if (stale[provider]) {
      stale[provider].push(inv);
    }
  }

  // Binance batch
  if (stale.binance.length) {
    try {
      const ids = [...new Set(stale.binance.map(inv => (inv.price_provider_id || '').toUpperCase()).filter(Boolean))];
      const prices = await PROVIDERS.binance(ids);
      for (const inv of stale.binance) {
        const pid = (inv.price_provider_id || '').toUpperCase();
        if (prices[pid]) {
          results[inv.id] = { price: prices[pid].price, source: prices[pid].source || 'live' };
          _cacheSet(`binance:${pid}`, { price: prices[pid].price, source: prices[pid].source || 'live' });
        }
      }
    } catch (err) {
      logger.error('Binance batch fetch failed', { error: err.message });
    }
  }

  // Yahoo Finance batch
  if (stale.yahoo.length) {
    try {
      const ids = [...new Set(stale.yahoo.map(_resolveYahooSymbol).filter(Boolean))];
      const prices = await PROVIDERS.yahoo(ids);
      for (const inv of stale.yahoo) {
        const pid = _resolveYahooSymbol(inv);
        if (prices[pid]) {
          results[inv.id] = { price: prices[pid].price, source: prices[pid].source || 'live' };
          _cacheSet(`yahoo:${pid}`, { price: prices[pid].price, source: prices[pid].source || 'live' });
        }
      }
    } catch (err) {
      logger.error('Yahoo Finance batch fetch failed', { error: err.message });
    }
  }

  // Custom — individual fetches
  if (stale.custom.length) {
    try {
      const prices = await PROVIDERS.custom(stale.custom);
      for (const inv of stale.custom) {
        const data = prices[inv.id];
        if (data !== undefined) {
          if (_isValidPrice(data.price)) {
            results[inv.id] = { price: data.price, source: 'live' };
            _cacheSet(`custom:${inv.id}`, { price: data.price, source: 'live' });
          }
        }
      }
    } catch (err) {
      logger.error('Custom price fetch failed', { error: err.message });
    }
  }

  // Kinesis — individual fetches
  if (stale.kinesis.length) {
    try {
      const prices = await PROVIDERS.kinesis(stale.kinesis);
      for (const inv of stale.kinesis) {
        const data = prices[inv.id];
        if (data !== undefined) {
          if (_isValidPrice(data.price)) {
            results[inv.id] = { price: data.price, source: 'live' };
            _cacheSet(`kinesis:${inv.id}`, { price: data.price, source: 'live' });
          }
        }
      }
    } catch (err) {
      logger.error('Kinesis price fetch failed', { error: err.message });
    }
  }

  for (const inv of investments) {
    if (results[inv.id] !== undefined) continue;
    const cachedPrice = _toNumber(cachedPricesByInvestmentId[inv.id]);
    if (_isValidPrice(cachedPrice)) {
      results[inv.id] = { price: cachedPrice, source: 'cached' };
    }
  }

  return results;
}

export async function fetchHistoricalPrices(investment, { fromMs, toMs, dbOnly = false } = {}) {
  if (!investment) return [];
  const provider = (investment.price_provider || 'manual');
  const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : undefined;
  const to = Number.isFinite(Number(toMs)) ? Number(toMs) : undefined;
  const dbOnlyMode = dbOnly === true || dbOnly === 'true' || dbOnly === 1 || dbOnly === '1';

  const cachedDbPoints = await _loadHistoricalPointsFromDatabase(investment.id, { fromMs: from, toMs: to });
  if (dbOnlyMode) {
    if (provider === 'kinesis') {
      const sanitizedCachedPoints = _sanitizeKinesisIsolatedSpikes(cachedDbPoints);
      return _filterPointsByRange(sanitizedCachedPoints, { fromMs: from, toMs: to });
    }

    return _filterPointsByRange(cachedDbPoints, { fromMs: from, toMs: to });
  }

  if (!_needsHistoryRefresh(cachedDbPoints, { fromMs: from, toMs: to })) {
    if (provider === 'kinesis') {
      const sanitizedCachedPoints = _sanitizeKinesisIsolatedSpikes(cachedDbPoints);
      const changed = _countChangedPointPrices(cachedDbPoints, sanitizedCachedPoints);
      if (changed > 0) {
        await _saveHistoricalPointsToDatabase(investment.id, sanitizedCachedPoints, 'kinesis');
      }
      return _filterPointsByRange(sanitizedCachedPoints, { fromMs: from, toMs: to });
    }

    return _filterPointsByRange(cachedDbPoints, { fromMs: from, toMs: to });
  }

  if (provider === 'yahoo') {
    const symbol = _resolveYahooSymbol(investment);
    if (!symbol) return [];

    const cacheKey = `yahoo-history:${symbol}`;
    const cached = _cacheGet(cacheKey);
    let points = Array.isArray(cached?.points) ? cached.points : undefined;

    if (!points) {
      try {
        const chart = await yahooFinance.chart(symbol, {
          period1: new Date(from || (Date.now() - 5 * 365 * 24 * 60 * 60 * 1000)),
          interval: '1d',
          includePrePost: false,
        });

        points = _normalizeHistoryPoints((chart?.quotes || [])
          .map((q) => ({
            timestampMs: q?.date ? new Date(q.date).getTime() : Number.NaN,
            price: _toNumber(q?.close),
          }))
          .filter((p) => Number.isFinite(p.timestampMs) && _isValidPrice(p.price)));

        _cacheSet(cacheKey, { points, source: 'live' });
      } catch (err) {
        logger.warn(`Yahoo history fetch error for ${symbol}: ${err.message}`);
        return _filterPointsByRange(cachedDbPoints, { fromMs: from, toMs: to });
      }
    }

    await _saveHistoricalPointsToDatabase(investment.id, points, 'yahoo');
    const persistedPoints = await _loadHistoricalPointsFromDatabase(investment.id, { fromMs: from, toMs: to });
    const resolved = persistedPoints.length > 0 ? persistedPoints : _normalizeHistoryPoints([...(cachedDbPoints || []), ...(points || [])]);

    return _filterPointsByRange(resolved, { fromMs: from, toMs: to });
  }

  if (provider === 'binance') {
    const symbol = (investment.price_provider_id || '').trim().toUpperCase();
    if (!symbol) return [];

    let days = 365;
    if (from) {
      const msDiff = Date.now() - from;
      const daysDiff = Math.ceil(msDiff / (24 * 60 * 60 * 1000));
      if (daysDiff > 0) {
        days = Math.min(daysDiff, 365); // Binance limit
      }
    }

    const binanceSymbol = symbol.endsWith('EUR') ? symbol : symbol.replace(/EUR$/, 'USDT');
    const cacheKey = `binance-history:${symbol}:${days}`;
    const cached = _cacheGet(cacheKey);
    let points = Array.isArray(cached?.points) ? cached.points : undefined;

    if (!points) {
      try {
        const url = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(binanceSymbol)}&interval=1d&limit=${days}`;
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
        const data = await res.json();

        // Binance klines: [openTime, open, high, low, close, volume, closeTime, ...]
        points = _normalizeHistoryPoints((Array.isArray(data) ? data : [])
          .map((kline) => ({
            timestampMs: Number(kline[0]),
            price: _toNumber(kline[4]), // close price
          }))
          .filter((p) => Number.isFinite(p.timestampMs) && _isValidPrice(p.price)));

        _cacheSet(cacheKey, { points, source: 'live' });
      } catch (err) {
        logger.warn(`Binance history fetch error for ${symbol}: ${err.message}`);
        return _filterPointsByRange(cachedDbPoints, { fromMs: from, toMs: to });
      }
    }

    await _saveHistoricalPointsToDatabase(investment.id, points, 'binance');
    const persistedPoints = await _loadHistoricalPointsFromDatabase(investment.id, { fromMs: from, toMs: to });
    const resolved = persistedPoints.length > 0 ? persistedPoints : _normalizeHistoryPoints([...(cachedDbPoints || []), ...(points || [])]);

    return _filterPointsByRange(resolved, { fromMs: from, toMs: to });
  }

  if (provider === 'kinesis') {
    const { symbol, timeframe, fromDate } = _resolveKinesisConfig(investment);

    if (!symbol) {
      logger.warn(`Kinesis history: no symbol configured for investment ${investment.id}`);
      return _filterPointsByRange(cachedDbPoints, { fromMs: from, toMs: to });
    }

    const cacheKey = `kinesis-history:${symbol}:${timeframe}`;
    const cached = _cacheGet(cacheKey);
    let points = Array.isArray(cached?.points) ? cached.points : undefined;

    if (!points) {
      try {
        const url = `${KINESIS_BASE_URL}?symbolIds=${encodeURIComponent(symbol)}&timeFrame=${timeframe}&fromDate=${fromDate}`;
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          logger.warn(`Kinesis history API error: ${res.status} for ${symbol}`);
          return _filterPointsByRange(cachedDbPoints, { fromMs: from, toMs: to });
        }

        const data = await res.json();
        const rawPoints = data?.[symbol];

        if (!Array.isArray(rawPoints)) {
          logger.warn(`Kinesis history: invalid data for ${symbol}`);
          return _filterPointsByRange(cachedDbPoints, { fromMs: from, toMs: to });
        }

        points = _parseKinesisTrendlinePoints(rawPoints);
        _cacheSet(cacheKey, { points, source: 'live' });
      } catch (err) {
        logger.warn(`Kinesis history fetch error for ${symbol}: ${err.message}`);
        return _filterPointsByRange(cachedDbPoints, { fromMs: from, toMs: to });
      }
    }

    await _saveHistoricalPointsToDatabase(investment.id, points, 'kinesis');
    const persistedPoints = await _loadHistoricalPointsFromDatabase(investment.id, { fromMs: from, toMs: to });
    const resolved = persistedPoints.length > 0 ? persistedPoints : _normalizeHistoryPoints([...(cachedDbPoints || []), ...(points || [])]);

    return _filterPointsByRange(resolved, { fromMs: from, toMs: to });
  }

  if (provider !== 'custom') {
    return _filterPointsByRange(cachedDbPoints, { fromMs: from, toMs: to });
  }

  const config = _resolveCustomHistoryConfig(investment);
  if (!config.historyUrl) return [];

  const cacheKey = `custom-history:${investment.id}:${config.historyUrl}:${config.historyPath}:${config.timestampPath}:${config.pricePath}`;
  const cached = _cacheGet(cacheKey);
  let points = Array.isArray(cached?.points) ? cached.points : undefined;

  if (!points) {
    try {
      const data = await _fetchJson(config.historyUrl);
      points = _normalizeHistoryPoints(_parseCustomHistoryPoints(data, config));
      _cacheSet(cacheKey, { points, source: 'live' });
    } catch (err) {
      logger.warn(`Custom history fetch error for investment ${investment.id}: ${err.message}`);
      return _filterPointsByRange(cachedDbPoints, { fromMs: from, toMs: to });
    }
  }

  await _saveHistoricalPointsToDatabase(investment.id, points, 'custom');
  const persistedPoints = await _loadHistoricalPointsFromDatabase(investment.id, { fromMs: from, toMs: to });
  const resolved = persistedPoints.length > 0 ? persistedPoints : _normalizeHistoryPoints([...(cachedDbPoints || []), ...(points || [])]);

  return _filterPointsByRange(resolved, { fromMs: from, toMs: to });
}

export async function backfillHistoricalAssetQuotes() {
  const heldInvestmentsResult = await query(
    `SELECT
       i.id,
       i.asset_class,
       i.currency,
       i.price_provider,
       i.price_provider_id,
       i.symbol,
       i.price_provider_url,
       i.price_provider_latest_url,
       i.price_provider_latest_path,
       i.price_provider_history_url,
       i.price_provider_history_path,
       i.price_provider_history_ts_path,
       i.price_provider_history_price_path,
       MIN(pt.date)::date AS first_tx_date,
       COALESCE(SUM(
         CASE
           WHEN pt.type IN ('buy', 'gift') THEN COALESCE(pt.units, 0)
           WHEN pt.type = 'sell' THEN -COALESCE(pt.units, 0)
           ELSE 0
         END
       ), 0) AS held_units
     FROM investments i
     LEFT JOIN portfolio_transactions pt
       ON pt.investment_id = i.id
      AND pt.type IN ('buy', 'gift', 'sell')
     WHERE i.is_active = true
       AND i.asset_class IN ('stock', 'etf', 'crypto', 'metals')
      GROUP BY
        i.id,
        i.asset_class,
        i.currency,
        i.price_provider,
        i.price_provider_id,
        i.symbol,
        i.price_provider_url,
        i.price_provider_latest_url,
        i.price_provider_latest_path,
        i.price_provider_history_url,
        i.price_provider_history_path,
        i.price_provider_history_ts_path,
        i.price_provider_history_price_path
     HAVING MIN(pt.date) IS NOT NULL
        AND COALESCE(SUM(
          CASE
            WHEN pt.type IN ('buy', 'gift') THEN COALESCE(pt.units, 0)
            WHEN pt.type = 'sell' THEN -COALESCE(pt.units, 0)
            ELSE 0
          END
        ), 0) > 0`,
    []
  );

  const investments = heldInvestmentsResult.rows || [];
  if (investments.length === 0) {
    logger.info('Historical asset quote backfill skipped: no held market-priced assets');
    return { processed: 0, withHistory: 0, failed: 0 };
  }

  let withHistory = 0;
  let failed = 0;

  for (const investment of investments) {
    const fromDate = String(investment.first_tx_date || '');
    const fromMs = Number.isFinite(Date.parse(`${fromDate}T00:00:00.000Z`))
      ? Date.parse(`${fromDate}T00:00:00.000Z`)
      : undefined;

    if (!Number.isFinite(fromMs)) continue;

    try {
      const points = await fetchHistoricalPrices(investment, {
        fromMs,
        toMs: Date.now(),
      });
      if (points.length > 0) withHistory += 1;
    } catch (error) {
      failed += 1;
      logger.warn('Historical quote backfill failed for investment', {
        investmentId: investment.id,
        error: error?.message,
      });
    }
  }

  logger.info('Historical asset quote backfill complete', {
    processed: investments.length,
    withHistory,
    failed,
  });

  return {
    processed: investments.length,
    withHistory,
    failed,
  };
}

export async function sanitizePersistedKinesisHistory() {
  const investmentsResult = await query(
    `SELECT id
     FROM investments
     WHERE price_provider = 'kinesis'`,
    []
  );

  const investments = investmentsResult.rows || [];
  if (investments.length === 0) {
    logger.info('Kinesis history sanitization skipped: no kinesis investments');
    return { processed: 0, updated: 0, correctedPoints: 0, failed: 0 };
  }

  let updated = 0;
  let correctedPoints = 0;
  let failed = 0;

  for (const investment of investments) {
    try {
      const points = await _loadHistoricalPointsFromDatabase(investment.id);
      if (!Array.isArray(points) || points.length < 3) continue;

      const sanitized = _sanitizeKinesisIsolatedSpikes(points);
      const changed = _countChangedPointPrices(points, sanitized);
      if (changed > 0) {
        await _saveHistoricalPointsToDatabase(investment.id, sanitized, 'kinesis');
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

  logger.info('Kinesis history sanitization complete', {
    processed: investments.length,
    updated,
    correctedPoints,
    failed,
  });

  return {
    processed: investments.length,
    updated,
    correctedPoints,
    failed,
  };
}

export function __resetPriceCache() {
  _priceCache.clear();
}

export const SUPPORTED_PROVIDERS = [
  { key: 'manual', name: 'Manual', description: 'Set price manually' },
  { key: 'binance', name: 'Binance', description: 'Free crypto prices (use symbol, e.g. "BTCUSDT", "ETHUSDT", "BNBEUR")' },
  { key: 'yahoo', name: 'Yahoo Finance', description: 'Stocks, ETFs & metals (use ticker, e.g. "AAPL", "VWCE.DE", "GC=F")' },
  { key: 'custom', name: 'Custom JSON', description: 'Any JSON endpoint with a configurable price path' },
  { key: 'kinesis', name: 'Kinesis', description: 'Precious metals & commodities (use symbol, e.g. "KAU_USD", "XAU_USD", "XAG_USD")' },
];
