/**
 * Watchlist routes — CRUD for prospective investments.
 *
 * Params, query strings and bodies are parsed with zod through parseInput
 * (ADR-193). The body schemas are LOOSE: fields
 * without a typed column (notes, ...) pass through untouched and the
 * repository allow-list decides what is written, exactly as before.
 */

import { Router } from "express";
import { z } from "zod";
import { watchlistRepository } from "../services/watchlistService.ts";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.ts";
import {
  validateNumber,
  assertMaxLength,
  assertCurrency,
} from "../middleware/validation.ts";
import { bareMessages, guardField, parseInput } from "../lib/zodInput.ts";
import {
  idParamsSchema,
  paginationQuery,
  singleQueryValue,
} from "./_inputBridges.ts";

const router = Router();

const WATCHLIST_ASSET_CLASSES = ["stock", "etf", "crypto", "metals"];

// NUMERIC(18,6) price columns hold at most 12 integer digits — anything
// larger (or Infinity) previously surfaced as a DB overflow error → 500.
const MAX_PRICE = 999_999_999_999;

/* ── Zod schemas ───────────────────────────────────────────────────────────
 * The fields the repository forwards to typed columns; without these a string
 * target_price surfaces as a DB error (500) instead of a 400. Presence
 * requirements stay in the POST handler — PATCH allows partials. Bridges reuse
 * the shared middleware guards so accepted shapes (String()/Number() coercion,
 * bounds, widths) stay identical to the pre-zod behavior. */

// An empty / whitespace-only name is not a valid item label; VARCHAR(200)
// (migration 0001) caps the width before the column raises a raw 22001 500.
const nameField = guardField((value) => {
  if (value === null || String(value).trim() === "") {
    throw new ValidationError("name cannot be empty");
  }
  // assertMaxLength's declared return is `unknown` (it's a generic length
  // guard shared by many field shapes) but null/empty was rejected above, so
  // the surviving value is the caller-supplied name as-is — narrowed here for
  // watchlistRepository.create's `name: string` param, matching the
  // repository's contract, not a runtime coercion.
  return assertMaxLength(value, 200, "name") as string;
}).optional();

// VARCHAR column widths: a provider-/market-prefilled value can exceed the
// HTML maxLength cap (which only clamps typed input).
// Same narrowing rationale as nameField above; assertMaxLength passes
// null/undefined through unchanged, matching watchlistRepository's
// `string|null` field shapes for symbol/price_provider_id.
const maxLenField = (maxLength: number, field: string) =>
  guardField(
    (value) =>
      assertMaxLength(value, maxLength, field) as string | null | undefined,
  ).optional();

// Numeric prices: Number() coercion + [0, MAX_PRICE] bounds via the shared
// validateNumber guard; the coerced number replaces the raw input. null passes
// through (explicit clear), undefined is absent.
const priceField = (
  field: string,
  { rejectZero = false }: { rejectZero?: boolean } = {},
) =>
  z
    .unknown()
    .transform((value, ctx) => {
      if (value === null) return null;
      const result = validateNumber(value, {
        min: 0,
        max: MAX_PRICE,
        fieldName: field,
      });
      if (!result.valid) {
        ctx.addIssue({ code: "custom", message: result.error });
        return z.NEVER;
      }
      // A 0 target is meaningless for the at-or-below alert check.
      if (rejectZero && result.value === 0) {
        ctx.addIssue({
          code: "custom",
          message: `${field} must be greater than 0`,
        });
        return z.NEVER;
      }
      return result.value;
    })
    .optional();

// Shared ISO-4217 guard — validates AND uppercases, so a lower-case 'usd'
// can't be stored and then mismatch the uppercase codes every FX/conversion
// path expects. An explicit key must carry a real code; null/empty would bypass
// the database default and hit the NOT NULL column as malformed data or a 500.
const currencyField = guardField((value) => {
  const code = assertCurrency(value);
  if (code === undefined) {
    throw new ValidationError("currency must be a 3-letter ISO code");
  }
  return code;
}).optional();

