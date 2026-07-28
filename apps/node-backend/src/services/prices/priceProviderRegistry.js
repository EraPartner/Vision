/**
 * Price Provider Registry
 *
 * Provider strategy implementations (Binance, Yahoo Finance, custom JSON, Kinesis)
 * and the Kinesis-specific MAD spike detector.
 */

import { logger } from '../../config/logger.js';
import {
  KINESIS_BASE_URL,
  KINESIS_DEFAULT_TIMEFRAME,
  KINESIS_DEFAULT_FROM_DATE,
  getKinesisAssetConfig,
} from '../../config/kinesisConfig.js';
import { toNumber, isValidPrice } from './priceCache.js';
import { madReturnStats, isRobustNeedle } from '../../lib/math.js';
import { convertToCurrency } from '../currency/currencyConversionService.js';
import { assertPublicHttpUrl } from '../../lib/urlSafety.js';
import { getYahooClient } from './yahooClient.js';

/**
 * @typedef {import('../../types/rows.js').InvestmentRow} InvestmentRow
 * @typedef {import('../../types/rows.js').PricePoint} PricePoint
 */

/**
 * The custom-provider history extraction config, as resolved from an
 * investment's `price_provider_history_*` columns. Every field is a
 * dot-separated path into the provider's JSON except `historyUrl`.
 *
 * @typedef {object} CustomHistoryConfig
 * @property {string} historyUrl
 * @property {string} historyPath path to the point array
 * @property {string} timestampPath path to a point's epoch-millis timestamp
 * @property {string} pricePath path to a point's price
 */

/**
 * One provider strategy's answer for a single key. `currency` and `source` are
 * optional because the `custom` strategy has no way to know either — it only
 * ever returns `{ price }`.
 *
 * @typedef {object} LivePriceQuote
 * @property {number} price
 * @property {string} [currency]
 * @property {'live'|'close'} [source]
 */

// ─── Path helpers ─────────────────────────────────────────────────────────────

/**
 * @param {unknown} path dot-separated path, e.g. `data.points`
 * @returns {string[]} trimmed non-empty segments; [] for non-string input
 */
function _splitPath(path) {
  if (typeof path !== 'string') return [];
  return path.trim().split('.').map(seg => seg.trim()).filter(Boolean);
}

/**
 * Walk a dot-separated path into arbitrary provider JSON.
 *
 * @param {any} input parsed provider JSON — shape is user-configured, so genuinely unknown
 * @param {unknown} path an empty path returns `input` itself
 * @returns {any} undefined as soon as any hop is null/undefined
 */
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

/**
 * The Yahoo ticker for an investment: the explicit `price_provider_id`, else
 * the instrument symbol, uppercased. Empty string when neither is set.
 *
 * @param {Partial<InvestmentRow>|null|undefined} inv
 * @returns {string}
 */
export function resolveYahooSymbol(inv) {
  const providerId = (inv?.price_provider_id || '').trim();
  if (providerId) return providerId.toUpperCase();
  const symbol = (inv?.symbol || '').trim();
  return symbol ? symbol.toUpperCase() : '';
}

/**
 * @param {Partial<InvestmentRow>|null|undefined} inv
 * @returns {{ latestUrl: string, latestPath: string }} empty `latestUrl` when no URL column is set
 */
function _resolveCustomLatestConfig(inv) {
  const latestUrl = (inv?.price_provider_latest_url || inv?.price_provider_url || inv?.price_provider_history_url || '').trim();
  const latestPath = (inv?.price_provider_latest_path || inv?.price_provider_id || 'price').trim();
  return { latestUrl, latestPath };
}

/**
 * @param {Partial<InvestmentRow>|null|undefined} inv
 * @returns {CustomHistoryConfig} empty `historyUrl` when no URL column is set
 */
export function resolveCustomHistoryConfig(inv) {
  const historyUrl = (inv?.price_provider_history_url || inv?.price_provider_latest_url || inv?.price_provider_url || '').trim();
  const historyPath = (inv?.price_provider_history_path || 'points').trim();
  const timestampPath = (inv?.price_provider_history_ts_path || 'timestamp_ms').trim();
  const pricePath = (inv?.price_provider_history_price_path || 'price').trim();
  return { historyUrl, historyPath, timestampPath, pricePath };
}

// Kinesis API only provides USD-denominated symbols. Map EUR variants to USD.
/** @type {Record<string, string>} */
const KINESIS_EUR_TO_USD = {
  'KAU_EUR': 'KAU_USD',
  'KAG_EUR': 'KAG_USD',
  'XAU_EUR': 'XAU_USD',
  'XAG_EUR': 'XAG_USD',
  'XPT_EUR': 'XPT_USD',
  'XPD_EUR': 'XPD_USD',
};

