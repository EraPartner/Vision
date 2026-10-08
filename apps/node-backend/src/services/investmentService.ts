/**
 * Investment Service
 *
 * Business logic for investment and portfolio transaction endpoints.
 * Routes in routes/investments.js delegate here; this module owns
 * response-shaping, orchestration, and in-memory caching.
 *
 * Emits unified response envelope (ADR-026) via res.ok(data). Typed
 * errors (ValidationError / NotFoundError / AppError) flow through
 * Express 5 async-throw to errorHandler.js for the {ok:false,...} shape.
 */

import { z } from "zod";
import investmentRepository, {
  pickInvestmentCreateFields,
} from "../repositories/investmentRepository.ts";
import portfolioTransactionRepository from "../repositories/portfolioTransactionRepository.ts";
import portfolioTransactionService from "./portfolio/portfolioTransactionService.ts";
import portfolioBrokerRetagService from "./portfolio/portfolioBrokerRetagService.ts";
import {
  fetchHistoricalPrices,
  fetchLivePricesDetailed,
  SUPPORTED_PROVIDERS,
} from "./priceProviderService.ts";
import { refreshQuotesForInvestment } from "./quoteBackfillService.ts";
import { logger } from "../config/logger.ts";
import { getKinesisAssetConfig } from "../config/kinesisConfig.ts";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.ts";
import {
  validateNumber,
  assertMaxLength,
  assertCurrency,
  assertYmd,
  validateId,
  validateIntArray,
} from "../lib/validation.ts";
import { assertIdParam } from "../middleware/validation.ts";
import { invalidatePortfolioCaches } from "./info/cache.ts";
import { assertPublicHttpUrl } from "../lib/urlSafety.ts";
import { autoResolveFxRateToEur } from "./portfolio/fxResolve.ts";
import { parsePagination, parseIntClamped } from "../lib/pagination.ts";
import { PORTFOLIO_TXN_TYPES } from "@vision/types/portfolioTxnTypes";
import { PORTFOLIO_RECURRENCE_INTERVALS } from "@vision/types/recurrence";
import { parseBooleanQueryParam } from "../lib/httpParams.ts";
import type { ExpressRequest, ExpressResponse } from "../types/express.ts";
import type { InvestmentRow } from "../types/rows.ts";
import type { ResolvedPrice } from "./priceProviderService.ts";

/** A response after middleware/envelope.ts has installed `res.ok`. */
type EnvelopeResponse = ExpressResponse & Required<Pick<ExpressResponse, "ok">>;

// Custom price-provider URLs are fetched server-side at refresh time, so reject
// non-public targets at the write boundary too (SSRF defense-in-depth). DNS is
// not resolved here — that would couple investment writes to DNS availability;
// the full DNS-resolved check runs at fetch time in priceProviderRegistry.
const PROVIDER_URL_FIELDS = [
  "price_provider_url",
  "price_provider_latest_url",
  "price_provider_history_url",
];

async function validateProviderUrls(body: Record<string, unknown>) {
  for (const field of PROVIDER_URL_FIELDS) {
    const value = body?.[field];
    if (value === undefined || value === null || value === "") continue;
    try {
      // maxLenField already bounded it; assertPublicHttpUrl rejects non-URLs.
      await assertPublicHttpUrl(value as string, {
        resolveDns: false,
      });
    } catch (err) {
      throw new ValidationError(`Invalid ${field}: ${(err as Error).message}`);
    }
  }
}

/* ── Zod body schema ───────────────────────────────────────────────────────
 * Bodies are validated with zod (schema → safeParse → ValidationError), the
 * idiom established in settings.js/reports.js. The schema is LOOSE: fields
 * without a typed guard (notes, price_provider_*, ...) pass through untouched
 * and the repository allow-list decides what is written, exactly as before.
 * Bridges reuse the shared middleware guards so accepted shapes
 * (Number() coercion, bounds, widths) stay identical to the pre-zod behavior. */

// Numeric fields forwarded to typed columns. Bounds keep garbage out of the
// valuation and Belgian property-tax math: without them a non-numeric string
// surfaced as a pg cast error (500 instead of 400) while negatives, 1e15, and
// JSON "Infinity" inserted cleanly. Both rate fields are percentages in the UI.
// null passes through (explicit clear, null-to-clear PATCH semantics); a
// cleared '' form field means "no value", not 0 — and ''::numeric is a pg cast
// error (500) if forwarded raw.
const boundedNumberField = (field: string, min: number, max: number) =>
  z
    .unknown()
    .transform((value, ctx) => {
      if (value === null || value === "") return null;
      const result = validateNumber(value, { min, max, fieldName: field });
      if (!result.valid) {
        ctx.addIssue({ code: "custom", message: result.error });
        return z.NEVER;
      }
      return result.value;
    })
    .optional();

