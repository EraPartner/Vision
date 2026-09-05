/**
 * Transaction routes.
 *
 * Create/patch/bulk bodies are validated with zod (schema → safeParse →
 * ValidationError), the idiom established in settings.js/reports.js. The body
 * schemas are LOOSE where the old code was loose (unvalidated fields such as
 * memo/comment/is_active pass through untouched; the repository allow-list
 * decides what is written). Bridges reuse the shared middleware guards so
 * accepted shapes and coercions stay identical to the pre-zod behavior.
 *
 * Handlers keep only request parsing/validation and response shaping
 * (ADR-067): the write orchestration lives in transactionService and the
 * bulk-action SQL in transactionBulkService, and export SQL in
 * transactionExport.
 */

/// <reference path="../types/thirdPartyModules.d.ts" />
import { Router } from "express";
import { z } from "zod";
import transactionService from "../services/transactionService.js";
import {
  bulkTagTransactions,
  bulkUpdateTransactions,
  bulkDeleteTransactions,
} from "../services/transactionBulkService.js";
import { convertRowsToEur } from "../services/currency/currencyConversionService.js";
import {
  validateIdParam,
  validateId,
  assertYmd,
  assertOptionalId,
  assertCurrency,
  assertMaxLength,
  validateIntArray,
  MAX_MONEY_VALUE,
  assertIdParam,
} from "../middleware/validation.js";
import { rateLimiter } from "../middleware/rateLimiter.js";
import { ValidationError, NotFoundError } from "../middleware/errorHandler.js";
import { toDecimal, toNumber } from "../lib/money.js";
import { parseAmountFilter } from "../lib/filterBuilder.js";
import {
  EXPORT_MAX_LIST_SIZE,
  streamCsvExport,
  streamNdjsonExport,
  streamBulkTransactionExport,
} from "../services/transactionExport.js";
import { parsePagination } from "../lib/pagination.js";
import { toWireDate } from "../lib/dateFormat.js";
import { parseBooleanQueryParam } from "../lib/httpParams.js";

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 * @typedef {import('../types/rows.js').EnrichedTransactionRow} EnrichedTransactionRow
 */

const router = Router();

/** @param {ExpressRequest} req */
function parseRouteId(req) {
  return assertIdParam(req);
}

function parseBulkExpectedCount(value, filter) {
  if (!filter) {
    if (value !== undefined) {
      throw new ValidationError("`expected_count` is only valid with `filter`");
    }
    return undefined;
  }
  const parsed = z.number().int().positive().max(5000).safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(
      "`expected_count` must be an integer between 1 and 5000 in filter mode",
    );
  }
  return parsed.data;
}

/* ── Zod schemas ─────────────────────────────────────────────────────────── */

const tagsField = z
  .array(z.unknown(), { error: "tags must be an array of strings" })
  .optional();

// bank_account is TEXT on transactions but VARCHAR(100) on the raw mirror
// (manual_raw_transactions); cap it up front so the mirror insert can't 500
// *after* the main row already committed. null/short values pass untouched.
const bankAccountField = z
  .unknown()
  .transform((value, ctx) => {
    try {
      return assertMaxLength(value, 100, "bank_account");
    } catch (err) {
      ctx.addIssue({ code: "custom", message: err.message });
      return z.NEVER;
    }
  })
  .optional();

// Normalise/validate currency (ISO-4217) so free text never reaches the
// VARCHAR(3) column + 0046 CHECK as a raw 400/500. `rejectEmpty` picks the
// clear-vs-default semantics: POST maps absent/'' to undefined (repo default),
// PATCH rejects a cleared value (the column is NOT NULL).
const currencyField = ({ rejectEmpty = false } = {}) =>
  z
    .unknown()
    .transform((value, ctx) => {
      if (rejectEmpty && (value == null || value === "")) {
        ctx.addIssue({ code: "custom", message: "currency cannot be cleared" });
        return z.NEVER;
      }
      try {
        return assertCurrency(value);
      } catch (err) {
        ctx.addIssue({ code: "custom", message: err.message });
        return z.NEVER;
      }
    })
    .optional();

