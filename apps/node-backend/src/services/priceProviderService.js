/**
 * Price Provider Service
 * Fetches live prices from CoinGecko, Yahoo Finance, Kraken, or custom JSON endpoints.
 */

import { logger } from '../config/logger.js';
import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ─── In-process price cache (5-minute TTL) ───────────────────────────────────
// Key: `${provider}:${providerId}` — Value: { data, expiresAt }
const PRICE_CACHE_TTL_MS = 5 * 60_000;
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
   * CoinGecko — free API, no key required.
   * price_provider_id = coingecko coin id, e.g. "bitcoin", "ethereum"
   */
  async coingecko(providerIds) {
    const ids = providerIds.join(',');
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd,eur`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`);
    const data = await res.json();

    const prices = {};
    for (const id of providerIds) {
      if (data[id]) {
        prices[id] = {
          usd: data[id].usd || null,
          eur: data[id].eur || null,
        };
      }
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
   * Kraken — public API, no key required.
   * price_provider_id = Kraken pair, e.g. "XBTUSD", "ETHUSD"
   */
  async kraken(providerIds) {
    const pairs = providerIds.join(',');
    const url = `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pairs)}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`Kraken API error: ${res.status}`);
    const data = await res.json();

    if (data.error && data.error.length > 0) {
      throw new Error(`Kraken API error: ${data.error.join(', ')}`);
    }

    const prices = {};
    for (const [pair, info] of Object.entries(data.result || {})) {
      // Kraken returns last trade price in 'c' array [price, lot_volume]
      prices[pair] = {
        price: parseFloat(info.c[0]),
      };
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
  const stale = { coingecko: [], yahoo: [], kraken: [], custom: [] };
  for (const inv of investments) {
    const provider = inv.price_provider || 'manual';
    if (provider === 'manual') continue;
    const providerKey = provider === 'yahoo'
      ? _resolveYahooSymbol(inv)
      : (inv.price_provider_id || '');
    if (!providerKey && provider !== 'custom') continue;

    const cacheKey = provider === 'custom' ? `custom:${inv.id}` : `${provider}:${providerKey}`;
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

  // CoinGecko batch
  if (stale.coingecko.length) {
    try {
      const ids = stale.coingecko.map(i => i.price_provider_id).filter(Boolean);
      const prices = await PROVIDERS.coingecko(ids);
      for (const inv of stale.coingecko) {
        const pid = inv.price_provider_id;
        if (prices[pid]) {
          const currency = (inv.currency || 'EUR').toUpperCase();
          const price = prices[pid][currency.toLowerCase()] || prices[pid].usd || prices[pid].eur;
          if (_isValidPrice(price)) {
            results[inv.id] = { price, source: 'live' };
            _cacheSet(`coingecko:${pid}`, { price, source: 'live' });
          }
        }
      }
    } catch (err) {
      logger.error('CoinGecko batch fetch failed', { error: err.message });
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

  // Kraken batch
  if (stale.kraken.length) {
    try {
      const ids = stale.kraken.map(i => i.price_provider_id).filter(Boolean);
      const prices = await PROVIDERS.kraken(ids);
      for (const inv of stale.kraken) {
        const pid = inv.price_provider_id;
        const match = Object.entries(prices).find(([key]) =>
          key === pid || key.includes(pid) || pid.includes(key)
        );
        if (match) {
          const price = match[1].price;
          if (_isValidPrice(price)) {
            results[inv.id] = { price, source: 'live' };
            _cacheSet(`kraken:${pid}`, { price, source: 'live' });
          }
        }
      }
    } catch (err) {
      logger.error('Kraken batch fetch failed', { error: err.message });
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

  for (const inv of investments) {
    if (results[inv.id] !== undefined) continue;
    const cachedPrice = _toNumber(cachedPricesByInvestmentId[inv.id]);
    if (_isValidPrice(cachedPrice)) {
      results[inv.id] = { price: cachedPrice, source: 'cached' };
    }
  }

  return results;
}

export async function fetchHistoricalPrices(investment, { fromMs, toMs } = {}) {
  if (!investment) return [];
  const provider = (investment.price_provider || 'manual');

  if (provider === 'yahoo') {
    const symbol = _resolveYahooSymbol(investment);
    if (!symbol) return [];

    const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : undefined;
    const to = Number.isFinite(Number(toMs)) ? Number(toMs) : undefined;
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

        points = (chart?.quotes || [])
          .map((q) => ({
            timestampMs: q?.date ? new Date(q.date).getTime() : Number.NaN,
            price: _toNumber(q?.close),
          }))
          .filter((p) => Number.isFinite(p.timestampMs) && _isValidPrice(p.price));

        _cacheSet(cacheKey, { points, source: 'live' });
      } catch (err) {
        logger.warn(`Yahoo history fetch error for ${symbol}: ${err.message}`);
        return [];
      }
    }

    return points.filter((p) => {
      if (from !== undefined && p.timestampMs < from) return false;
      if (to !== undefined && p.timestampMs > to) return false;
      return true;
    });
  }

  if (provider !== 'custom') return [];

  const config = _resolveCustomHistoryConfig(investment);
  if (!config.historyUrl) return [];

  const cacheKey = `custom-history:${investment.id}:${config.historyUrl}:${config.historyPath}:${config.timestampPath}:${config.pricePath}`;
  const cached = _cacheGet(cacheKey);
  let points = Array.isArray(cached?.points) ? cached.points : undefined;

  if (!points) {
    try {
      const data = await _fetchJson(config.historyUrl);
      points = _parseCustomHistoryPoints(data, config);
      _cacheSet(cacheKey, { points, source: 'live' });
    } catch (err) {
      logger.warn(`Custom history fetch error for investment ${investment.id}: ${err.message}`);
      return [];
    }
  }

  const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : undefined;
  const to = Number.isFinite(Number(toMs)) ? Number(toMs) : undefined;

  return points.filter((p) => {
    if (from !== undefined && p.timestampMs < from) return false;
    if (to !== undefined && p.timestampMs > to) return false;
    return true;
  });
}

export function __resetPriceCache() {
  _priceCache.clear();
}

export const SUPPORTED_PROVIDERS = [
  { key: 'manual', name: 'Manual', description: 'Set price manually' },
  { key: 'coingecko', name: 'CoinGecko', description: 'Free crypto prices (use coin ID, e.g. "bitcoin")' },
  { key: 'yahoo', name: 'Yahoo Finance', description: 'Stocks, ETFs & metals (use ticker, e.g. "AAPL", "VWCE.DE", "GC=F")' },
  { key: 'kraken', name: 'Kraken', description: 'Crypto pairs (use pair, e.g. "XBTUSD")' },
  { key: 'custom', name: 'Custom JSON', description: 'Any JSON endpoint with a configurable price path' },
];
