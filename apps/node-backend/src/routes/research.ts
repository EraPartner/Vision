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

import { Router } from "express";
import type { ExpressResponse } from "../types/express.ts";
import { z } from "zod";
import { ValidationError } from "../middleware/errorHandler.ts";
import { parseInput } from "../lib/zodInput.ts";
import { KEYED_PROVIDERS } from "../services/research/providerKeys.ts";
import {
  validateIdParam,
  assertOptionalId,
  assertIdParam,
} from "../middleware/validation.ts";
import { researchAggregator } from "../services/research/researchAggregator.ts";
import { researchMappingService } from "../services/research/researchMappingService.ts";
import * as researchProviderKeyService from "../services/research/researchProviderKeyService.ts";
import { runPortfolioForecast } from "../services/research/projection/portfolioProjection.ts";
import type { PortfolioForecastInput } from "../services/research/projection/portfolioProjection.ts";
import { fundamentalsScorecard } from "../services/research/fundamentalsScorecard.ts";
import {
  MACRO_PROVIDERS,
  isValidSeriesId,
} from "../services/research/adapters/macroCatalog.ts";

const router = Router();

// Keyed by `dataType` (a runtime string from the aggregator's capability map,
// not a closed union here), and the per-key shapes genuinely differ (items[]
// vs points[] vs a bare object) — `Record<string, unknown>` reflects both.
/** Stable empty shapes so the frontend gets a consistent payload when unavailable. */
const EMPTY_BY_TYPE: Record<string, unknown> = {
  search: { items: [] },
  quote: undefined,
  chart: { points: [] },
  fundamentals: undefined,
  analyst: undefined,
  news: { articles: [] },
};

function single(value: unknown): string {
  if (Array.isArray(value)) return value.length ? String(value[0]).trim() : "";
  if (value == null) return "";
  return String(value).trim();
}

/* ── Zod schemas ─────────────────────────────────────────────────────────────
 * Query/body params are parsed one at a time with parseInput (ADR-193), so
 * each issue is reported at the root and keeps its established message (the
 * messages already name their param). single() stays as the shared
 * array/scalar normalization step feeding the schemas.
 */

// An optional free-text param: single()-normalized, empty when absent.
const optionalParamSchema = z.unknown().optional().transform(single);
const optionalParam = (value: unknown) =>
  parseInput(optionalParamSchema, value);

// A required param: single()-normalized, must be non-empty after trimming.
const requiredParamSchema = (message: string) =>
  z
    .unknown()
    .transform(single)
    .refine((value) => value.length > 0, { error: message });

const symbolSchema = requiredParamSchema("symbol parameter required");
const instrumentKeySchema = requiredParamSchema("instrument_key required");
const querySchema = requiredParamSchema("query required");

const keyTypeSchema = z
  .unknown()
  .transform((value) => single(value) || "isin")
  .pipe(
    z.enum(["isin", "internal"], {
      error: "key_type must be 'isin' or 'internal'",
    }),
  );

const macroProviderSchema = z
  .unknown()
  .transform(single)
  .pipe(
    z.enum(MACRO_PROVIDERS, {
      error: `provider must be one of: ${MACRO_PROVIDERS.join(", ")}`,
    }),
  );

// Proposal fields may be null (MappingProposal); the repository stores null
// and undefined alike.
const optionalMappingText = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);

// The fields researchMappingService.save() reads (camelCase or snake_case).
// A missing provider used to reach the NOT NULL column as a 500.
const mappingItemSchema = z.object({
  provider: z.string().min(1),
  providerSymbol: optionalMappingText,
  provider_symbol: optionalMappingText,
  resolvedName: optionalMappingText,
  resolved_name: optionalMappingText,
  exchange: optionalMappingText,
  currency: optionalMappingText,
  status: optionalMappingText,
});

const mappingsArraySchema = z
  .array(mappingItemSchema, { error: "mappings must be a non-empty array" })
  .min(1, { error: "mappings must be a non-empty array" });

const providerParamSchema = z
  .string()
  .refine((provider) => KEYED_PROVIDERS.includes(provider), {
    error: (issue) => `Unknown keyed provider: ${String(issue.input)}`,
  });

const apiKeySchema = z
  .string({ error: "api_key must be a non-empty string" })
  .trim()
  .min(1, "api_key must be a non-empty string");