// recipient_id/category_id on PATCH: null clears (both columns are nullable),
// but a present non-null value must be a positive integer — a non-integer here
// otherwise reached the DB as an FK type error and surfaced as a 500. The
// coerced integer replaces the raw input.
//
// validateId, not `Number()`: the old coercion rejected '12abc' but read '1e3'
// as 1000, '0x10' as 16, true as 1 and [7] as 7, so the PATCH re-pointed the
// transaction at a recipient/category the caller never named — a silent
// mis-attribution in the ledger rather than a 400.
/** @param {string} field */
const nullableFkField = (field) =>
  z
    .unknown()
    .transform((value, ctx) => {
      if (value === null) return null;
      const parsed = validateId(value, field);
      if (!parsed.valid) {
        ctx.addIssue({
          code: "custom",
          message: `${field} must be a positive integer`,
        });
        return z.NEVER;
      }
      return parsed.value;
    })
    .optional();

// POST body: per-field guards run first; the cross-field required/amount/
// recipient checks mirror the pre-zod handler (raw values are forwarded to the
// repository — POST never coerced amount/recipient_id in the created row).
// category_id uses the same nullableFkField as the PATCH body: the column is
// nullable, so null (and absent) still mean "uncategorized" — the create path's
// existing meaning — and only a present non-null value must be a real id.
//
// This one was not loose validation, it was *no* validation: the POST schema
// checked recipient_id and amount and forwarded everything else raw, so any
// malformed category_id reached Postgres as a cast error and 500'd on the
// create path for the app's core entity ('12abc', '1e3', true, [7], '' — all
// 22P02; 0 and negatives an FK violation). '0x10' was worse than a 500: PG 16
// reads hex integer literals, so it lands on category 16 wherever that row
// exists. Surfaced by a test written while closing the FK-body set (e0cab62c).
const createTransactionSchema = z
  .looseObject({
    tags: tagsField,
    currency: currencyField(),
    bank_account: bankAccountField,
    category_id: nullableFkField("category_id"),
    allow_duplicate: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    const txDate = data.transaction_date || data.date;
    if (
      !txDate ||
      !data.bank_account ||
      !data.recipient_id ||
      data.amount == null
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Missing required fields: date, bank_account, recipient_id, amount",
      });
      return;
    }
    // Sign carries meaning (− expense / + income), so a zero amount is
    // meaningless and only pollutes aggregations — reject it up front.
    const amountNum = Number(data.amount);
    if (
      !Number.isFinite(amountNum) ||
      amountNum === 0 ||
      Math.abs(amountNum) > MAX_MONEY_VALUE
    ) {
      ctx.addIssue({
        code: "custom",
        message: "amount must be a non-zero finite number within range",
      });
    }
    // Validate recipient_id is a positive integer up front — a non-integer here
    // otherwise reached the DB as an FK type error and surfaced as a 500. Same
    // strict accept set as the PATCH field above: `Number()` would have booked
    // a '1e3' against recipient 1000 instead of rejecting it.
    if (!validateId(data.recipient_id, "recipient_id").valid) {
      ctx.addIssue({
        code: "custom",
        message: "recipient_id must be a positive integer",
      });
    }
  });

