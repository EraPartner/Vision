/**
 * Research routes (ADR-079) — provider-agnostic market research surface.
 *
 * Each endpoint maps to one capability-map data type and delegates to the
 * research aggregator, which routes across providers (Yahoo today; Twelve Data /
 * Finnhub / FMP / Alpha Vantage light up as keys are provisioned) under the
 * quota governor and type-aware cache. One endpoint = one data type keeps the
 * field-merge lazy per research tab.
 *
 * Responses carry `meta.provider` (which provider answered, or null) and
 * `meta.source` ('cache' | 'live' | 'unavailable') so the UI can show provenance
 * and a "not mapped / unavailable" state instead of a silent empty.
 */

import { Router } from 'express';
import { ValidationError } from '../middleware/errorHandler.js';
import { researchAggregator } from '../services/research/researchAggregator.js';
import { researchMappingService } from '../services/research/researchMappingService.js';
import * as researchProviderKeyService from '../services/research/researchProviderKeyService.js';
import { runPortfolioForecast } from '../services/research/projection/portfolioProjection.js';
import { fundamentalsScorecard } from '../services/research/fundamentalsScorecard.js';

const router = Router();

/** Stable empty shapes so the frontend gets a consistent payload when unavailable. */
const EMPTY_BY_TYPE = {
  search: { items: [] },
  quote: undefined,
  chart: { points: [] },
  fundamentals: undefined,
  analyst: undefined,
  news: { articles: [] },
};

function single(value) {
  if (Array.isArray(value)) return value.length ? String(value[0]) : '';
  if (value == null) return '';
  return String(value).trim();
}

/**
 * Run an aggregator fetch and emit the unified envelope with provenance meta.
 * @param {import('express').Response} res
 * @param {string} dataType
 * @param {object} params
 */
async function respond(res, dataType, params) {
  const result = await researchAggregator.fetch(dataType, params);
  const data = result.source === 'unavailable' ? EMPTY_BY_TYPE[dataType] : result.data;
  res.ok(data ?? null, { provider: result.provider ?? null, source: result.source });
}

// GET /api/research/search?q=apple
router.get('/search', async (req, res) => {
  const q = single(req.query.q);
  if (!q) return res.ok({ items: [] }, { provider: null, source: 'live' });
  await respond(res, 'search', { symbol: q });
});

// GET /api/research/quote?symbol=AAPL&asset_class=stock
router.get('/quote', async (req, res) => {
  const symbol = single(req.query.symbol);
  if (!symbol) throw new ValidationError('symbol parameter required');
  await respond(res, 'quote', { symbol, assetClass: single(req.query.asset_class) || undefined });
});

// GET /api/research/chart?symbol=AAPL&asset_class=stock&range=1mo
router.get('/chart', async (req, res) => {
  const symbol = single(req.query.symbol);
  if (!symbol) throw new ValidationError('symbol parameter required');
  await respond(res, 'chart', {
    symbol,
    assetClass: single(req.query.asset_class) || undefined,
    range: single(req.query.range) || '1mo',
  });
});

// GET /api/research/fundamentals?symbol=AAPL
// Fundamentals are MERGED across FMP + Yahoo (FMP preferred, Yahoo fills gaps),
// not raced like the other data types.
router.get('/fundamentals', async (req, res) => {
  const symbol = single(req.query.symbol);
  if (!symbol) throw new ValidationError('symbol parameter required');
  const result = await researchAggregator.fetchFundamentals({
    symbol,
    assetClass: single(req.query.asset_class) || undefined,
  });
  const data = result.source === 'unavailable' ? EMPTY_BY_TYPE.fundamentals : result.data;
  res.ok(data ?? null, { provider: result.provider ?? null, source: result.source });
});

// GET /api/research/analyst?symbol=AAPL
router.get('/analyst', async (req, res) => {
  const symbol = single(req.query.symbol);
  if (!symbol) throw new ValidationError('symbol parameter required');
  await respond(res, 'analyst', { symbol, assetClass: single(req.query.asset_class) || undefined });
});

// GET /api/research/news?symbol=AAPL
router.get('/news', async (req, res) => {
  const symbol = single(req.query.symbol);
  if (!symbol) throw new ValidationError('symbol parameter required');
  await respond(res, 'news', { symbol });
});

// ─── Analytics: portfolio forecast + fundamentals scorecard (ADR-081) ───────