const requireSymbol = (value: unknown) => parseInput(symbolSchema, value);

/** Run an aggregator fetch and emit the unified envelope with provenance meta. */
async function respond(
  // The envelope middleware always installs `ok`; ExpressResponse marks it optional.
  res: Required<Pick<ExpressResponse, "ok">>,
  dataType: string,
  params: { symbol?: string; assetClass?: string; range?: string },
): Promise<void> {
  const result = await researchAggregator.fetch(dataType, params);
  const data =
    result.source === "unavailable" ? EMPTY_BY_TYPE[dataType] : result.data;
  // Provenance facts are route-specific envelope metadata and live beside the
  // requestId at the top level (packages/types/src/api.ts).
  const meta = { provider: result.provider ?? null, source: result.source };
  res.ok(data ?? null, meta);
}

// GET /api/research/search?q=apple
router.get("/search", async (req, res) => {
  const q = optionalParam(req.query.q);
  if (!q) {
    const meta: { provider: string | null; source: string } = {
      provider: null,
      source: "live",
    };
    return res.ok({ items: [] }, meta);
  }
  await respond(res, "search", { symbol: q });
});

// GET /api/research/quote?symbol=AAPL&asset_class=stock
router.get("/quote", async (req, res) => {
  const symbol = requireSymbol(req.query.symbol);
  await respond(res, "quote", {
    symbol,
    assetClass: optionalParam(req.query.asset_class) || undefined,
  });
});

// GET /api/research/chart?symbol=AAPL&asset_class=stock&range=1mo
router.get("/chart", async (req, res) => {
  const symbol = requireSymbol(req.query.symbol);
  await respond(res, "chart", {
    symbol,
    assetClass: optionalParam(req.query.asset_class) || undefined,
    range: optionalParam(req.query.range) || "1mo",
  });
});

// GET /api/research/fundamentals?symbol=AAPL
// Fundamentals are MERGED across FMP + Yahoo (FMP preferred, Yahoo fills gaps),
// not raced like the other data types.
router.get("/fundamentals", async (req, res) => {
  const symbol = requireSymbol(req.query.symbol);
  const result = await researchAggregator.fetchFundamentals({
    symbol,
    assetClass: optionalParam(req.query.asset_class) || undefined,
  });
  const data =
    result.source === "unavailable" ? EMPTY_BY_TYPE.fundamentals : result.data;
  // See the provenance metadata convention in respond() above.
  const meta = { provider: result.provider ?? null, source: result.source };
  res.ok(data ?? null, meta);
});

// GET /api/research/analyst?symbol=AAPL
router.get("/analyst", async (req, res) => {
  const symbol = requireSymbol(req.query.symbol);
  await respond(res, "analyst", {
    symbol,
    assetClass: optionalParam(req.query.asset_class) || undefined,
  });
});

// GET /api/research/news?symbol=AAPL
router.get("/news", async (req, res) => {
  const symbol = requireSymbol(req.query.symbol);
  await respond(res, "news", { symbol });
});

// ─── Macro economic indicators (ADR-082) ────────────────────────────────────
// Provider-pinned (FRED / Eurostat / DBnomics), NOT raced. macro/search fans out
// and unions a catalog/search; macro/series fetches one provider's observations.

// GET /api/research/macro/search?q=inflation
router.get("/macro/search", async (req, res) => {
  const q = optionalParam(req.query.q);
  if (!q) {
    const meta: { provider: string | null; source: string } = {
      provider: null,
      source: "live",
    };
    return res.ok({ items: [] }, meta);
  }
  const result = await researchAggregator.searchMacro(q);
  const meta: { provider: string | null; source: string } = {
    provider: null,
    source: result.source,
  };
  res.ok({ items: result.items ?? [] }, meta);
});

// GET /api/research/macro/series?provider=fred&series_id=CPIAUCSL&range=5y
router.get("/macro/series", async (req, res) => {
  const provider = parseInput(macroProviderSchema, req.query.provider);
  const seriesId = optionalParam(req.query.series_id);
  // Cross-field: the series_id shape depends on the (validated) provider, so
  // this stays a one-line guard instead of an object schema.
  if (!isValidSeriesId(provider, seriesId)) {
    throw new ValidationError(
      "valid series_id required for the given provider",
    );
  }
  const range = optionalParam(req.query.range) || "5y";
  const result = await researchAggregator.fetchMacroSeries({
    provider,
    seriesId,
    range,
  });
  const data =
    result.source === "unavailable"
      ? { provider, seriesId, title: seriesId, points: [] }
      : result.data;
  const meta = {
    provider: result.provider ?? provider,
    source: result.source,
  };
  res.ok(data ?? null, meta);
});

