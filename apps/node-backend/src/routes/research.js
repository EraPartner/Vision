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

/// <reference path="../types/thirdPartyModules.d.ts" />
import { Router } from 'express';
import { z } from 'zod';
import { ValidationError } from '../middleware/errorHandler.js';
import { validateIdParam, assertOptionalId } from '../middleware/validation.js';
import { researchAggregator } from '../services/research/researchAggregator.js';
import { researchMappingService } from '../services/research/researchMappingService.js';
import * as researchProviderKeyService from '../services/research/researchProviderKeyService.js';
import { runPortfolioForecast } from '../services/research/projection/portfolioProjection.js';
import { fundamentalsScorecard } from '../services/research/fundamentalsScorecard.js';
import { MACRO_PROVIDERS, isValidSeriesId } from '../services/research/adapters/macroCatalog.js';

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 */

const router = Router();

// Keyed by `dataType` (a runtime string from the aggregator's capability map,
// not a closed union here), and the per-key shapes genuinely differ (items[]
// vs points[] vs a bare object) — `Record<string, any>` reflects both.
/** @type {Record<string, any>} Stable empty shapes so the frontend gets a consistent payload when unavailable. */
const EMPTY_BY_TYPE = {
  search: { items: [] },
  quote: undefined,
  chart: { points: [] },
  fundamentals: undefined,
  analyst: undefined,
  news: { articles: [] },
};

/** @param {any} value */
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
/** @param {string} message */
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
/**
 * @template T
 * @param {z.ZodType<T>} schema
 * @param {unknown} value
 * @returns {T}
 */
function parseResearchParam(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(result.error.issues.map((issue) => issue.message).join('; '));
  }
  return result.data;
}

/** @param {unknown} value */
const requireSymbol = (value) => parseResearchParam(symbolSchema, value);

/**
 * Run an aggregator fetch and emit the unified envelope with provenance meta.
 * @param {ExpressResponse} res
 * @param {string} dataType
 * @param {object} params
 */
async function respond(res, dataType, params) {
  const result = await researchAggregator.fetch(dataType, params);
  const data = result.source === 'unavailable' ? EMPTY_BY_TYPE[dataType] : result.data;
  // `ResponseMeta` (@vision/types/api) only declares `requestId`/`extra`, but
  // envelope.js's wrapResponse spreads whatever `meta` object it's given onto
  // the body directly — `provider`/`source` land at the top level at runtime
  // exactly as passed here. That's a real divergence from the documented
  // "arbitrary facts belong under meta.extra" convention (see api.js), predating
  // this annotation pass; binding to a local (not a fresh object literal) sidesteps
  // the excess-property check without changing what's sent on the wire.
  const meta = { provider: result.provider ?? null, source: result.source };
  res.ok(data ?? null, meta);
}

// GET /api/research/search?q=apple
router.get('/search', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const q = single(req.query.q);
  if (!q) {
    /** @type {{ provider: string|null, source: string }} */
    const meta = { provider: null, source: 'live' };
    return res.ok({ items: [] }, meta);
  }
  await respond(res, 'search', { symbol: q });
});

// GET /api/research/quote?symbol=AAPL&asset_class=stock
router.get('/quote', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const symbol = requireSymbol(req.query.symbol);
  await respond(res, 'quote', { symbol, assetClass: single(req.query.asset_class) || undefined });
});

// GET /api/research/chart?symbol=AAPL&asset_class=stock&range=1mo
router.get('/chart', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
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
router.get('/fundamentals', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const symbol = requireSymbol(req.query.symbol);
  const result = await researchAggregator.fetchFundamentals({
    symbol,
    assetClass: single(req.query.asset_class) || undefined,
  });
  const data = result.source === 'unavailable' ? EMPTY_BY_TYPE.fundamentals : result.data;
  // See the comment in respond() above re: ResponseMeta vs. actual meta shape.
  const meta = { provider: result.provider ?? null, source: result.source };
  res.ok(data ?? null, meta);
});