// PATCH body (after normalizeTransactionPatchFields). Parity with POST, which
// validates date/amount/recipient_id. Without these, the inline row editor's
// cleared native date input ('') survived the whitelist and reached Postgres
// as `SET "date" = ''` — a 22007 cast error surfacing as a 500 from pressing
// Enter. date/amount/currency are NOT NULL columns, so a PATCH may change
// them but never clear them.
const patchTransactionSchema = z.looseObject({
  tags: tagsField,
  transaction_date: z
    .unknown()
    .transform((value, ctx) => {
      if (!value) {
        ctx.addIssue({
          code: "custom",
          message: "transaction_date cannot be cleared",
        });
        return z.NEVER;
      }
      try {
        return assertYmd(value, "transaction_date");
      } catch (err) {
        ctx.addIssue({ code: "custom", message: err.message });
        return z.NEVER;
      }
    })
    .optional(),
  amount: z
    .unknown()
    .transform((value, ctx) => {
      const amountNum = Number(value);
      if (
        value == null ||
        value === "" ||
        !Number.isFinite(amountNum) ||
        Math.abs(amountNum) > MAX_MONEY_VALUE
      ) {
        ctx.addIssue({
          code: "custom",
          message: "amount must be a number within range",
        });
        return z.NEVER;
      }
      return amountNum;
    })
    .optional(),
  currency: currencyField({ rejectEmpty: true }),
  bank_account: bankAccountField,
  recipient_id: nullableFkField("recipient_id"),
  category_id: nullableFkField("category_id"),
});

const bulkTagSchema = z
  .object({
    transaction_ids: z
      .array(z.unknown(), {
        error: "transaction_ids must be a non-empty array of up to 500 IDs",
      })
      .min(1, {
        error: "transaction_ids must be a non-empty array of up to 500 IDs",
      })
      .max(500, {
        error: "transaction_ids must be a non-empty array of up to 500 IDs",
      }),
    add_slugs: z
      .array(z.unknown(), {
        error: "add_slugs must be an array of up to 50 slugs",
      })
      .max(50, { error: "add_slugs must be an array of up to 50 slugs" })
      .default([]),
    remove_slugs: z
      .array(z.unknown(), {
        error: "remove_slugs must be an array of up to 50 slugs",
      })
      .max(50, { error: "remove_slugs must be an array of up to 50 slugs" })
      .default([]),
  })
  .superRefine((data, ctx) => {
    if (data.add_slugs.length === 0 && data.remove_slugs.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "At least one of add_slugs or remove_slugs must be non-empty",
      });
    }
  });

// bulk-update `fields`: strict (no coercion) — the pre-zod code required real
// numbers/booleans here. Unknown keys are stripped, exactly like the old
// manual sanitized{} build; presence drives the SET clause construction.
const bulkUpdateFieldsSchema = z.object({
  category_id: z
    .number({
      error: "`fields.category_id` must be a positive integer or null",
    })
    .int({ error: "`fields.category_id` must be a positive integer or null" })
    .positive({
      error: "`fields.category_id` must be a positive integer or null",
    })
    .nullable()
    .optional(),
  recipient_id: z
    .number({ error: "`fields.recipient_id` must be a positive integer" })
    .int({ error: "`fields.recipient_id` must be a positive integer" })
    .positive({ error: "`fields.recipient_id` must be a positive integer" })
    .optional(),
  is_active: z
    .boolean({ error: "`fields.is_active` must be a boolean" })
    .optional(),
});

// schema → safeParse → joined issues → ValidationError (settings.js idiom).
/**
 * @template T
 * @param {z.ZodType<T>} schema
 * @param {unknown} body
 * @returns {T}
 */