const watchlistCreateSchema = z.looseObject({
  name: nameField,
  symbol: maxLenField(20, "symbol"),
  price_provider_id: maxLenField(200, "price_provider_id"),
  target_price: priceField("target_price", { rejectZero: true }),
  // Snapshot of the live price when the item was added (ADR-097 backtest); optional.
  added_price: priceField("added_price"),
  asset_class: z
    .enum(WATCHLIST_ASSET_CLASSES, {
      error: `asset_class must be one of: ${WATCHLIST_ASSET_CLASSES.join(", ")}`,
    })
    .optional(),
  currency: currencyField,
  // No dedicated width/shape rule (free text) — listed explicitly only so its
  // output type matches watchlistRepository.create's `notes?: string|null`
  // param; `z.looseObject` would otherwise pass it through as `unknown`.
  notes: z
    .unknown()
    .transform((value) => value as string | null | undefined)
    .optional(),
});

// Partial-update variant: same field rules, except added_price is captured
// once at creation and is NOT PATCH-updatable — the repository update
// allow-list omits it, so accepting it here silently dropped the value.
// Reject it explicitly so the caller gets a 400 instead of a no-op.
const watchlistUpdateSchema = watchlistCreateSchema.extend({
  added_price: z
    .unknown()
    .superRefine((value, ctx) => {
      if (value != null) {
        ctx.addIssue({
          code: "custom",
          message: "added_price cannot be updated after creation",
        });
      }
    })
    .optional(),
});

// The create presence rule runs on the raw body BEFORE the field rules, so a
// body missing a required field gets this message rather than a field error.
// A missing body (no JSON content type) reads as an empty one.
const watchlistCreateBodySchema = z.preprocess(
  (body) => body ?? {},
  z
    .looseObject({})
    .superRefine((body, ctx) => {
      if (!body.name || !body.asset_class || body.target_price == null) {
        ctx.addIssue({
          code: "custom",
          message: "name, asset_class, and target_price are required",
        });
      }
    })
    .pipe(watchlistCreateSchema),
);

const listQuerySchema = bareMessages(
  z.object({ asset_class: singleQueryValue("asset_class") }),
);
const listPageQuerySchema = paginationQuery({ maxLimit: 5000 });

/**
 * Listener-free validation seams used by focused contract tests. The HTTP
 * handlers call these same functions, so validation can be verified on hosts
 * where binding a Supertest listener is prohibited.
 */
function parseWatchlistCreateBody(body: unknown) {
  return parseInput(watchlistCreateBodySchema, body);
}

function parseWatchlistUpdateBody(body: unknown) {
  return parseInput(watchlistUpdateSchema, body);
}

function parseItemId(req: { params: unknown }): number {
  return parseInput(idParamsSchema, req.params).id;
}

router.get("/", async (req, res) => {
  const { asset_class: assetClass } = parseInput(listQuerySchema, req.query);
  const { limit, offset } = parseInput(listPageQuerySchema, req.query);
  const opts = {
    limit,
    offset,
    assetClass: assetClass || undefined,
  };
  const result = await watchlistRepository.getAllWithCount(opts);
  res.ok({
    items: result.rows,
    total: result.total,
    limit: opts.limit,
    offset: opts.offset,
  });
});

router.get("/:id", async (req, res) => {
  const item = await watchlistRepository.getById(parseItemId(req));
  if (!item) throw new NotFoundError("Watchlist item not found");
  res.ok(item);
});

router.post("/", async (req, res) => {
  const data = parseWatchlistCreateBody(req.body);
  const {
    name,
    symbol,
    asset_class,
    target_price,
    currency,
    notes,
    price_provider_id,
    added_price,
  } = data;
  // Already enforced on the raw body by the schema; repeated on the parsed
  // output so the narrowed types reach watchlistRepository.create.
  if (name === undefined || asset_class === undefined || target_price == null) {
    throw new ValidationError(
      "name, asset_class, and target_price are required",
    );
  }
  const item = await watchlistRepository.create({
    name,
    symbol,
    asset_class,
    target_price,
    currency,
    notes,
    price_provider_id,
    added_price,
  });
  res.status(201);
  res.ok(item);
});

router.patch("/:id", async (req, res) => {
  const id = parseItemId(req);
  const data = parseWatchlistUpdateBody(req.body);
  const item = await watchlistRepository.update(id, data);
  if (!item) throw new NotFoundError("Watchlist item not found");
  res.ok(item);
});

router.delete("/:id", async (req, res) => {
  const deleted = await watchlistRepository.delete(parseItemId(req));
  if (!deleted) throw new NotFoundError("Watchlist item not found");
  res.status(204).send();
});

export default router;

export {
  parseWatchlistCreateBody as __parseWatchlistCreateBody,
  parseWatchlistUpdateBody as __parseWatchlistUpdateBody,
};