// VARCHAR column widths (migration 0001). Provider-/market-prefilled values can
// exceed the frontend maxLength cap (which only clamps typed input) and reach
// the column as a raw 22001 500 instead of a clean 400. Values within the width
// pass through untouched (assertMaxLength never trims or stringifies).
const maxLenField = (field: string, max: number) =>
  z
    .unknown()
    .transform((value, ctx) => {
      try {
        return assertMaxLength(value, max, field);
      } catch (err) {
        ctx.addIssue({ code: "custom", message: (err as Error).message });
        return z.NEVER;
      }
    })
    .optional();

// ISO-4217 shape guard: a free-typed, null, or empty currency otherwise reaches
// the explicitly-written NOT NULL column as malformed data or a raw 500.
// Only an absent key lets the repository default apply.
const currencyField = z
  .unknown()
  .transform((value, ctx) => {
    try {
      const code = assertCurrency(value);
      if (code !== undefined) return code;
    } catch (err) {
      ctx.addIssue({ code: "custom", message: (err as Error).message });
      return z.NEVER;
    }
    ctx.addIssue({
      code: "custom",
      message: "currency must be a 3-letter ISO code",
    });
    return z.NEVER;
  })
  .optional();

const investmentBodySchema = z.looseObject({
  current_price: boundedNumberField("current_price", 0, 1e12),
  interest_rate: boundedNumberField("interest_rate", -100, 100),
  cadastral_income: boundedNumberField("cadastral_income", 0, 1e12),
  municipality_tax_rate: boundedNumberField("municipality_tax_rate", 0, 100),
  name: maxLenField("name", 200),
  symbol: maxLenField("symbol", 20),
  location: maxLenField("location", 300),
  municipality: maxLenField("municipality", 200),
  currency: currencyField,
  // Provider columns (migration 0001): URL shape is checked separately
  // (validateProviderUrls), but an over-length yet valid URL/path still
  // reached the VARCHAR column as a raw 22001 500.
  price_provider_id: maxLenField("price_provider_id", 200),
  price_provider_url: maxLenField("price_provider_url", 500),
  price_provider_latest_url: maxLenField("price_provider_latest_url", 500),
  price_provider_latest_path: maxLenField("price_provider_latest_path", 300),
  price_provider_history_url: maxLenField("price_provider_history_url", 500),
  price_provider_history_path: maxLenField("price_provider_history_path", 300),
  price_provider_history_ts_path: maxLenField(
    "price_provider_history_ts_path",
    300,
  ),
  price_provider_history_price_path: maxLenField(
    "price_provider_history_price_path",
    300,
  ),
});

const brokerRetagBodySchema = z.strictObject({
  transaction_ids: z
    .array(z.number().int().positive().max(2_147_483_647))
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "transaction_ids must be distinct",
    }),
  from_account_id: z.number().int().positive().max(2_147_483_647).nullable(),
  to_account_id: z.number().int().positive().max(2_147_483_647).nullable(),
  idempotency_key: z.string().uuid(),
});