function parseTransactionBody(schema, body) {
  const result = schema.safeParse(body);
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

/**
 * Comma-separated *id* list query param (`category_ids` on the list and export
 * endpoints, `account_ids` on the export endpoints) — `?category_ids=1,2,3`, the
 * shape the frontend's `ids.join(',')` builders emit. Repeated occurrences work
 * too: Express hands back an array and `String([...])` re-joins it with commas.
 *
 * Delegates to `validateIntArray`, so the accepted element shapes are exactly
 * the `:id` params', the body arrays' and the aggregation query params': a plain
 * base-10 digit string or an integer number, 1..2^31-1. No trimming — ` 2` is a
 * malformed id here as everywhere else. A bad element rejects the whole request.
 *
 * Rejecting is the point. This was `.split(',').map(parseInt).filter(isFinite &&
 * > 0)`, which had both failure modes and surfaced neither. A partly-bad list
 * *retargeted*: `?category_ids=5,12abc` filtered by categories 5 **and 12**, and
 * `?account_ids=12abc` exported account 12 — a record nobody named. An entirely
 * bad list *vanished*: `?account_ids=abc` produced an empty list, the caller
 * mapped that back to "no filter", and `GET /export/csv` streamed **every
 * account's transactions** into a file the user keeps, with a 200 and a
 * plausible-looking CSV.
 *
 * Absent or empty (`?category_ids=`) still means "no filter" and stays 200 —
 * the same unset convention `assertOptionalId` and `parseIdArrayQueryParam` use.
 * The emptiness test is applied to the JOINED string so every encoding of "sent
 * but empty" (`''`, `[]`, `['']`) lands on it. An empty list and a list with a
 * bad element are different cases and are answered differently: `?ids=` is 200,
 * `?ids=5,` is 400.
 * @param {any} raw
 * @param {string} field
 * @returns {number[]|undefined} undefined when the param is absent/empty
 */
function parseIdListQueryParam(raw, field) {
  if (raw == null) return undefined;
  const joined = String(raw);
  if (joined === "") return undefined;
  const result = validateIntArray(joined.split(","), field);
  if (!result.valid) throw new ValidationError(result.error);
  return result.value;
}

// `query` is req.query — an Express querystring object whose values are
// string|string[]|undefined at runtime; typed `any` here (as the rest of this
// file's req.query reads always have been) rather than modelling every key.
/** @param {any} query */
function parseTransactionListQuery(query) {
  const {
    transaction_id,
    start_date,
    end_date,
    account_id,
    bank_account,
    category_id,
    category_ids,
    recipient_id,
    recipient_group_id,
    recipient_name,
    active = "true",
    search,
    sort_by,
    sort_dir,
    include_balance,
    transaction_type,
    amount_min,
    amount_max,
    amount_exact,
    amount_signed,
    tags,
  } = query;
  const { limit, offset } = parsePagination(query, { maxLimit: 5000 });

  const parsedCategoryIds = parseIdListQueryParam(category_ids, "category_ids");

  const parsedTagSlugs = tags
    ? String(tags)
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : undefined;

  // Amount coercion lives in filterBuilder.parseAmountFilter (shared with
  // bulkSelection). amount_exact is shorthand for min == max.
  const amountSigned = parseBooleanQueryParam(amount_signed);
  const amountExact = parseAmountFilter(amount_exact, amountSigned);
  const amountMin =
    amountExact != null
      ? amountExact
      : parseAmountFilter(amount_min, amountSigned);
  const amountMax =
    amountExact != null
      ? amountExact
      : parseAmountFilter(amount_max, amountSigned);

  return {
    limit,
    offset,
    // Every scalar id here goes through assertOptionalId — absent/empty means
    // "no filter" (undefined, 200), anything malformed is a 400. These were bare
    // `x ? parseInt(x) : null`, which took the leading digits of anything:
    // ?category_id=12abc filtered by category 12, ?recipient_group_id=1e3 by
    // group 1, ?transaction_id=0 and ?recipient_id=-4 reached the SQL builder
    // as ids no row can have, and a NaN (which is what the Transactions page
    // sends for a hand-edited URL) passed the `!= null` guard and reached
    // Postgres as a 22P02 500.
    transactionId: assertOptionalId(transaction_id, "transaction_id"),
    startDate: assertYmd(start_date, "start_date"),
    endDate: assertYmd(end_date, "end_date"),
    // account_id is the preferred account filter (ADR-088 — reads key on the
    // FK); bank_account stays as a substring escape hatch.
    accountId: assertOptionalId(account_id, "account_id"),
    bankAccount: bank_account || undefined,
    categoryId: assertOptionalId(category_id, "category_id"),
    categoryIds: parsedCategoryIds,
    recipientId: assertOptionalId(recipient_id, "recipient_id"),
    recipientGroupId: assertOptionalId(
      recipient_group_id,
      "recipient_group_id",
    ),
    recipientName: recipient_name || undefined,
    search: search ? String(search).slice(0, 200) : undefined,
    active: parseBooleanQueryParam(active, true),
    sortBy: sort_by || undefined,
    sortDir: sort_dir === "asc" || sort_dir === "desc" ? sort_dir : undefined,
    includeBalance: parseBooleanQueryParam(include_balance),
    transactionType:
      transaction_type === "income" || transaction_type === "expense"
        ? transaction_type
        : undefined,
    amountMin,
    amountMax,
    amountSigned,
    tagSlugs: parsedTagSlugs?.length ? parsedTagSlugs : undefined,
  };
}

/**
 * Parse the transactions export filters into a service input model.
 *
 * Accepts the same raw query-string shape used by the list endpoint, including
 * `transaction_id`, `recipient_id`, `recipient_name`, `search`,
 * `transaction_type`, and `active`. SQL construction belongs to
 * `transactionExport`; the route returns only validated domain filters.
 *
 * Account multi-value support: `account_ids=1,2,3` → array of ids (preferred);
 * `bank_accounts=a,b,c` → array of trimmed strings (legacy escape hatch).
 *
 * Returns a plain filter model.
 * @param {any} query req.query — see parseTransactionListQuery.
 */
function buildExportFilters(query) {
  const opts = parseTransactionListQuery(query);

  // Validated in full BEFORE the cap is applied, so a malformed id past
  // EXPORT_MAX_LIST_SIZE still rejects rather than being sliced away unseen.
  // The cap itself is unchanged (it silently truncates an over-long list — a
  // separate, pre-existing narrowing, shared with bank_accounts below).
  const accountIds = parseIdListQueryParam(
    query.account_ids,
    "account_ids",
  )?.slice(0, EXPORT_MAX_LIST_SIZE);

  const bankAccounts = query.bank_accounts
    ? String(query.bank_accounts)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, EXPORT_MAX_LIST_SIZE)
    : undefined;

  return {
    transactionId: opts.transactionId,
    startDate: opts.startDate,
    endDate: opts.endDate,
    accountId: opts.accountId,
    accountIds: accountIds && accountIds.length > 0 ? accountIds : undefined,
    bankAccount: opts.bankAccount,
    bankAccounts:
      bankAccounts && bankAccounts.length > 0 ? bankAccounts : undefined,
    categoryId: opts.categoryId,
    categoryIds: opts.categoryIds,
    recipientId: opts.recipientId,
    recipientGroupId: opts.recipientGroupId,
    recipientName: opts.recipientName,
    search: opts.search,
    active: opts.active,
    transactionType: opts.transactionType,
    amountMin: opts.amountMin,
    amountMax: opts.amountMax,
    amountSigned: opts.amountSigned,
    tagSlugs: opts.tagSlugs,
  };
}

