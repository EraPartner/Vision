/**
 * Price Provider Service
 * Fetches live prices from CoinGecko, Yahoo Finance, Kraken, or custom JSON endpoints.
 */

import { logger } from '../config/logger.js';

// ─── In-process price cache (5-minute TTL) ───────────────────────────────────
// Key: `${provider}:${providerId}` — Value: { data, expiresAt }
const PRICE_CACHE_TTL_MS = 5 * 60_000;
const _priceCache = new Map();

function _cacheGet(key) {
  const entry = _priceCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { _priceCache.delete(key); return undefined; }
  return entry.data;
}

function _cacheSet(key, data) {
  _priceCache.set(key, { data, expiresAt: Date.now() + PRICE_CACHE_TTL_MS });
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
    const symbols = providerIds.join(',');
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,currency`;
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Vision/1.0',
      },
    });
    if (!res.ok) throw new Error(`Yahoo Finance API error: ${res.status}`);
    const data = await res.json();

    const prices = {};
    const quotes = data?.quoteResponse?.result || [];
    for (const quote of quotes) {
      const symbol = quote.symbol;
      if (symbol && quote.regularMarketPrice != null) {
        prices[symbol.toUpperCase()] = {
          price: quote.regularMarketPrice,
          currency: quote.currency || 'USD',
        };
      }
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
      if (!inv.price_provider_url) continue;
      try {
        const res = await fetch(inv.price_provider_url, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          logger.warn(`Custom price fetch failed for ${inv.id}: HTTP ${res.status}`);
          continue;
        }
        const data = await res.json();

        // Navigate the JSON path
        const path = (inv.price_provider_id || 'price').split('.');
        let value = data;
        for (const key of path) {
          if (value == null) break;
          value = value[key];
        }
        const price = parseFloat(value);
        if (!isNaN(price)) {
          prices[inv.id] = { price };
        }
      } catch (err) {
        logger.warn(`Custom price fetch error for investment ${inv.id}: ${err.message}`);
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
  const results = {};

  // Serve cached prices immediately; only fetch stale/missing ones
  const stale = { coingecko: [], yahoo: [], kraken: [], custom: [] };
  for (const inv of investments) {
    const provider = inv.price_provider || 'manual';
    if (provider === 'manual') continue;
    const cacheKey = provider === 'custom' ? `custom:${inv.id}` : `${provider}:${inv.price_provider_id}`;
    const cached = _cacheGet(cacheKey);
    if (cached !== undefined) {
      results[inv.id] = cached;
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
          results[inv.id] = price;
          _cacheSet(`coingecko:${pid}`, price);
        }
      }
    } catch (err) {
      logger.error('CoinGecko batch fetch failed', { error: err.message });
    }
  }

  // Yahoo Finance batch
  if (stale.yahoo.length) {
    try {
      const ids = stale.yahoo.map(i => i.price_provider_id).filter(Boolean);
      const prices = await PROVIDERS.yahoo(ids);
      for (const inv of stale.yahoo) {
        const pid = (inv.price_provider_id || '').toUpperCase();
        if (prices[pid]) {
          results[inv.id] = prices[pid].price;
          _cacheSet(`yahoo:${pid}`, prices[pid].price);
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
          results[inv.id] = match[1].price;
          _cacheSet(`kraken:${pid}`, match[1].price);
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
          results[inv.id] = data.price;
          _cacheSet(`custom:${inv.id}`, data.price);
        }
      }
    } catch (err) {
      logger.error('Custom price fetch failed', { error: err.message });
    }
  }

  return results;
}

export const SUPPORTED_PROVIDERS = [
  { key: 'manual', name: 'Manual', description: 'Set price manually' },
  { key: 'coingecko', name: 'CoinGecko', description: 'Free crypto prices (use coin ID, e.g. "bitcoin")' },
  { key: 'yahoo', name: 'Yahoo Finance', description: 'Stocks & ETFs (use ticker, e.g. "AAPL", "VWCE.DE")' },
  { key: 'kraken', name: 'Kraken', description: 'Crypto pairs (use pair, e.g. "XBTUSD")' },
  { key: 'custom', name: 'Custom JSON', description: 'Any JSON endpoint with a configurable price path' },
];