/**
 * Returns the validated loose body, whose untyped pass-through fields the
 * repository allow-list filters (or a non-object body unchanged).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
function parseInvestmentBody(body: unknown): any {
  // Non-object bodies skipped field validation pre-zod; keep that boundary.
  if (!body || typeof body !== "object") return body;
  const result = investmentBodySchema.safeParse(body);
  if (!result.success) {
    const msg = result.error.issues
      .map((issue) =>
        issue.path.length
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message,
      )
      .join("; ");
    throw new ValidationError(msg);
  }
  return result.data;
}

function parseBrokerRetagBody(body: unknown): {
  transaction_ids: number[];
  from_account_id: number | null;
  to_account_id: number | null;
  idempotency_key: string;
} {
  const result = brokerRetagBodySchema.safeParse(body);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) =>
        issue.path.length
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message,
      )
      .join("; ");
    throw new ValidationError(message);
  }
  // The legacy checkJs program (no strictNullChecks) widens zod's nullable
  // output to optional; this restates the strict shape for both programs.
  return result.data as {
    transaction_ids: number[];
    from_account_id: number | null;
    to_account_id: number | null;
    idempotency_key: string;
  };
}

// POST and PATCH accept the same portfolio-transaction field vocabulary. Keep
// one parser so PATCH cannot drift behind create again; requiredness remains an
// endpoint concern because every PATCH field is optional. The repository still
// applies type-specific unit math and recurrence-window rules after this
// request-shape boundary.
const DECIMAL_NUMBER_STRING = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
// NUMERIC(18,4) has fourteen integer digits. Stay one integer unit inside the
// fractional upper edge so Number conversion cannot round an accepted value
// up to 10^14 and overflow Postgres.
const PORTFOLIO_MONEY_MAX = 99_999_999_999_999;

const portfolioNumberField = (field: string, max = PORTFOLIO_MONEY_MAX) =>
  z
    .unknown()
    .transform((value, ctx) => {
      // Preserve the repository's established per-field null/empty conventions:
      // required amount math rejects these, while nullable/defaulted numeric
      // fields clear or reset there.
      if (value === null || value === "") return value;
      if (
        typeof value !== "number" &&
        (typeof value !== "string" || !DECIMAL_NUMBER_STRING.test(value))
      ) {
        ctx.addIssue({ code: "custom", message: `${field} must be a number` });
        return z.NEVER;
      }
      const result = validateNumber(value, {
        min: -max,
        max,
        fieldName: field,
      });
      if (!result.valid) {
        ctx.addIssue({ code: "custom", message: result.error });
        return z.NEVER;
      }
      return result.value;
    })
    .optional();

const portfolioDateField = (field: string, allowClear: boolean) =>
  z
    .unknown()
    .transform((value, ctx) => {
      if (value === null || value === "") {
        if (allowClear) return null;
        ctx.addIssue({ code: "custom", message: `${field} cannot be cleared` });
        return z.NEVER;
      }
      if (typeof value !== "string") {
        ctx.addIssue({
          code: "custom",
          message: `${field} must be in YYYY-MM-DD format`,
        });
        return z.NEVER;
      }
      try {
        // A non-empty string is returned as-is or rejected by a throw.
        const date = assertYmd(value, field)!;
        // Date accepts and normalizes impossible calendar days such as February
        // 30. Round-trip the validated ISO value so those do not reach Postgres.
        if (
          date.startsWith("0000-") ||
          new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date
        ) {
          ctx.addIssue({
            code: "custom",
            message: `${field} is not a valid date`,
          });
          return z.NEVER;
        }
        return date;
      } catch (err) {
        ctx.addIssue({ code: "custom", message: (err as Error).message });
        return z.NEVER;
      }
    })
    .optional();

const portfolioCurrencyField = z
  .unknown()
  .transform((value, ctx) => {
    // Create treats null/empty as "use the investment currency" while PATCH
    // rejects clearing the NOT NULL column. Preserve presence for that later
    // endpoint-specific decision.
    if (value === null || value === "") return value;
    if (typeof value !== "string") {
      ctx.addIssue({
        code: "custom",
        message: "currency must be a 3-letter ISO code",
      });
      return z.NEVER;
    }
    try {
      return assertCurrency(value);
    } catch (err) {
      ctx.addIssue({ code: "custom", message: (err as Error).message });
      return z.NEVER;
    }
  })
  .optional();

const portfolioRecurrenceIntervalField = z
  .union([
    z.enum(PORTFOLIO_RECURRENCE_INTERVALS),
    z.null(),
    z.literal("").transform((): null => null),
  ])
  .optional();

const portfolioTransactionBodySchema = z.looseObject({
  type: z.enum(PORTFOLIO_TXN_TYPES).optional(),
  date: portfolioDateField("date", false),
  amount: portfolioNumberField("amount"),
  // Respect each column's integer-digit capacity: units and FX rates have ten
  // integer digits, while price_per_unit has twelve.
  units: portfolioNumberField("units", 9_999_999_999),
  price_per_unit: portfolioNumberField("price_per_unit", 999_999_999_999),
  fees: portfolioNumberField("fees"),
  taxes: portfolioNumberField("taxes"),
  dividend_amount_convention: z.enum(["gross", "net", "unknown"]).optional(),
  currency: portfolioCurrencyField,
  fx_rate_to_eur: portfolioNumberField("fx_rate_to_eur", 9_999_999_999),
  note: z.string().nullable().optional(),
  is_recurring: z.boolean().optional(),
  recurrence_interval: portfolioRecurrenceIntervalField,
  recurrence_end_date: portfolioDateField("recurrence_end_date", true),
  account_id: z.unknown().optional(),
});

/**
 * Returns the validated loose body; the repository applies the type-specific
 * rules to its pass-through fields.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
function parsePortfolioTransactionBody(body: unknown): any {
  if (
    body &&
    Object.prototype.hasOwnProperty.call(body, "income_recognition_role")
  )
    throw new ValidationError("income_recognition_role is read-only");
  const result = portfolioTransactionBodySchema.safeParse(body);
  if (!result.success) {
    const msg = result.error.issues
      .map((issue) =>
        issue.path.length
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message,
      )
      .join("; ");
    throw new ValidationError(msg);
  }
  return result.data;
}

// ── In-memory response caches ────────────────────────────────────────────────

const INVESTMENTS_CACHE_TTL_MS = 60_000;

let investmentsCache: { data: unknown; expiresAt: number } = {
  data: undefined,
  expiresAt: 0,
};
let bulkTxnCache: { data: unknown; key: string; expiresAt: number } = {
  data: undefined,
  key: "",
  expiresAt: 0,
};

export function clearInvestmentsCaches() {
  investmentsCache = { data: undefined, expiresAt: 0 };
  bulkTxnCache = { data: undefined, key: "", expiresAt: 0 };
  invalidatePortfolioCaches();
}

// ── Request parsers ──────────────────────────────────────────────────────────

export function parseRequestId(req: ExpressRequest): number {
  return assertIdParam(req);
}

/**
 * Parse `:txnId` for the two portfolio-transaction routes.
 *
 * Delegates to `validateId`, so the accept set is every other id param's: a
 * plain base-10 digit string or an integer number, 1..2^31-1. `routes/
 * investments.js` also puts `validateIntParam('txnId')` in front of both
 * routes for early validation. This point-of-use parser is the explicit
 * numeric handoff to the service.
 *
 * It was `parseInt` guarded by `isNaN`/`<= 0`, which takes the leading digits
 * of anything: `DELETE /investments/transactions/12abc` returned **204 having
 * hard-deleted transaction 12**, and `1e3` deleted transaction 1. PATCH on the
 * same path retargeted identically.
 */