// GET /api/research/analyst?symbol=AAPL
router.get('/analyst', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const symbol = requireSymbol(req.query.symbol);
  await respond(res, 'analyst', { symbol, assetClass: single(req.query.asset_class) || undefined });
});

// GET /api/research/news?symbol=AAPL
router.get('/news', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const symbol = requireSymbol(req.query.symbol);
  await respond(res, 'news', { symbol });
});

// ─── Macro economic indicators (ADR-082) ────────────────────────────────────
// Provider-pinned (FRED / Eurostat / DBnomics), NOT raced. macro/search fans out
// and unions a catalog/search; macro/series fetches one provider's observations.

// GET /api/research/macro/search?q=inflation
router.get('/macro/search', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const q = single(req.query.q);
  if (!q) {
    /** @type {{ provider: string|null, source: string }} */
    const meta = { provider: null, source: 'live' };
    return res.ok({ items: [] }, meta);
  }
  const result = await researchAggregator.searchMacro(q);
  /** @type {{ provider: string|null, source: string }} */
  const meta = { provider: null, source: result.source };
  res.ok({ items: result.items ?? [] }, meta);
});

// GET /api/research/macro/series?provider=fred&series_id=CPIAUCSL&range=5y
router.get('/macro/series', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
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
  const meta = { provider: result.provider ?? provider, source: result.source };
  res.ok(data ?? null, meta);
});

// ─── Analytics: portfolio forecast + fundamentals scorecard (ADR-081) ───────

// GET /api/research/scorecard?symbol=AAPL — heuristic flags + health score.
router.get('/scorecard', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const symbol = requireSymbol(req.query.symbol);
  const result = await researchAggregator.fetchFundamentals({
    symbol,
    assetClass: single(req.query.asset_class) || undefined,
  });
  if (result.source === 'unavailable') {
    /** @type {{ provider: string|null, source: string }} */
    const meta = { provider: null, source: 'unavailable' };
    return res.ok(undefined, meta);
  }
  const scorecard = fundamentalsScorecard(/** @type {Record<string, unknown>} */ (result.data));
  const meta = {
    provider: result.provider ?? null,
    source: result.source,
  };
  res.ok({ symbol, fundamentals: result.data, scorecard }, meta);
});

// POST /api/research/portfolio-forecast — Monte-Carlo portfolio value projection.
// On-demand, never persisted (ADR-079 storage boundary). Deterministic per seed.
// Body keys are snake_case only — the camelCase spellings this handler used to
// also accept were a second, undocumented contract. See "Wire Casing
// Convention" in docs/reference/code-patterns.md.
router.post('/portfolio-forecast', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const body = req.body ?? {};
  const result = await runPortfolioForecast({
    horizonMonths: body.horizon_months,
    monthlyContribution: body.monthly_contribution,
    paths: body.paths,
    forwardBlend: body.forward_blend,
    method: /** @type {'parametric'|'block_bootstrap'|undefined} */ (single(body.method) || undefined),
    targetValue: body.target_value,
    currency: single(body.currency) || undefined,
    seed: single(body.seed) || undefined,
  });
  res.ok(result);
});

// ─── Cross-provider symbol mapping (ADR-079) ────────────────────────────────

/** @param {unknown} value */
const keyType = (value) => parseResearchParam(keyTypeSchema, value);
/** @param {unknown} value */
const requireInstrumentKey = (value) => parseResearchParam(instrumentKeySchema, value);

/**
 * Optional id: undefined when absent or empty, the parsed integer when valid,
 * a 400 when malformed.
 *
 * This was a `Number.parseInt` parse that answered `undefined` on failure and
 * had both of that shape's failure modes. `investment_id: '12abc'` did not
 * fail — parseInt takes the leading digits — so `resolve` pre-seeded its
 * proposals from holding 12, a record nobody named; and `'abc'` silently
 * became "no holding", answering 200 with an un-seeded result the caller
 * cannot tell from a correct one. `assertOptionalId` keeps absent meaning
 * absent and rejects the rest, matching every other id in the codebase.
 * @param {unknown} value
 * @returns {number|undefined}
 */
