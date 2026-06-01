/**
 * Price Provider Registry
 *
 * Provider strategy implementations (Binance, Yahoo Finance, custom JSON, Kinesis)
 * and the Kinesis-specific MAD spike detector.
 */

import { logger } from '../../config/logger.js';
import YahooFinance from 'yahoo-finance2';
import {
  KINESIS_BASE_URL,
  KINESIS_DEFAULT_TIMEFRAME,
  KINESIS_DEFAULT_FROM_DATE,
  getKinesisAssetConfig,
} from '../../config/kinesisConfig.js';
import { toNumber, isValidPrice } from './priceCache.js';
import { median } from '../../lib/math.js';
import { convertToCurrency } from '../currency/currencyConversionService.js';
import { assertPublicHttpUrl } from '../../lib/urlSafety.js';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ─── Path helpers ─────────────────────────────────────────────────────────────

function _splitPath(path) {
  if (typeof path !== 'string') return [];
  return path.trim().split('.').map(seg => seg.trim()).filter(Boolean);
}

function _readPathValue(input, path) {
  const segments = _splitPath(path);
  if (segments.length === 0) return input;
  let value = input;
  for (const segment of segments) {
    if (value == null) return undefined;
    value = value[segment];
  }
  return value;
}

// ─── Config resolvers ─────────────────────────────────────────────────────────

export function resolveYahooSymbol(inv) {
  const providerId = (inv?.price_provider_id || '').trim();
  if (providerId) return providerId.toUpperCase();
  const symbol = (inv?.symbol || '').trim();
  return symbol ? symbol.toUpperCase() : '';
}

function _resolveCustomLatestConfig(inv) {
  const latestUrl = (inv?.price_provider_latest_url || inv?.price_provider_url || inv?.price_provider_history_url || '').trim();
  const latestPath = (inv?.price_provider_latest_path || inv?.price_provider_id || 'price').trim();
  return { latestUrl, latestPath };
}

export function resolveCustomHistoryConfig(inv) {
  const historyUrl = (inv?.price_provider_history_url || inv?.price_provider_latest_url || inv?.price_provider_url || '').trim();
  const historyPath = (inv?.price_provider_history_path || 'points').trim();
  const timestampPath = (inv?.price_provider_history_ts_path || 'timestamp_ms').trim();
  const pricePath = (inv?.price_provider_history_price_path || 'price').trim();
  return { historyUrl, historyPath, timestampPath, pricePath };
}

// Kinesis API only provides USD-denominated symbols. Map EUR variants to USD.
const KINESIS_EUR_TO_USD = {
  'KAU_EUR': 'KAU_USD',
  'KAG_EUR': 'KAG_USD',
  'XAU_EUR': 'XAU_USD',
  'XAG_EUR': 'XAG_USD',
  'XPT_EUR': 'XPT_USD',
  'XPD_EUR': 'XPD_USD',
};