/** @param {any} body */
function normalizeTransactionPatchFields(body) {
  // Immutable-rest sanitization (docs/reference/code-patterns.md) — strip
  // read-only keys via destructuring, never with in-place delete.
  const {
    links: _links,
    id: _id,
    created_at: _createdAt,
    date,
    ...fields
  } = body;

  // Remap whenever the key is present — a cleared date ('' / null) must also
  // land on transaction_date so the PATCH validation can reject it instead of
  // letting `SET "date" = ''` reach Postgres.
  if ("date" in body) {
    fields.transaction_date = date;
  }

  return fields;
}

// ── Internal transfers (ADR-083) ───────────────────────────────────────────
// Defined before the `/:id` routes; all have 2 path segments or a literal first
// segment so they never collide with the single-segment `/:id` handlers.

// GET /api/transactions/transfer-suggestions — ambiguous transfer matches
router.get(
  "/transfer-suggestions",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    res.ok({ items: await transactionService.getTransferSuggestions() });
  },
);

// POST /api/transactions/transfers — manually confirm a transfer pair (sticky)
router.post(
  "/transfers",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    // Same strict id parse as everywhere else. This was a bare parseInt guarded
    // only by Number.isInteger, so `aId: "12abc"` marked transaction 12 as a
    // transfer — a wrong-record *write*, not a wrong-record read — and an id past
    // int4 (99999999999) passed the guard and 500'd at the column.
    const a = validateId(req.body?.aId, "aId");
    const b = validateId(req.body?.bId, "bId");
    if (!a.valid || !b.valid || a.value === b.value) {
      throw new ValidationError(
        "aId and bId must be two distinct transaction ids",
      );
    }
    const aId = a.value;
    const bId = b.value;
    await transactionService.markTransfer(aId, bId);
    res.ok({ ok: true });
  },
);

