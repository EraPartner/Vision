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
import { z } from 'zod';
import { ValidationError } from '../middleware/errorHandler.js';
import { researchAggregator } from '../services/research/researchAggregator.js';
import { researchMappingService } from '../services/research/researchMappingService.js';
import * as researchProviderKeyService from '../services/research/researchProviderKeyService.js';
import { runPortfolioForecast } from '../services/research/projection/portfolioProjection.js';
import { fundamentalsScorecard } from '../services/research/fundamentalsScorecard.js';
import { MACRO_PROVIDERS, isValidSeriesId } from '../services/research/adapters/macroCatalog.js';

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

/* ── Zod schemas ─────────────────────────────────────────────────────────────
 * Query/body params are validated with zod (schema → safeParse →
 * ValidationError), the idiom established in settings.js/reports.js. single()
 * stays as the shared array/scalar normalization step feeding the schemas.
 */

// A required param: single()-normalized, must be non-empty after trimming.
const requiredParamSchema = (message) =>
  z.unknown().transform(single).refine((value) => value.length > 0, { error: message });

const symbolSchema = requiredParamSchema('symbol parameter required');
const instrumentKeySchema = requiredParamSchema('instrument_key required');
const querySchema = requiredParamSchema('query required');

const keyTypeSchema = z.unknown()
  .transform((value) => single(value) || 'isin')
  .pipe(z.enum(['isin', 'internal'], { error: "key_type must be 'isin' or 'internal'" }));

const macroProviderSchema = z.unknown()
  .transform(single)
  .pipe(z.enum(MACRO_PROVIDERS, { error: `provider must be one of: ${MACRO_PROVIDERS.join(', ')}` }));

const mappingsArraySchema = z.array(z.unknown(), { error: 'mappings must be a non-empty array' })
  .min(1, { error: 'mappings must be a non-empty array' });

// schema → safeParse → joined issues → ValidationError (settings.js idiom).
// Messages already name their param, so issues join without path prefixes.
function parseResearchParam(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(result.error.issues.map((issue) => issue.message).join('; '));
  }
  return result.data;
}

const requireSymbol = (value) => parseResearchParam(symbolSchema, value);

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
  const symbol = requireSymbol(req.query.symbol);
  await respond(res, 'quote', { symbol, assetClass: single(req.query.asset_class) || undefined });
});

// GET /api/research/chart?symbol=AAPL&asset_class=stock&range=1mo
router.get('/chart', async (req, res) => {
  const symbol = requireSymbol(req.query.symbol);
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
  const symbol = requireSymbol(req.query.symbol);
  const result = await researchAggregator.fetchFundamentals({
    symbol,
    assetClass: single(req.query.asset_class) || undefined,
  });
  const data = result.source === 'unavailable' ? EMPTY_BY_TYPE.fundamentals : result.data;
  res.ok(data ?? null, { provider: result.provider ?? null, source: result.source });
});

// GET /api/research/analyst?symbol=AAPL
router.get('/analyst', async (req, res) => {
  const symbol = requireSymbol(req.query.symbol);
  await respond(res, 'analyst', { symbol, assetClass: single(req.query.asset_class) || undefined });
});

// GET /api/research/news?symbol=AAPL
router.get('/news', async (req, res) => {
  const symbol = requireSymbol(req.query.symbol);
  await respond(res, 'news', { symbol });
});

// ─── Macro economic indicators (ADR-082) ────────────────────────────────────
// Provider-pinned (FRED / Eurostat / DBnomics), NOT raced. macro/search fans out
// and unions a catalog/search; macro/series fetches one provider's observations.

// GET /api/research/macro/search?q=inflation
router.get('/macro/search', async (req, res) => {
  const q = single(req.query.q);
  if (!q) return res.ok({ items: [] }, { provider: null, source: 'live' });
  const result = await researchAggregator.searchMacro(q);
  res.ok({ items: result.items ?? [] }, { provider: null, source: result.source });
});

// GET /api/research/macro/series?provider=fred&series_id=CPIAUCSL&range=5y
router.get('/macro/series', async (req, res) => {
  const provider = parseResearchParam(macroProviderSchema, req.query.provider);
  const seriesId = single(req.query.series_id);
  // Cross-field: the series_id shape depends on the (validated) provider, so
  // this stays a one-line guard instead of an object schema.
  if (!isValidSeriesId(provider, seriesId)) {
    throw new ValidationError('valid series_id required for the given provider');
  }
  const range = single(req.query.range) || '5y';
  const result = await researchAggregator.fetchMacroSeries({ provider, seriesId, range });
  const data = result.source === 'unavailable' ? { provider, seriesId, points: [] } : result.data;
  res.ok(data ?? null, { provider: result.provider ?? provider, source: result.source });
});

// ─── Analytics: portfolio forecast + fundamentals scorecard (ADR-081) ───────

// GET /api/research/scorecard?symbol=AAPL — heuristic flags + health score.
router.get('/scorecard', async (req, res) => {
  const symbol = requireSymbol(req.query.symbol);
  const result = await researchAggregator.fetchFundamentals({
    symbol,
    assetClass: single(req.query.asset_class) || undefined,
  });
  if (result.source === 'unavailable') {
    return res.ok(undefined, { provider: null, source: 'unavailable' });
  }
  const scorecard = fundamentalsScorecard(/** @type {Record<string, unknown>} */ (result.data));
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
    method: /** @type {'parametric'|'block_bootstrap'|undefined} */ (single(body.method) || undefined),
    targetValue: body.target_value ?? body.targetValue,
    currency: single(body.currency) || undefined,
    seed: single(body.seed) || undefined,
  });
  res.ok(result);
});

// ─── Cross-provider symbol mapping (ADR-079) ────────────────────────────────

const keyType = (value) => parseResearchParam(keyTypeSchema, value);
const requireInstrumentKey = (value) => parseResearchParam(instrumentKeySchema, value);

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
  const q = parseResearchParam(querySchema, query);
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
  const rows = await researchMappingService.save({
    instrumentKey: requireInstrumentKey(instrument_key),
    keyType: keyType(key_type),
    mappings: parseResearchParam(mappingsArraySchema, mappings),
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