// GET /api/research/scorecard?symbol=AAPL — heuristic flags + health score.
router.get('/scorecard', async (req, res) => {
  const symbol = single(req.query.symbol);
  if (!symbol) throw new ValidationError('symbol parameter required');
  const result = await researchAggregator.fetchFundamentals({
    symbol,
    assetClass: single(req.query.asset_class) || undefined,
  });
  if (result.source === 'unavailable') {
    return res.ok(undefined, { provider: null, source: 'unavailable' });
  }
  const scorecard = fundamentalsScorecard(result.data);
  res.ok({ symbol, fundamentals: result.data, scorecard }, {
    provider: result.provider ?? null,
    source: result.source,
  });
});

// POST /api/research/portfolio-forecast — Monte-Carlo portfolio value projection.
// On-demand, never persisted (ADR-079 storage boundary). Deterministic per seed.
router.post('/portfolio-forecast', async (req, res) => {
  const body = req.body ?? {};
  const result = await runPortfolioForecast({
    horizonMonths: body.horizon_months ?? body.horizonMonths,
    monthlyContribution: body.monthly_contribution ?? body.monthlyContribution,
    paths: body.paths,
    forwardBlend: body.forward_blend ?? body.forwardBlend,
    method: single(body.method) || undefined,
    targetValue: body.target_value ?? body.targetValue,
    currency: single(body.currency) || undefined,
    seed: single(body.seed) || undefined,
  });
  res.ok(result);
});

// ─── Cross-provider symbol mapping (ADR-079) ────────────────────────────────

const KEY_TYPES = new Set(['isin', 'internal']);

function keyType(value) {
  const v = single(value) || 'isin';
  if (!KEY_TYPES.has(v)) throw new ValidationError("key_type must be 'isin' or 'internal'");
  return v;
}

function requireInstrumentKey(value) {
  const key = single(value);
  if (!key) throw new ValidationError('instrument_key required');
  return key;
}

/** Coerce an optional id to a positive integer; undefined when absent or invalid. */
function positiveInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// GET /api/research/mappings?instrument_key=US0378331005&key_type=isin
router.get('/mappings', async (req, res) => {
  const instrumentKey = requireInstrumentKey(req.query.instrument_key);
  const rows = await researchMappingService.list(instrumentKey, keyType(req.query.key_type));
  res.ok({ mappings: rows });
});

// POST /api/research/mappings/resolve  { instrument_key, key_type, asset_class, query, investment_id }
router.post('/mappings/resolve', async (req, res) => {
  const { instrument_key, key_type, asset_class, query, investment_id } = req.body ?? {};
  const q = single(query);
  if (!q) throw new ValidationError('query required');
  const result = await researchMappingService.resolve({
    instrumentKey: requireInstrumentKey(instrument_key),
    keyType: keyType(key_type),
    assetClass: single(asset_class) || undefined,
    query: q,
    investmentId: positiveInt(investment_id),
  });
  res.ok(result);
});

// POST /api/research/mappings  { instrument_key, key_type, mappings: [...] }
router.post('/mappings', async (req, res) => {
  const { instrument_key, key_type, mappings } = req.body ?? {};
  if (!Array.isArray(mappings) || mappings.length === 0) {
    throw new ValidationError('mappings must be a non-empty array');
  }
  const rows = await researchMappingService.save({
    instrumentKey: requireInstrumentKey(instrument_key),
    keyType: keyType(key_type),
    mappings,
  });
  res.ok({ mappings: rows });
});

// DELETE /api/research/mappings/:id
router.delete('/mappings/:id', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('valid mapping id required');
  const removed = await researchMappingService.remove(id);
  res.ok({ removed });
});

// POST /api/research/mappings/audit  { instrument_key, key_type }
router.post('/mappings/audit', async (req, res) => {
  const { instrument_key, key_type } = req.body ?? {};
  const result = await researchMappingService.audit({
    instrumentKey: requireInstrumentKey(instrument_key),
    keyType: keyType(key_type),
  });
  res.ok(result);
});

// ─── Provider API keys (Settings UI, ADR-079) ───────────────────────────────
// Keys are masked in responses and never returned in full.

// GET /api/research/provider-keys
router.get('/provider-keys', async (_req, res) => {
  const providers = await researchProviderKeyService.listKeyStatuses();
  res.ok({ providers });
});

// PUT /api/research/provider-keys/:provider  { api_key }
router.put('/provider-keys/:provider', async (req, res) => {
  const { api_key } = req.body ?? {};
  await researchProviderKeyService.setKey(req.params.provider, api_key);
  const providers = await researchProviderKeyService.listKeyStatuses();
  res.ok({ providers });
});

// DELETE /api/research/provider-keys/:provider
router.delete('/provider-keys/:provider', async (req, res) => {
  const removed = await researchProviderKeyService.clearKey(req.params.provider);
  const providers = await researchProviderKeyService.listKeyStatuses();
  res.ok({ removed, providers });
});

export default router;