// ─── Analytics: portfolio forecast + fundamentals scorecard (ADR-081) ───────

// GET /api/research/scorecard?symbol=AAPL — heuristic flags + health score.
router.get("/scorecard", async (req, res) => {
  const symbol = requireSymbol(req.query.symbol);
  const result = await researchAggregator.fetchFundamentals({
    symbol,
    assetClass: optionalParam(req.query.asset_class) || undefined,
  });
  if (result.source === "unavailable") {
    const meta: { provider: string | null; source: string } = {
      provider: null,
      source: "unavailable",
    };
    return res.ok(null, meta);
  }
  // Aggregator payloads are untyped; fundamentalsScorecard re-checks the shape
  // and answers its empty scorecard for anything that is not an object.
  const scorecard = fundamentalsScorecard(
    result.data as Record<string, unknown> | undefined,
  );
  const meta = {
    provider: result.provider ?? null,
    source: result.source,
  };
  res.ok({ symbol, fundamentals: result.data, scorecard }, meta);
});

// Numeric knobs stay lenient: Number() here, then the service clamps or falls
// back to its defaults exactly as it did for the raw values. Absent stays
// absent (goal_month in particular is only honoured when supplied).
const lenientNumber = z
  .unknown()
  .optional()
  .transform((value) => (value === undefined ? undefined : Number(value)));

const portfolioForecastSchema = z
  .object({
    horizon_months: lenientNumber,
    monthly_contribution: lenientNumber,
    monthly_contribution_schedule: z.unknown().optional(),
    paths: lenientNumber,
    forward_blend: lenientNumber,
    method: optionalParamSchema,
    target_value: lenientNumber,
    goal_month: z.unknown().optional(),
    currency: optionalParamSchema,
    seed: optionalParamSchema,
  })
  // Cross-field rules depend on the effective horizon, so they run on the
  // whole body and report unprefixed messages.
  .transform((body, ctx): PortfolioForecastInput => {
    const requestedHorizon = Number(body.horizon_months);
    const horizon = Number.isFinite(requestedHorizon)
      ? Math.min(600, Math.max(1, Math.round(requestedHorizon)))
      : 120;
    let schedule: number[] | undefined;
    if (body.monthly_contribution_schedule !== undefined) {
      const parsed = z
        .array(z.number().finite().min(0))
        .max(600)
        .safeParse(body.monthly_contribution_schedule);
      if (!parsed.success || parsed.data.length > horizon) {
        ctx.addIssue({
          code: "custom",
          message:
            "monthly_contribution_schedule must contain at most horizon_months non-negative amounts",
        });
        return z.NEVER;
      }
      schedule = parsed.data;
    }
    const { goal_month: goalMonth, method } = body;
    const targetValue = Number(body.target_value);
    if (
      goalMonth !== undefined &&
      (typeof goalMonth !== "number" ||
        !Number.isInteger(goalMonth) ||
        goalMonth < 1 ||
        goalMonth > horizon ||
        !Number.isFinite(targetValue) ||
        targetValue <= 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "goal_month must be within horizon_months and accompanied by a positive target_value",
      });
      return z.NEVER;
    }
    return {
      horizonMonths: body.horizon_months,
      monthlyContribution: body.monthly_contribution,
      monthlyContributionSchedule: schedule,
      paths: body.paths,
      forwardBlend: body.forward_blend,
      // Any other spelling already fell back to the service's parametric default.
      method:
        method === "parametric" || method === "block_bootstrap"
          ? method
          : undefined,
      targetValue: body.target_value,
      // Checked above: when present it is an integer within the horizon.
      goalMonth: typeof goalMonth === "number" ? goalMonth : undefined,
      currency: body.currency || undefined,
      seed: body.seed || undefined,
    };
  });