function optionalInvestmentId(value) {
  return assertOptionalId(value, 'investment_id') ?? undefined;
}

// GET /api/research/mappings?instrument_key=US0378331005&key_type=isin
//
// Canonical collection shape `{items, total}`; unpaginated, so `total` is the
// row count (present so pagination can land without breaking the shape).
router.get('/mappings', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const instrumentKey = requireInstrumentKey(req.query.instrument_key);
  const rows = await researchMappingService.list(instrumentKey, keyType(req.query.key_type));
  res.ok({ items: rows, total: rows.length });
});

// POST /api/research/mappings/resolve  { instrument_key, key_type, asset_class, query, investment_id }
router.post('/mappings/resolve', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const { instrument_key, key_type, asset_class, query, investment_id } = req.body ?? {};
  const q = parseResearchParam(querySchema, query);
  const result = await researchMappingService.resolve({
    instrumentKey: requireInstrumentKey(instrument_key),
    keyType: keyType(key_type),
    assetClass: single(asset_class) || undefined,
    query: q,
    investmentId: optionalInvestmentId(investment_id),
  });
  res.ok(result);
});

// POST /api/research/mappings  { instrument_key, key_type, mappings: [...] }
// Answers the updated mapping set in the same canonical `{items, total}`
// collection shape as GET /mappings (one response type for both).
router.post('/mappings', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const { instrument_key, key_type, mappings } = req.body ?? {};
  const rows = await researchMappingService.save({
    instrumentKey: requireInstrumentKey(instrument_key),
    keyType: keyType(key_type),
    // mappingsArraySchema only validates "is a non-empty array" — item shape
    // (provider/providerSymbol/...) is unchecked by zod and forwarded as-is to
    // save(), exactly as before this annotation pass; the cast documents the
    // shape save() actually reads instead of retyping the zod schema itself.
    mappings: /** @type {Array<{ provider: string, providerSymbol?: string, provider_symbol?: string, resolvedName?: string, resolved_name?: string, exchange?: string, currency?: string, status?: string }>} */ (
      parseResearchParam(mappingsArraySchema, mappings)
    ),
  });
  res.ok({ items: rows, total: rows.length });
});

// DELETE /api/research/mappings/:id
router.delete('/mappings/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Idempotent hard delete (an already-removed mapping is not an error) →
  // 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
  await researchMappingService.remove(id);
  res.status(204).send();
});

// POST /api/research/mappings/audit  { instrument_key, key_type }
router.post('/mappings/audit', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
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
//
// Canonical collection shape `{items, total}` (fixed provider roster, so
// `total` is simply the row count).
router.get('/provider-keys', /** @param {ExpressRequest} _req @param {ExpressResponse} res */ async (_req, res) => {
  const items = await researchProviderKeyService.listKeyStatuses();
  res.ok({ items, total: items.length });
});

// PUT /api/research/provider-keys/:provider  { api_key }
// Answers the refreshed statuses in the same `{items, total}` shape as the GET.
router.put('/provider-keys/:provider', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const { api_key } = req.body ?? {};
  await researchProviderKeyService.setKey(req.params.provider, api_key);
  const items = await researchProviderKeyService.listKeyStatuses();
  res.ok({ items, total: items.length });
});

// DELETE /api/research/provider-keys/:provider
router.delete('/provider-keys/:provider', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  // Idempotent hard delete (clearing an unset key is not an error) → 204 No
  // Content (docs/reference/code-patterns.md, "DELETE responses"). The Settings
  // UI refetches GET /provider-keys after a clear, so the response carries no
  // key statuses of its own.
  await researchProviderKeyService.clearKey(req.params.provider);
  res.status(204).send();
});

export default router;