// DELETE /api/transactions/transfers/:id — clear a transfer mark and its peer
router.delete(
  "/transfers/:id",
  validateIdParam,
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    await transactionService.unmarkTransfer(assertIdParam(req));
    // Deleting the transfer mark reports nothing the caller can't derive →
    // 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
    res.status(204).send();
  },
);

// GET /api/transactions
router.get(
  "/",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const {
      uncategorised,
      normalize_to_eur = "false",
      target_currency,
    } = req.query;
    const opts = parseTransactionListQuery(req.query);

    let items, total;
    if (parseBooleanQueryParam(uncategorised)) {
      const result = await transactionService.getUncategorisedWithCount(opts);
      items = result.rows;
      total = result.total;
    } else {
      const result = await transactionService.getAllWithCount(opts);
      items = result.rows;
      total = result.total;
    }

    if (parseBooleanQueryParam(normalize_to_eur)) {
      items = await convertRowsToEur(items, target_currency || "EUR");
    }

    res.ok({
      items: items.map(formatTransaction),
      total,
      limit: opts.limit,
      offset: opts.offset,
      links: [],
    });
  },
);

// GET /api/transactions/export/csv
// Rate-limited, streamed CSV. Chunked pagination bounds memory.
router.get(
  "/export/csv",
  rateLimiter({
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "transactions-export-csv",
  }),
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const includeBalance = parseBooleanQueryParam(req.query.include_balance);
    const filters = buildExportFilters(req.query);
    await streamCsvExport(res, {
      filters,
      includeBalance,
    });
  },
);

// GET /api/transactions/export/json
// Rate-limited, streamed NDJSON (newline-delimited JSON). One JSON object per line.
router.get(
  "/export/json",
  rateLimiter({
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "transactions-export-json",
  }),
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const filters = buildExportFilters(req.query);
    await streamNdjsonExport(res, { filters });
  },
);

// POST /api/transactions/bulk-tag
router.post(
  "/bulk-tag",
  rateLimiter({
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "transactions-bulk-tag",
  }),
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const { transaction_ids, add_slugs, remove_slugs } = parseTransactionBody(
      bulkTagSchema,
      req.body,
    );

    // bulkTagSchema only validates "is an array" (add_slugs/remove_slugs item
    // type is unchecked, matching pre-zod behavior) while bulkTagTransactions
    // expects string[] — it forwards each slug straight into a `::text[]`
    // parameterized query, so a non-string element behaves exactly as before
    // this annotation pass (pg's own text coercion / cast error).
    const result = await bulkTagTransactions({
      transactionIds: transaction_ids,
      addSlugs: /** @type {string[]} */ (add_slugs),
      removeSlugs: /** @type {string[]} */ (remove_slugs),
    });
    res.ok(result);
  },
);