export function parseTxnRequestId(req: ExpressRequest): number {
  return assertIdParam(req, "txnId");
}

export function requireTxnId(req: ExpressRequest): number {
  return parseTxnRequestId(req);
}

/**
 * Parse a non-null `account_id` from a portfolio-transaction write body.
 *
 * Callers own the absent/null case, because the two routes disagree on what it
 * means: on create, absent *and* explicit null both mean "no brokerage
 * account" (undefined, so the column default applies); on PATCH, absent means
 * "leave alone" and an explicit null means "unassign" (portfolioTxRepo.writes
 * .js). Both meanings are preserved.
 *
 * `validateId`, not `Number()`: the bare coercion took `'1e3'` as account
 * 1000, `'0x10'` as 16, `true` as 1, `[7]` as 7 and `' 7 '` as 7 — all 201,
 * with the lot booked against an account nobody named — and `'12abc'` reached
 * Postgres as NaN for a 500. Zero, negatives and the empty string now reject
 * as 400 instead of 500ing at the FK.
 */
function parseAccountId(value: unknown): number {
  const result = validateId(value, "account_id");
  if (!result.valid)
    throw new ValidationError("account_id must be a positive integer");
  return result.value;
}

/**
 * Translate repository VALIDATION_ERROR into a typed ValidationError so the
 * envelope surfaces a clean 400. Unknown errors propagate unchanged.
 * @param err arbitrary upstream error shape — a thrown repository
 *   error, possibly carrying a `code`, or anything else a repository call
 *   can reject with.
 */
function translateRepoError(err: unknown): never {
  const repoError = err as { code?: unknown; message: string } | null;
  if (repoError?.code === "VALIDATION_ERROR") {
    throw new ValidationError(repoError.message);
  }
  throw err;
}