export function resolveKinesisConfig(inv) {
  const providerId = (inv?.price_provider_id || '').trim();
  const assetName = (inv?.name || inv?.symbol || '').toLowerCase().trim();

  if (providerId.endsWith('_EUR') && !KINESIS_EUR_TO_USD[providerId]) {
    logger.warn(`Kinesis: unmapped EUR symbol "${providerId}" — add it to KINESIS_EUR_TO_USD or the API call will fail`);
  }
  // The Kinesis API only serves USD-denominated symbols. When a EUR symbol is
  // remapped to its USD variant, the fetched prices are in USD and the caller
  // must convert them to the investment's currency before use/persistence.
  const needsUsdToEur = Boolean(KINESIS_EUR_TO_USD[providerId]);
  let symbol = KINESIS_EUR_TO_USD[providerId] || providerId;
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

  return { symbol, timeframe, fromDate, needsUsdToEur };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

const CUSTOM_FETCH_MAX_REDIRECTS = 3;
const CUSTOM_FETCH_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — provider JSON is tiny; cap guards against memory-exhaustion responses.

/**
 * Reject a response whose declared Content-Length exceeds the size cap, before
 * buffering the body. Applies to every provider fetch (custom + hardcoded
 * Binance/Kinesis) so a hostile or wedged upstream can't exhaust memory.
 *
 * @param {Response} res
 * @param {string} provider - label for the error message
 */
function _assertResponseWithinCap(res, provider) {
  const declaredLength = Number(res.headers?.get?.('content-length') || 0);
  if (declaredLength > CUSTOM_FETCH_MAX_BYTES) {
    throw new Error(`${provider} response too large: ${declaredLength} bytes`);
  }
}

/**
 * Fetch JSON from a user-controlled custom-provider URL.
 *
 * Custom provider URLs come from the investment record (price_provider_*_url),
 * so this is an SSRF sink: every hop is validated against the public-URL guard
 * (scheme + private/loopback/link-local block, DNS-resolved). Redirects are
 * followed manually so a public host cannot 302 the request to an internal
 * address, and the response body is size-capped.
 */
async function _fetchJson(url) {
  let current = String(url);
  for (let hop = 0; hop <= CUSTOM_FETCH_MAX_REDIRECTS; hop += 1) {
    await assertPublicHttpUrl(current); // throws BlockedUrlError on private/loopback/non-http
    const res = await fetch(current, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`HTTP ${res.status} redirect without Location`);
      current = new URL(location, current).toString(); // re-validated at top of next loop
      continue;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    _assertResponseWithinCap(res, 'Custom provider');
    return res.json();
  }
  throw new Error('Too many redirects');
}

// ─── Custom endpoint parsing ──────────────────────────────────────────────────

function _parseCustomHistoryPoints(data, config) {
  const listValue = _readPathValue(data, config.historyPath);
  if (!Array.isArray(listValue)) return [];

  const points = [];
  for (const row of listValue) {
    const timestampMs = Number(_readPathValue(row, config.timestampPath));
    const price = Number(_readPathValue(row, config.pricePath));
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

export function parseCustomHistoryPoints(data, config) {
  return _parseCustomHistoryPoints(data, config);
}

// ─── Kinesis spike detector (MAD-based) ───────────────────────────────────────

// Removes runs of ≥ minRunLength consecutive identical prices (stale API data).
// Keeps only the first point of each such run so the series resumes at the
// correct price when real updates arrive.
function _removeStaleRuns(points, minRunLength = 8) {
  if (points.length < 2) return [...points];
  const result = [];
  let i = 0;
  while (i < points.length) {
    result.push(points[i]);
    let j = i + 1;
    while (j < points.length && points[j].price === points[i].price) j++;
    if (j - i >= minRunLength) {
      i = j;
    } else {
      i++;
    }
  }
  return result;
}

export function sanitizeKinesisIsolatedSpikes(points) {
  if (!Array.isArray(points) || points.length < 2) return points || [];

  const sanitized = _removeStaleRuns(points).map((p) => ({ ...p }));

  if (sanitized.length < 2) return sanitized;

  const localNeedleRatio = 1.8;

  // Edge: first point — check against its single neighbor
  const firstCurr = toNumber(sanitized[0]?.price);
  const firstNext = toNumber(sanitized[1]?.price);
  if (isValidPrice(firstCurr) && isValidPrice(firstNext)) {
    if (firstCurr * localNeedleRatio <= firstNext || firstCurr >= firstNext * localNeedleRatio) {
      sanitized[0].price = firstNext;
    }
  }

  // Edge: last point — check against its single neighbor
  const lastIdx = sanitized.length - 1;
  const lastPrev = toNumber(sanitized[lastIdx - 1]?.price);
  const lastCurr = toNumber(sanitized[lastIdx]?.price);
  if (isValidPrice(lastPrev) && isValidPrice(lastCurr)) {
    if (lastCurr * localNeedleRatio <= lastPrev || lastCurr >= lastPrev * localNeedleRatio) {
      sanitized[lastIdx].price = lastPrev;
    }
  }

  if (sanitized.length < 5) return sanitized;

  const logReturns = [];
  for (let i = 1; i < sanitized.length; i += 1) {
    const prev = toNumber(sanitized[i - 1]?.price);
    const current = toNumber(sanitized[i]?.price);
    if (!isValidPrice(prev) || !isValidPrice(current)) continue;
    logReturns.push(Math.log(current / prev));
  }

  if (logReturns.length < 4) return sanitized;

  const medianReturn = median(logReturns) ?? 0;
  const absDeviations = logReturns.map(r => Math.abs(r - medianReturn));
  const mad = median(absDeviations) ?? 0;
  const robustSigma = Math.max(1.4826 * mad, 0.0015);

  const spikeThreshold = 6 * robustSigma;
  const bridgeThreshold = 4 * robustSigma;
  const minSpikeMove = Math.log(1.18);
  const localNeedleNeighborTolerance = Math.log(1.12);

  for (let i = 1; i < sanitized.length - 1; i += 1) {
    const prev = toNumber(sanitized[i - 1]?.price);
    const current = toNumber(sanitized[i]?.price);
    const next = toNumber(sanitized[i + 1]?.price);
    if (!isValidPrice(prev) || !isValidPrice(current) || !isValidPrice(next)) continue;

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
    const price = toNumber(point?.price);
    if (!createdAt || !isValidPrice(price)) continue;
    const timestampMs = new Date(createdAt).getTime();
    if (!Number.isFinite(timestampMs)) continue;
    points.push({ timestampMs, price });
  }

  points.sort((a, b) => a.timestampMs - b.timestampMs);
  return sanitizeKinesisIsolatedSpikes(points);
}

// ─── Yahoo helper ─────────────────────────────────────────────────────────────

async function _fetchYahooLatestClose(symbol) {
  const chart = await yahooFinance.chart(symbol, {
    period1: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    interval: '1d',
    includePrePost: false,
  });
  const quotes = chart?.quotes || [];

  for (let i = quotes.length - 1; i >= 0; i -= 1) {
    const close = toNumber(quotes[i]?.close);
    if (isValidPrice(close)) return close;
  }
  return undefined;
}

// ─── Historical price point lookup ───────────────────────────────────────────

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

// ─── Provider strategies ──────────────────────────────────────────────────────

export const PROVIDERS = {
  async binance(providerIds) {
    const uniqueSymbols = [...new Set(providerIds.map(id => (id || '').toUpperCase()))].filter(Boolean);
    if (uniqueSymbols.length === 0) return {};

    const prices = {};
    try {
      const res = await fetch('https://data-api.binance.vision/api/v3/ticker/price', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
      _assertResponseWithinCap(res, 'Binance');
      const data = await res.json();

      const priceMap = {};
      for (const item of data) {
        if (!item.symbol || !item.price) continue;
        const parsed = parseFloat(item.price);
        if (Number.isFinite(parsed) && parsed > 0) priceMap[item.symbol] = parsed;
      }

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

  async yahoo(providerIds) {
    const prices = {};
    const resolved = new Set();

    const symbols = [...new Set(providerIds.map((s) => (s || '').toUpperCase()).filter(Boolean))];
    if (symbols.length === 0) return prices;

    try {
      // Single batched request. yahoo-finance2 `.quote()` accepts an array and
      // returns one Quote per resolvable symbol — collapsing what used to be N
      // separate `quote()` round-trips into one call (a 30-holding portfolio
      // went from ~30 outbound requests to 1). Normalise to an array so a
      // single-symbol response (object) is handled the same way.
      const raw = /** @type {any} */ (await yahooFinance.quote(symbols));
      const quotes = Array.isArray(raw) ? raw : (raw ? [raw] : []);

      for (const quote of quotes) {
        const symbol = (quote?.symbol || '').toUpperCase();
        if (!symbol) continue;
        const livePrice = toNumber(quote?.regularMarketPrice);
        const previousClose = toNumber(quote?.regularMarketPreviousClose);

        if (isValidPrice(livePrice)) {
          resolved.add(symbol);
          prices[symbol] = { price: livePrice, currency: quote?.currency || 'USD', source: 'live' };
        } else if (isValidPrice(previousClose)) {
          resolved.add(symbol);
          prices[symbol] = { price: previousClose, currency: quote?.currency || 'USD', source: 'close' };
        }
      }
    } catch (err) {
      // Whole-batch failure (network/validation): leave every symbol unresolved
      // so the per-symbol chart fallback below recovers each independently.
      logger.warn('Yahoo batch quote failed; falling back per-symbol', { error: err.message });
    }

    const unresolved = symbols.filter((symbol) => !resolved.has(symbol));

    if (unresolved.length) {
      await Promise.all(unresolved.map(async (symbol) => {
        if (prices[symbol]) return;
        try {
          const closePrice = await _fetchYahooLatestClose(symbol);
          if (isValidPrice(closePrice)) {
            prices[symbol] = { price: closePrice, currency: 'USD', source: 'close' };
          }
        } catch (err) {
          logger.warn(`Yahoo chart fallback failed for ${symbol}`, { error: err.message });
        }
      }));
    }

    return prices;
  },

  async custom(investments) {
    const prices = {};
    for (const inv of investments) {
      const { latestUrl, latestPath } = _resolveCustomLatestConfig(inv);
      const historyConfig = resolveCustomHistoryConfig(inv);

      let price;
      try {
        if (latestUrl) {
          const latestData = await _fetchJson(latestUrl);
          price = toNumber(_readPathValue(latestData, latestPath));

          if (!isValidPrice(price)) {
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

      if (isValidPrice(price)) prices[inv.id] = { price };
    }
    return prices;
  },

  async kinesis(investments) {
    const prices = {};
    for (const inv of investments) {
      const { symbol, timeframe, fromDate, needsUsdToEur } = resolveKinesisConfig(inv);

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

        _assertResponseWithinCap(res, 'Kinesis');
        const data = await res.json();
        const rawPoints = data?.[symbol];

        if (!Array.isArray(rawPoints) || rawPoints.length === 0) {
          logger.warn(`Kinesis: no data returned for ${symbol}`);
          continue;
        }

        const parsedPoints = _parseKinesisTrendlinePoints(rawPoints);
        if (!parsedPoints.length) continue;

        const latestPoint = parsedPoints[parsedPoints.length - 1];
        const usdPrice = toNumber(latestPoint?.price);
        if (isValidPrice(usdPrice)) {
          // Kinesis only quotes USD. When a EUR symbol was remapped to its USD
          // variant, convert the latest price to the investment's currency at
          // the current rate before it becomes this asset's current price.
          const invCurrency = (inv.currency || 'EUR').toUpperCase();
          let price = usdPrice;
          if (needsUsdToEur && invCurrency !== 'USD') {
            price = await convertToCurrency(usdPrice, 'USD', invCurrency);
          }
          if (isValidPrice(price)) {
            prices[inv.id] = { price, currency: invCurrency, source: 'live' };
          }
        }
      } catch (err) {
        logger.warn(`Kinesis fetch failed for ${symbol}: ${err.message}`);
      }
    }
    return prices;
  },
};

export { yahooFinance, _parseKinesisTrendlinePoints };