// POST /api/transactions/bulk-delete
// Hard-deletes a set of transactions selected by `ids` or `filter`.
// CASCADE on transaction_tags / transaction_splits / attachments handles
// dependent rows; raw_transactions and import_batches use SET NULL.
router.post(
  "/bulk-delete",
  rateLimiter({
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "transactions-bulk-delete",
  }),
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const { ids, filter, expected_count } = req.body ?? {};
    const expectedCount = parseBulkExpectedCount(expected_count, filter);
    const result = await bulkDeleteTransactions({ ids, filter, expectedCount });
    res.ok(result);
  },
);

// POST /api/transactions/bulk-update
// Applies a single shared update (category, recipient, is_active) to a set of
// transactions selected by `ids` or `filter`. FK targets are validated up front
// so the entire batch fails atomically on the first invalid reference.
router.post(
  "/bulk-update",
  rateLimiter({
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "transactions-bulk-update",
  }),
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const { ids, filter, fields, expected_count } = req.body ?? {};
    const expectedCount = parseBulkExpectedCount(expected_count, filter);

    if (!fields || typeof fields !== "object") {
      throw new ValidationError(
        "`fields` must be an object with at least one updatable property",
      );
    }

    // Strip-mode parse: unknown keys are dropped, present keys are validated,
    // absent keys stay absent — presence drives the SET clause build below.
    // Explicit-undefined values (unreachable via JSON) are dropped too, so a
    // `category_id: undefined` can never become `SET category_id = NULL`.
    const sanitized = Object.fromEntries(
      Object.entries(
        parseTransactionBody(bulkUpdateFieldsSchema, fields),
      ).filter(([, value]) => value !== undefined),
    );

    if (Object.keys(sanitized).length === 0) {
      throw new ValidationError(
        "`fields` must contain at least one of: category_id, recipient_id, is_active",
      );
    }

    const result = await bulkUpdateTransactions({
      ids,
      filter,
      fields: sanitized,
      expectedCount,
    });
    res.ok(result);
  },
);

// POST /api/transactions/bulk-export
// Streams CSV / NDJSON for a set of transactions selected by `ids` or `filter`.
// Reuses the same chunked streaming pipeline as the GET export endpoints.
router.post(
  "/bulk-export",
  rateLimiter({
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "transactions-bulk-export",
  }),
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const {
      ids,
      filter,
      format = "csv",
      include_balance = false,
      expected_count,
    } = req.body ?? {};
    if (format !== "csv" && format !== "json") {
      throw new ValidationError("`format` must be 'csv' or 'json'");
    }

    parseBulkExpectedCount(expected_count, filter);
    await streamBulkTransactionExport(res, {
      ids,
      filter,
      format,
      includeBalance: include_balance === true,
    });
  },
);

// GET /api/transactions/:id
router.get(
  "/:id",
  validateIdParam,
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const transaction = await transactionService.getById(assertIdParam(req));
    if (!transaction) {
      throw new NotFoundError(`Transaction with ID ${req.params.id} not found`);
    }
    res.ok(formatTransaction(transaction));
  },
);

// POST /api/transactions
router.post(
  "/",
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    // Validated body: currency is coerced (uppercased / undefined → repo
    // default); everything else is forwarded raw, exactly as before the schema.
    // The dup-check → insert → raw-mirror → auto-link → reconcile chain lives
    // in the service; a duplicate surfaces as ConflictError (409) from there.
    const data = parseTransactionBody(createTransactionSchema, req.body);

    // createTransactionSchema is a loose passthrough object (see module doc) —
    // its zod-inferred type makes every field optional, but the schema's own
    // superRefine already enforces date/bank_account/recipient_id/amount are
    // present before this line runs (400s otherwise), matching
    // createManualTransaction's required-field param type.
    const { transaction, autoLink } =
      await transactionService.createManualTransaction(
        /** @type {{ transaction_date?: string, date?: string, bank_account?: string|null, recipient_id?: number|null, amount: number|string, memo?: string|null, currency?: string|null, category_id?: number|null, comment?: string|null, tags?: string[]|null, allow_duplicate?: boolean }} */ (
          data
        ),
      );

    res.status(201);
    res.ok({
      // transactionService.createManualTransaction's own @returns widens
      // `transaction` to `object` at the service seam, but it's a pass-through
      // of transactionRepository.create()'s EnrichedTransactionRow|null.
      ...formatTransaction(/** @type {EnrichedTransactionRow} */ (transaction)),
      auto_linked: autoLink.links[0]?.plannedTransactionId ?? null,
    });
  },
);