/**
 * Comma-separated `investment_ids` query param on GET /api/investments/
 * transactions — `?investment_ids=1,2,3`, the shape the frontend's
 * `ids.join(',')` builder emits. Repeated occurrences work too: Express hands
 * back an array and `String([...])` re-joins it with commas.
 *
 * Delegates to `validateIntArray` (hence `validateId`), so the accepted element
 * shapes are exactly the `:id` params' and the other id-list query params': a
 * plain base-10 digit string or an integer number, 1..2^31-1. A bad element
 * rejects the whole request rather than being dropped.
 *
 * The dropping was the bug. This was `.split(',').map(parseInt).filter(isInteger
 * && > 0)`, so a partly-bad list *retargeted*: `?investment_ids=5,12abc` read
 * investments 5 **and 12**, `12abc` alone read investment 12, and `1e3` read
 * investment 1 — a different record than the caller named, returned as a 200.
 *
 * The param is required here (the caller 400s on absent/empty before this
 * runs), so unlike `assertOptionalId` there is no "absent means no filter"
 * case to preserve.
 */
function parseInvestmentIdsQuery(rawInvestmentIds: unknown): number[] {
  const result = validateIntArray(
    String(rawInvestmentIds).split(","),
    "investment_ids",
  );
  if (!result.valid) throw new ValidationError(result.error);
  return result.value;
}

// Route limit/offset through the canonical parsePagination clamp (used by the
// other list routes) so limit is bounded to maxLimit, a falsy/absent limit falls
// back to the default, and offset can never go negative — instead of the
// hand-rolled arithmetic that left offset unclamped.
function parseDefaultListOptions(query: ExpressRequest["query"]): {
  limit: number;
  offset: number;
  assetClass: string | null;
  active: boolean;
} {
  const { asset_class, active = "true" } = query;
  const { limit, offset } = parsePagination(query, {
    defaultLimit: 200,
    maxLimit: 1000,
  });
  return {
    limit,
    offset,
    assetClass: asset_class || null,
    active: parseBooleanQueryParam(active, true),
  };
}

// Per-route ceilings, unchanged from the hand-rolled clamps they replace.
const BULK_TRANSACTIONS_MAX_LIMIT = 200000;
const BULK_PER_INVESTMENT_MAX_LIMIT = 5000;
const INVESTMENT_TRANSACTIONS_MAX_LIMIT = 1000;

function parseBulkTransactionsOptions(
  query: ExpressRequest["query"],
  investmentIds: number[],
): {
  investmentIds: number[];
  type: string | null;
  perInvestmentLimit: number;
  limit: number | null;
  offset: number;
} {
  const { type, per_investment_limit, limit } = query;
  // `limit` stays opt-in here (absent → null → no outer LIMIT), so this keeps
  // the presence check and only borrows parsePagination's clamp. defaultLimit
  // is 1 to preserve the previous `parseInteger(limit) || 1` fallback for
  // garbage/zero/negative values.
  const page = parsePagination(query, {
    defaultLimit: 1,
    maxLimit: BULK_TRANSACTIONS_MAX_LIMIT,
  });
  return {
    investmentIds,
    type: type || null,
    perInvestmentLimit: parseIntClamped(per_investment_limit, {
      max: BULK_PER_INVESTMENT_MAX_LIMIT,
      fallback: 1000,
    }),
    limit: limit == null || limit === "" ? null : page.limit,
    offset: page.offset,
  };
}