/**
 * Resolve the Kinesis symbol + trendline window for an investment, remapping a
 * EUR symbol to its USD variant (Kinesis only quotes USD) and falling back to
 * the name-keyed asset catalogue.
 *
 * @param {Partial<InvestmentRow>|null|undefined} inv
 * @returns {{ symbol: string, timeframe: number, fromDate: string, needsUsdToEur: boolean }}
 *   `symbol` is '' when nothing could be resolved; `needsUsdToEur` flags that
 *   the fetched prices are USD and must be converted before use.
 */
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
 *
 * @param {string} url
 * @returns {Promise<any>} parsed provider JSON — shape is user-configured
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

/**
 * Extract a date-ascending point series from a custom provider's JSON using the
 * configured paths. Malformed rows and non-positive prices are dropped.
 *
 * @param {any} data parsed provider JSON
 * @param {CustomHistoryConfig} config
 * @returns {PricePoint[]}
 */
function _parseCustomHistoryPoints(data, config) {
  const listValue = _readPathValue(data, config.historyPath);
  if (!Array.isArray(listValue)) return [];

  /** @type {PricePoint[]} */
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

/**
 * Last price of a custom provider's history payload — the fallback when the
 * latest-price endpoint yields nothing usable.
 *
 * @param {any} data parsed provider JSON
 * @param {CustomHistoryConfig} historyConfig
 * @returns {number|undefined}
 */
function _deriveLatestPriceFromHistoryPayload(data, historyConfig) {
  const points = _parseCustomHistoryPoints(data, historyConfig);
  if (!points.length) return undefined;
  return points[points.length - 1]?.price;
}

/**
 * Public wrapper over the custom-provider history parser.
 *
 * @param {any} data parsed provider JSON
 * @param {CustomHistoryConfig} config
 * @returns {PricePoint[]}
 */
export function parseCustomHistoryPoints(data, config) {
  return _parseCustomHistoryPoints(data, config);
}

// ─── Kinesis spike detector (MAD-based) ───────────────────────────────────────

// Removes runs of ≥ minRunLength consecutive identical prices (stale API data).
// Keeps only the first point of each such run so the series resumes at the
// correct price when real updates arrive.
/**
 * @param {PricePoint[]} points
 * @param {number} [minRunLength] run length at/above which the repeats are dropped
 * @returns {PricePoint[]} a new array (the input is not mutated)
 */
function _removeStaleRuns(points, minRunLength = 8) {
  if (points.length < 2) return [...points];
  /** @type {PricePoint[]} */
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

/**
 * Kinesis-specific data cleanup: drop stale repeated-price runs, then flatten
 * isolated one-point needles (edges against their single neighbour, interior
 * against a MAD-based robust threshold).
 *
 * @param {PricePoint[]|null|undefined} points
 * @returns {PricePoint[]} a shallow-copied, repaired series
 */
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

  /** @type {number[]} */
  const logReturns = [];
  for (let i = 1; i < sanitized.length; i += 1) {
    const prev = toNumber(sanitized[i - 1]?.price);
    const current = toNumber(sanitized[i]?.price);
    if (!isValidPrice(prev) || !isValidPrice(current)) continue;
    logReturns.push(Math.log(current / prev));
  }

  if (logReturns.length < 4) return sanitized;

  const stats = madReturnStats(logReturns);
  const localNeedleNeighborTolerance = Math.log(1.12);

  for (let i = 1; i < sanitized.length - 1; i += 1) {
    const prev = toNumber(sanitized[i - 1]?.price);
    const current = toNumber(sanitized[i]?.price);
    const next = toNumber(sanitized[i + 1]?.price);
    if (!isValidPrice(prev) || !isValidPrice(current) || !isValidPrice(next)) continue;

    const bridge = Math.log(next / prev);
    const robustNeedle = isRobustNeedle(prev, current, next, stats);

    const maxNeighbor = Math.max(prev, next);
    const minNeighbor = Math.min(prev, next);
    const localNeedlePeak = current >= maxNeighbor * localNeedleRatio
      && Math.abs(bridge) <= localNeedleNeighborTolerance;
    const localNeedleTrough = current * localNeedleRatio <= minNeighbor
      && Math.abs(bridge) <= localNeedleNeighborTolerance;

    if (robustNeedle || localNeedlePeak || localNeedleTrough) {
      sanitized[i].price = Math.sqrt(prev * next);
    }
  }

  return sanitized;
}

/**
 * Kinesis trendline rows → sanitized point series. Kinesis dates its points
 * with an ISO `createdAt` rather than an epoch, so it needs its own parser.
 *
 * @param {any} rawPoints the `data[symbol]` array of the Kinesis response
 * @returns {PricePoint[]}
 */
function _parseKinesisTrendlinePoints(rawPoints) {
  if (!Array.isArray(rawPoints)) return [];

  /** @type {PricePoint[]} */
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

/**
 * Most recent valid daily close from Yahoo's chart endpoint (5-day window) —
 * the per-symbol fallback when the batched quote call yields nothing.
 *
 * @param {string} symbol
 * @returns {Promise<number|undefined>}
 */
async function _fetchYahooLatestClose(symbol) {
  const yahooFinance = await getYahooClient();
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

/**
 * Binary-search a date-ascending series for the last price at or before a
 * timestamp.
 *
 * @param {PricePoint[]|null|undefined} points must be date-ascending
 * @param {number} timestampMs
 * @returns {number|undefined} undefined when the series is empty or starts later
 */
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

/**
 * Provider strategies. The two shapes are deliberate (SIMP-33): `binance` and
 * `yahoo` batch by a resolved provider id and key their result by that id;
 * `custom` and `kinesis` take investment rows and key by `inv.id`.
 */
export const PROVIDERS = {
  /**
   * @param {string[]} providerIds Binance ticker symbols
   * @returns {Promise<Record<string, LivePriceQuote>>} keyed by symbol; missing symbols are simply absent
   */
  async binance(providerIds) {
    const uniqueSymbols = [...new Set(providerIds.map(id => (id || '').toUpperCase()))].filter(Boolean);
    if (uniqueSymbols.length === 0) return {};

    /** @type {Record<string, LivePriceQuote>} */
    const prices = {};
    try {
      const res = await fetch('https://data-api.binance.vision/api/v3/ticker/price', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
      _assertResponseWithinCap(res, 'Binance');
      const data = await res.json();

      /** @type {Record<string, number>} */
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

  /**
   * @param {string[]} providerIds Yahoo ticker symbols
   * @returns {Promise<Record<string, LivePriceQuote>>} keyed by uppercased symbol
   */
  async yahoo(providerIds) {
    /** @type {Record<string, LivePriceQuote>} */
    const prices = {};
    /** @type {Set<string>} */
    const resolved = new Set();

    const symbols = [...new Set(providerIds.map((s) => (s || '').toUpperCase()).filter(Boolean))];
    if (symbols.length === 0) return prices;

    const yahooFinance = await getYahooClient();
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

  /**
   * @param {InvestmentRow[]} investments holdings whose price_provider is 'custom'
   * @returns {Promise<Record<string, LivePriceQuote>>} keyed by investment id; `{ price }` only
   */
  async custom(investments) {
    // Per-holding fetches run concurrently — each iteration self-catches, and
    // serially one hung endpoint (10s timeout, up to 2 fetches per holding on
    // the fallback path) stalled every holding behind it.
    /** @type {Record<string, LivePriceQuote>} */
    const prices = {};
    await Promise.all(investments.map(async (inv) => {
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
    }));
    return prices;
  },

  /**
   * @param {InvestmentRow[]} investments holdings whose price_provider is 'kinesis'
   * @returns {Promise<Record<string, LivePriceQuote>>} keyed by investment id
   */
  async kinesis(investments) {
    // Same concurrency rationale as custom(): these ran one sequential fetch
    // per holding with a 15s timeout — worst case ~75s for 5 holdings.
    /** @type {Record<string, LivePriceQuote>} */
    const prices = {};
    await Promise.all(investments.map(async (inv) => {
      const { symbol, timeframe, fromDate, needsUsdToEur } = resolveKinesisConfig(inv);

      if (!symbol) {
        logger.warn(`Kinesis: no symbol configured for investment ${inv.id}`);
        return;
      }

      try {
        const url = `${KINESIS_BASE_URL}?symbolIds=${encodeURIComponent(symbol)}&timeFrame=${timeframe}&fromDate=${fromDate}`;
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          logger.warn(`Kinesis API error: ${res.status} for ${symbol}`);
          return;
        }

        _assertResponseWithinCap(res, 'Kinesis');
        const data = await res.json();
        const rawPoints = data?.[symbol];

        if (!Array.isArray(rawPoints) || rawPoints.length === 0) {
          logger.warn(`Kinesis: no data returned for ${symbol}`);
          return;
        }

        const parsedPoints = _parseKinesisTrendlinePoints(rawPoints);
        if (!parsedPoints.length) return;

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
    }));
    return prices;
  },
};

export { _parseKinesisTrendlinePoints };