// PATCH /api/transactions/:id
router.patch(
  "/:id",
  validateIdParam,
  rateLimiter({
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "transactions-patch",
  }),
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const id = parseRouteId(req);
    // Whitelist-strip read-only keys, then validate/coerce the typed fields.
    // Absent keys stay absent (partial PATCH), null keeps its clear semantics
    // for the nullable FK columns, and unvalidated fields pass through loose.
    const fields = parseTransactionBody(
      patchTransactionSchema,
      normalizeTransactionPatchFields(req.body),
    );

    // patchTransactionSchema's tagsField only validates "is an array" (item
    // type unchecked, matching pre-zod behavior); transactionRepository.update
    // types `tags` as `string[]` since that's what it writes to the junction
    // table — same "loose zod passthrough vs. typed repository param" gap as
    // the POST handler above.
    const updated = await transactionService.update(
      id,
      /** @type {Record<string, any> & { tags?: string[] }} */ (fields),
    );
    if (!updated) {
      throw new NotFoundError(`Transaction with ID ${id} not found`);
    }

    res.ok(formatTransaction(updated));
  },
);

// DELETE /api/transactions/:id
router.delete(
  "/:id",
  validateIdParam,
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const id = parseRouteId(req);
    const deleted = await transactionService.hardDeleteWithCleanup(id);
    if (!deleted) {
      throw new NotFoundError(`Transaction with ID ${id} not found`);
    }
    // Hard delete → 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
    res.status(204).send();
  },
);

/**
 * Format a transaction row for API response.
 * Maps the DB "date" column to "transaction_date" and adds empty links array.
 */
/** @param {(EnrichedTransactionRow & { amount_eur?: number|string }) | null} row `amount_eur` is added at runtime by convertRowsToEur() when normalize_to_eur=true — not part of the repository's own row shape. */
function formatTransaction(row) {
  if (!row) return null;
  const amount = toNumber(toDecimal(row.amount));
  const amountEur =
    row.amount_eur != null ? toNumber(toDecimal(row.amount_eur)) : amount;
  return {
    id: row.id,
    // DATE column: emit the calendar day, not the raw pg Date (which JSON-
    // serializes as the previous day's ISO timestamp east of UTC).
    transaction_date: toWireDate(row.date),
    date: toWireDate(row.date),
    bank_account: row.bank_account,
    recipient_id: row.recipient_id,
    recipient_name: row.recipient_name || null,
    memo: row.memo,
    amount,
    amount_eur: amountEur,
    currency: row.currency,
    balance: row.balance != null ? toNumber(toDecimal(row.balance)) : null,
    // Per-account running balance — present only when the list was queried
    // with include_balance=true (SQL window in transactionRepository, ADR-088
    // partition; first consumed by the /accounts/:id ledger route, WP-B4).
    // Key omitted entirely on non-windowed reads so single-row GET/create/
    // update responses are unchanged.
    ...(row.running_balance != null && {
      running_balance: toNumber(toDecimal(row.running_balance)),
    }),
    category_id: row.effective_category_id ?? row.category_id,
    category_name: row.category_name || null,
    comment: row.comment,
    tags: row.tags ?? [],
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    /** @type {any[]} */
    links: [],
  };
}

export default router;