function parseInvestmentTransactionsOptions(
  query: ExpressRequest["query"],
  investmentId: number,
): {
  investmentId: number;
  type: string | null;
  limit: number;
  offset: number;
} {
  const { type } = query;
  const { limit, offset } = parsePagination(query, {
    defaultLimit: 200,
    maxLimit: INVESTMENT_TRANSACTIONS_MAX_LIMIT,
  });
  return {
    investmentId,
    type: type || null,
    limit,
    offset,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hasLivePriceRefreshConfig(investment: InvestmentRow): boolean {
  const provider = investment?.price_provider;
  if (!provider || provider === "manual") return false;

  if (provider === "custom") {
    return Boolean(
      investment?.price_provider_latest_url ||
      investment?.price_provider_url ||
      investment?.price_provider_history_url,
    );
  }

  if (provider === "yahoo") {
    return Boolean(investment?.price_provider_id || investment?.symbol);
  }

  if (provider === "kinesis") {
    if (investment?.price_provider_id) return true;
    const assetName = (investment?.name || investment?.symbol || "")
      .toLowerCase()
      .trim();
    return Boolean(assetName && getKinesisAssetConfig(assetName));
  }

  return Boolean(investment?.price_provider_id);
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export async function listInvestments(
  req: ExpressRequest,
  res: EnvelopeResponse,
) {
  const opts = parseDefaultListOptions(req.query);

  const isDefaultRequest =
    opts.limit >= 500 && !opts.assetClass && !opts.active && opts.offset === 0;
  if (
    isDefaultRequest &&
    investmentsCache.data &&
    investmentsCache.expiresAt > Date.now()
  ) {
    return res.ok(investmentsCache.data);
  }

  const result = await investmentRepository.getAllWithCount(opts);
  const payload = {
    items: result.rows,
    total: result.total,
    limit: opts.limit,
    offset: opts.offset,
    links: [],
  };

  if (isDefaultRequest) {
    investmentsCache = {
      data: payload,
      expiresAt: Date.now() + INVESTMENTS_CACHE_TTL_MS,
    };
  }

  res.ok(payload);
}

export async function createInvestment(
  req: ExpressRequest,
  res: EnvelopeResponse,
) {
  const body = parseInvestmentBody(req.body);
  const { name, asset_class } = body;

  if (!name || !asset_class) {
    throw new ValidationError("name and asset_class are required");
  }

  await validateProviderUrls(body);

  let inv;
  try {
    inv = await investmentRepository.create(pickInvestmentCreateFields(body));
  } catch (err) {
    translateRepoError(err);
  }
  clearInvestmentsCaches();
  res.status(201);
  res.ok(inv);
}

export function listProviders(_req: ExpressRequest, res: EnvelopeResponse) {
  res.ok({ providers: SUPPORTED_PROVIDERS });
}

export async function refreshPrices(
  req: ExpressRequest,
  res: EnvelopeResponse,
) {
  const allInvestments = await investmentRepository.getAll({
    limit: 1000,
    active: true,
  });
  const toRefresh = allInvestments.filter(hasLivePriceRefreshConfig);

  if (toRefresh.length === 0) {
    return res.ok({
      updated: 0,
      message: "No investments with live price providers",
    });
  }

  const cachedPricesByInvestmentId = Object.fromEntries(
    toRefresh.map((i) => [i.id, Number(i.current_price)]),
  );
  const prices = await fetchLivePricesDetailed(toRefresh, {
    cachedPricesByInvestmentId,
  });
  const priceSources: Record<string, string> = {};

  // Collect the fresh prices, then write them in ONE UNNEST-driven UPDATE —
  // the previous per-investment loop (bounded concurrency 10) still paid N
  // round trips per refresh.
  const refreshedAt = new Date().toISOString();
  const priceUpdates: {
    id: number;
    current_price: number;
    price_updated_at: string;
  }[] = [];
  for (const [investmentId, priceData] of Object.entries(prices)) {
    const { price, source }: Partial<ResolvedPrice> = priceData || {};
    if (price == null || isNaN(price)) continue;
    priceSources[investmentId] = source || "live";
    if (source === "cached" || source === "historical_fallback") continue;
    priceUpdates.push({
      id: parseInt(investmentId, 10),
      current_price: price,
      price_updated_at: refreshedAt,
    });
  }
  const updated = await investmentRepository.updatePricesBulk(priceUpdates);
  logger.info(
    `Refreshed prices for ${updated}/${toRefresh.length} investments`,
  );
  clearInvestmentsCaches();

  res.ok({
    updated,
    total: toRefresh.length,
    prices: Object.fromEntries(
      Object.entries(prices).map(([id, data]) => [id, data.price]),
    ),
    priceSources,
  });
}

export async function getBulkTransactions(
  req: ExpressRequest,
  res: EnvelopeResponse,
) {
  const rawInvestmentIds = req.query.investment_ids;
  if (rawInvestmentIds == null || rawInvestmentIds === "") {
    throw new ValidationError("investment_ids is required");
  }

  const investmentIds = parseInvestmentIdsQuery(rawInvestmentIds);
  if (investmentIds.length === 0) {
    throw new ValidationError(
      "investment_ids must include at least one valid id",
    );
  }

  const opts = parseBulkTransactionsOptions(req.query, investmentIds);
  const cacheKey = `${investmentIds.join(",")}:${opts.type || ""}:${opts.perInvestmentLimit}:${opts.limit ?? ""}:${opts.offset}`;

  if (
    bulkTxnCache.key === cacheKey &&
    bulkTxnCache.data &&
    bulkTxnCache.expiresAt > Date.now()
  ) {
    return res.ok(bulkTxnCache.data);
  }

  const [items, total] = await Promise.all([
    portfolioTransactionRepository.getAllByInvestmentIds(opts),
    portfolioTransactionRepository.getCount({
      investmentIds: opts.investmentIds,
      type: opts.type,
    }),
  ]);

  const payload = {
    items,
    total,
    limit: opts.limit ?? items.length,
    offset: opts.offset,
    links: [],
  };

  bulkTxnCache = {
    data: payload,
    key: cacheKey,
    expiresAt: Date.now() + INVESTMENTS_CACHE_TTL_MS,
  };
  res.ok(payload);
}

export async function getPriceHistory(
  req: ExpressRequest,
  res: EnvelopeResponse,
) {
  const investmentId = parseRequestId(req);
  const inv = await investmentRepository.getById(investmentId);
  if (!inv) throw new NotFoundError("Investment not found");

  const { from_ms: fromMs, to_ms: toMs, db_only: dbOnlyRaw } = req.query;
  const points = await fetchHistoricalPrices(inv, {
    fromMs: fromMs !== undefined ? Number(fromMs) : undefined,
    toMs: toMs !== undefined ? Number(toMs) : undefined,
    dbOnly: parseBooleanQueryParam(dbOnlyRaw, true),
  });

  res.ok({ investment_id: investmentId, provider: inv.price_provider, points });
}

export async function getInvestment(
  req: ExpressRequest,
  res: EnvelopeResponse,
) {
  const inv = await investmentRepository.getById(parseRequestId(req));
  if (!inv) throw new NotFoundError("Investment not found");
  res.ok(inv);
}

export async function updateInvestment(
  req: ExpressRequest,
  res: EnvelopeResponse,
) {
  const body = parseInvestmentBody(req.body);
  await validateProviderUrls(body);

  let inv;
  try {
    inv = await investmentRepository.update(parseRequestId(req), body);
  } catch (err) {
    translateRepoError(err);
  }
  if (!inv) throw new NotFoundError("Investment not found");
  clearInvestmentsCaches();
  res.ok(inv);
}

export async function deleteInvestment(
  req: ExpressRequest,
  res: EnvelopeResponse,
) {
  const investmentId = parseRequestId(req);

  const ok = await investmentRepository.hardDelete(investmentId);
  if (!ok) throw new NotFoundError("Investment not found");

  clearInvestmentsCaches();
  res.status(204).send();
}

export async function listTransactions(
  req: ExpressRequest,
  res: EnvelopeResponse,
) {
  const opts = parseInvestmentTransactionsOptions(
    req.query,
    parseRequestId(req),
  );
  const result = await portfolioTransactionRepository.getAllWithCount(opts);
  res.ok({
    items: result.rows,
    total: result.total,
    limit: opts.limit,
    offset: opts.offset,
    links: [],
  });
}

export async function createTransaction(
  req: ExpressRequest,
  res: EnvelopeResponse,
) {
  const investment_id = parseRequestId(req);
  const inv = await investmentRepository.getById(investment_id);
  if (!inv) throw new NotFoundError("Investment not found");

  const body = parsePortfolioTransactionBody(req.body);
  const {
    type,
    date,
    amount,
    units,
    price_per_unit,
    fees,
    taxes,
    dividend_amount_convention,
    currency,
    note,
    is_recurring,
    recurrence_interval,
    recurrence_end_date,
    account_id,
  } = body;
  let { fx_rate_to_eur } = body;

  if (!type || !date) {
    throw new ValidationError("type and date are required");
  }

  // Validate a free-typed currency (ISO-4217 shape) before it reaches the
  // VARCHAR column — a "euro"/"€"/4-10-char value otherwise 500'd. Absent/empty
  // falls back to the investment's own currency.
  const effectiveCurrency = assertCurrency(currency) || inv.currency;
  if (fx_rate_to_eur === undefined || fx_rate_to_eur === null) {
    fx_rate_to_eur = await autoResolveFxRateToEur(effectiveCurrency, date);
  }

  let txn;
  try {
    txn = await portfolioTransactionService.create({
      investment_id,
      type,
      date,
      amount,
      units,
      price_per_unit,
      fees,
      taxes,
      dividend_amount_convention,
      currency: effectiveCurrency,
      note,
      is_recurring,
      recurrence_interval,
      recurrence_end_date,
      fx_rate_to_eur,
      account_id: account_id != null ? parseAccountId(account_id) : undefined,
      preloaded_asset_class: inv.asset_class,
    });
  } catch (err) {
    translateRepoError(err);
  }

  clearInvestmentsCaches();
  refreshQuotesForInvestment(investment_id).catch((err) => {
    logger.error("Transaction-triggered quote refresh failed", {
      investmentId: investment_id,
      error: err.message,
    });
  });
  res.status(201);
  res.ok(txn);
}

export async function deleteTransaction(
  req: ExpressRequest,
  res: EnvelopeResponse,
) {
  const txnId = requireTxnId(req);

  const existingTxn = await portfolioTransactionRepository.getById(txnId);
  if (!existingTxn) throw new NotFoundError("Portfolio transaction not found");

  const ok = await portfolioTransactionService.remove(txnId);
  if (!ok) throw new NotFoundError("Portfolio transaction not found");

  clearInvestmentsCaches();
  refreshQuotesForInvestment(existingTxn.investment_id).catch((err) => {
    logger.error("Transaction-triggered quote refresh failed", {
      investmentId: existingTxn.investment_id,
      error: err.message,
    });
  });
  res.status(204).send();
}

export async function updateTransaction(
  req: ExpressRequest,
  res: EnvelopeResponse,
) {
  const txnId = requireTxnId(req);
  const fields = parsePortfolioTransactionBody(req.body || {});

  // Validate a free-typed currency (ISO shape, uppercased) before it reaches
  // the VARCHAR(10) column — create validates it, but PATCH forwarded the raw
  // value (garbage stored; >10 chars 22001'd). The column is NOT NULL, so an
  // explicit null/'' (clear) rejects instead of 500ing at the constraint.
  if (fields.currency !== undefined) {
    if (fields.currency === null || fields.currency === "") {
      throw new ValidationError("currency cannot be cleared");
    }
    fields.currency = assertCurrency(fields.currency);
  }

  // account_id is on the repository's update allow-list, so PATCH forwarded it
  // raw: `'0x10'` reached Postgres, which reads hex integer literals, and
  // silently moved the lot to account 16; the other malformed forms 500'd on
  // the cast. Null keeps its "unassign" meaning, absent still means "leave
  // alone" — only a present non-null value is validated.
  if (fields.account_id !== undefined && fields.account_id !== null) {
    fields.account_id = parseAccountId(fields.account_id);
  }

  // A date or currency change invalidates the stamped FX rate — recompute it
  // unless the client supplied one explicitly.
  if (
    fields.fx_rate_to_eur === undefined &&
    (fields.date !== undefined || fields.currency !== undefined)
  ) {
    const existing = await portfolioTransactionRepository.getById(txnId);
    if (existing) {
      const effCurrency = fields.currency ?? existing.currency;
      const effDate = fields.date ?? existing.date;
      const rate = await autoResolveFxRateToEur(effCurrency, effDate);
      if (rate !== undefined) fields.fx_rate_to_eur = rate;
    }
  }

  let txn;
  try {
    txn = await portfolioTransactionService.update(txnId, fields);
  } catch (err) {
    translateRepoError(err);
  }
  if (!txn) throw new NotFoundError("Portfolio transaction not found");

  clearInvestmentsCaches();
  refreshQuotesForInvestment(txn.investment_id).catch((err) => {
    logger.error("Transaction-triggered quote refresh failed", {
      investmentId: txn.investment_id,
      error: err.message,
    });
  });
  res.ok(txn);
}

/**
 * Atomically move a reviewed set of portfolio transactions between broker
 * partitions. The expected source account makes this a compare-and-set write.
 */
export async function bulkRetagTransactions(
  req: ExpressRequest,
  res: EnvelopeResponse,
) {
  const request = parseBrokerRetagBody(req.body);
  const receipt =
    await portfolioBrokerRetagService.retagPortfolioTransactions(request);
  clearInvestmentsCaches();
  res.ok(receipt);
}

export async function getInvestmentSummary(
  req: ExpressRequest,
  res: EnvelopeResponse,
) {
  const investmentId = parseRequestId(req);
  const summary = await portfolioTransactionRepository.getSummary(investmentId);
  res.ok({ investment_id: investmentId, breakdown: summary });
}

export {
  parsePortfolioTransactionBody as __parsePortfolioTransactionBody,
  parseDefaultListOptions as __parseDefaultListOptions,
};

export { parseBrokerRetagBody as __parseBrokerRetagBody };
