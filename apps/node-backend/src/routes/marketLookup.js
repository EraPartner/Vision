/**
 * Market Lookup routes — thin HTTP handlers over marketLookupService (ADR-067
 * route → service boundary). Each handler parses/validates the request and
 * delegates; the cache, coalescing, Yahoo client, and quote assembly all live
 * in services/marketLookupService.js.
 */

import { Router } from 'express';
import { ValidationError } from '../middleware/errorHandler.js';
import {
  getChart,
  getNews,
  getQuotes,
  searchSymbols,
} from '../services/marketLookupService.js';

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 */

const router = Router();

/** Test-only re-export: clear the per-symbol quote cache between cases. */
export { __clearQuoteCacheForTests } from '../services/marketLookupService.js';

/**
 * Coerce a query-string param to a single trimmed string. Express parses a
 * repeated key (`?symbols=A&symbols=B`) as an array — calling `.split` on it
 * throws a TypeError that surfaced as an opaque 502. Joining arrays keeps the
 * repeated-key form working and guarantees a string for callers.
 *
 * @param {unknown} value
 * @returns {string}
 */
function coerceQueryString(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(',');
  if (value == null) return '';
  return String(value);
}

// GET /api/market/search?q=apple
router.get('/search', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 1) return res.ok({ items: [] });

  res.ok(await searchSymbols(q));
});

// GET /api/market/quote?symbols=AAPL,MSFT[&detail=basic]
// `detail=basic` returns price fields only; the default (full) additionally
// fetches quoteSummary for fundamentals/analyst data. Results are per-symbol
// cached and concurrent identical fetches are coalesced (see the service).
router.get('/quote', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const symbols = coerceQueryString(req.query.symbols);
  if (!symbols) throw new ValidationError('symbols parameter required');
  const basic = coerceQueryString(req.query.detail).trim() === 'basic';

  const symbolList = symbols.split(',').map((s) => s.trim()).filter(Boolean);

  res.ok(await getQuotes(symbolList, basic));
});

// GET /api/market/chart?symbol=AAPL&range=1mo&interval=1d
router.get('/chart', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const symbol = coerceQueryString(req.query.symbol);
  // `range`/`interval` are passed through untouched — yahoo-finance2 validates
  // them against its own literal-union types, so leave them loosely typed.
  const { range, interval } = req.query;
  if (!symbol) throw new ValidationError('symbol parameter required');

  res.ok(await getChart(symbol, { range, interval }));
});

// GET /api/market/news?symbols=AAPL,MSFT&count=20
router.get('/news', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const symbols = coerceQueryString(req.query.symbols);
  const count = coerceQueryString(req.query.count) || '20';

  res.ok(await getNews(symbols, count));
});

export default router;