// POST /api/research/portfolio-forecast — Monte-Carlo portfolio value projection.
// On-demand, never persisted (ADR-079 storage boundary). Deterministic per seed.
// Body keys are snake_case only — the camelCase spellings this handler used to
// also accept were a second, undocumented contract. See "Wire Casing
// Convention" in docs/reference/code-patterns.md.
router.post("/portfolio-forecast", async (req, res) => {
  const input = parseInput(portfolioForecastSchema, req.body ?? {});
  res.ok(await runPortfolioForecast(input));
});

// ─── Cross-provider symbol mapping (ADR-079) ────────────────────────────────

const keyType = (value: unknown) => parseInput(keyTypeSchema, value);
const requireInstrumentKey = (value: unknown) =>
  parseInput(instrumentKeySchema, value);

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
 */
function optionalInvestmentId(value: unknown): number | undefined {
  return assertOptionalId(value, "investment_id") ?? undefined;
}

// GET /api/research/mappings?instrument_key=US0378331005&key_type=isin
//
// Canonical collection shape `{items, total}`; unpaginated, so `total` is the
// row count (present so pagination can land without breaking the shape).
router.get("/mappings", async (req, res) => {
  const instrumentKey = requireInstrumentKey(req.query.instrument_key);
  const rows = await researchMappingService.list(
    instrumentKey,
    keyType(req.query.key_type),
  );
  res.ok({ items: rows, total: rows.length });
});

// POST /api/research/mappings/resolve  { instrument_key, key_type, asset_class, query, investment_id }
router.post("/mappings/resolve", async (req, res) => {
  const { instrument_key, key_type, asset_class, query, investment_id } =
    req.body ?? {};
  const q = parseInput(querySchema, query);
  const result = await researchMappingService.resolve({
    instrumentKey: requireInstrumentKey(instrument_key),
    keyType: keyType(key_type),
    assetClass: optionalParam(asset_class) || undefined,
    query: q,
    investmentId: optionalInvestmentId(investment_id),
  });
  res.ok({
    instrument_key: result.instrumentKey,
    key_type: result.keyType,
    proposals: result.proposals,
    existing: result.existing,
  });
});

// POST /api/research/mappings  { instrument_key, key_type, mappings: [...] }
// Answers the updated mapping set in the same canonical `{items, total}`
// collection shape as GET /mappings (one response type for both).
router.post("/mappings", async (req, res) => {
  const { instrument_key, key_type, mappings } = req.body ?? {};
  const rows = await researchMappingService.save({
    instrumentKey: requireInstrumentKey(instrument_key),
    keyType: keyType(key_type),
    mappings: parseInput(mappingsArraySchema, mappings),
  });
  res.ok({ items: rows, total: rows.length });
});

// DELETE /api/research/mappings/:id
router.delete("/mappings/:id", validateIdParam, async (req, res) => {
  const id = assertIdParam(req);
  // Idempotent hard delete (an already-removed mapping is not an error) →
  // 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
  await researchMappingService.remove(id);
  res.status(204).send();
});

// POST /api/research/mappings/audit  { instrument_key, key_type }
router.post("/mappings/audit", async (req, res) => {
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
router.get("/provider-keys", async (_req, res) => {
  const items = await researchProviderKeyService.listKeyStatuses();
  res.ok({ items, total: items.length });
});

// PUT /api/research/provider-keys/:provider  { api_key }
// Answers the refreshed statuses in the same `{items, total}` shape as the GET.
router.put("/provider-keys/:provider", async (req, res) => {
  const provider = parseInput(providerParamSchema, req.params.provider);
  const apiKey = parseInput(apiKeySchema, req.body?.api_key);
  await researchProviderKeyService.setKey(provider, apiKey);
  const items = await researchProviderKeyService.listKeyStatuses();
  res.ok({ items, total: items.length });
});

// DELETE /api/research/provider-keys/:provider
router.delete("/provider-keys/:provider", async (req, res) => {
  // Idempotent hard delete (clearing an unset key is not an error) → 204 No
  // Content (docs/reference/code-patterns.md, "DELETE responses"). The Settings
  // UI refetches GET /provider-keys after a clear, so the response carries no
  // key statuses of its own.
  await researchProviderKeyService.clearKey(
    parseInput(providerParamSchema, req.params.provider),
  );
  res.status(204).send();
});

export default router;
