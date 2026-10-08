/**
 * Transaction routes.
 *
 * Params, query strings and bodies are parsed with zod through parseInput
 * (ADR-193). The body schemas are LOOSE where the old code was loose
 * (unvalidated fields such as memo/comment/is_active pass through untouched;
 * the repository allow-list decides what is written). Bridges reuse the shared middleware guards so
 * accepted shapes and coercions stay identical to the pre-zod behavior.
 *
 * Handlers keep only request parsing/validation and response shaping
 * (ADR-067): the write orchestration lives in transactionService and the
 * bulk-action SQL in transactionBulkService, and export SQL in
 * transactionExport.
 */

import { Router } from "express";
import { z } from "zod";
import transactionService from "../services/transactionService.ts";
import {
  bulkTagTransactions,
  bulkUpdateTransactions,
  bulkDeleteTransactions,
} from "../services/transactionBulkService.ts";
import { convertRowsToEur } from "../services/currency/currencyConversionService.ts";
import {
  validateId,
  assertYmd,
  assertOptionalId,
  assertCurrency,
  validateIntArray,
  MAX_MONEY_VALUE,
} from "../middleware/validation.ts";
import { rateLimiter } from "../middleware/rateLimiter.ts";
import { ValidationError, NotFoundError } from "../middleware/errorHandler.ts";
import {
  bareMessages,
  formatZodIssues,
  guardField,
  parseInput,
} from "../lib/zodInput.ts";
import {
  booleanQueryFlag,
  idParamsSchema,
  singleQueryValue,
} from "./_inputBridges.ts";
import { toDecimal, toNumber } from "../lib/money.ts";
import { parseAmountFilter } from "../lib/filterBuilder.ts";
import {
  EXPORT_MAX_LIST_SIZE,
  streamCsvExport,
  streamNdjsonExport,
  streamBulkTransactionExport,
} from "../services/transactionExport.ts";
import { parsePagination } from "../lib/pagination.ts";
import { toWireDate } from "../lib/dateFormat.ts";
import type { EnrichedTransactionRow } from "../types/rows.ts";
import type { BulkFilterInput } from "../services/bulkSelection.ts";

const router = Router();

/**
 * A transaction row as formatTransaction reads it: `amount_eur` is added at
 * runtime by convertRowsToEur() when normalize_to_eur=true — not part of the
 * repository's own row shape.
 */
type FormattableTransactionRow = EnrichedTransactionRow & {
  amount_eur?: number | string;
};

function parseRouteId(req: { params: unknown }): number {
  return parseInput(idParamsSchema, req.params).id;
}

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function parseBulkExpectedCount(
  value: unknown,
  filter: unknown,
): number | undefined {
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

// Normalise/validate currency (ISO-4217) so free text never reaches the
// VARCHAR(3) column + 0046 CHECK as a raw 400/500. `rejectEmpty` picks the
// clear-vs-default semantics: POST maps absent/'' to undefined (repo default),
// PATCH rejects a cleared value (the column is NOT NULL).
const currencyField = ({ rejectEmpty = false } = {}) =>
  guardField((value) => {
    if (rejectEmpty && (value == null || value === "")) {
      throw new ValidationError("currency cannot be cleared");
    }
    return assertCurrency(value);
  }).optional();

// recipient_id/category_id on PATCH: null clears (both columns are nullable),
// but a present non-null value must be a positive integer — a non-integer here
// otherwise reached the DB as an FK type error and surfaced as a 500. The
// coerced integer replaces the raw input.
//
// validateId, not `Number()`: the old coercion rejected '12abc' but read '1e3'
// as 1000, '0x10' as 16, true as 1 and [7] as 7, so the PATCH re-pointed the
// transaction at a recipient/category the caller never named — a silent
// mis-attribution in the ledger rather than a 400.
const nullableFkField = (field: string) =>
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
    bank_account: z.never().optional(),
    account_id: nullableFkField("account_id"),
    category_id: nullableFkField("category_id"),
    allow_duplicate: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    const txDate = data.transaction_date || data.date;
    if (
      !txDate ||
      data.account_id == null ||
      !data.recipient_id ||
      data.amount == null
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Missing required fields: date, account_id, recipient_id, amount",
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
  transaction_date: guardField((value) => {
    if (!value) throw new ValidationError("transaction_date cannot be cleared");
    return assertYmd(value, "transaction_date");
  }).optional(),
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
  bank_account: z.never().optional(),
  account_id: nullableFkField("account_id"),
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

// The PATCH body is normalized (read-only keys stripped, `date` remapped)
// before the field rules run; a non-object body is left for the schema to
// reject.
const patchTransactionBodySchema = z.preprocess(
  (body) => (isJsonObject(body) ? normalizeTransactionPatchFields(body) : body),
  patchTransactionSchema,
);

// POST /transfers: the same strict id parse as everywhere else. This was a
// bare parseInt guarded only by Number.isInteger, so `aId: "12abc"` marked
// transaction 12 as a transfer — a wrong-record *write*, not a wrong-record
// read — and an id past int4 (99999999999) passed the guard and 500'd at the
// column. Any failure answers the one combined message.
const transferPairBodySchema = z.unknown().transform((body, ctx) => {
  const raw = isJsonObject(body) ? body : {};
  const a = validateId(raw.aId, "aId");
  const b = validateId(raw.bId, "bId");
  if (!a.valid || !b.valid || a.value === b.value) {
    ctx.addIssue({
      code: "custom",
      message: "aId and bId must be two distinct transaction ids",
    });
    return z.NEVER;
  }
  return { aId: a.value, bId: b.value };
});

// Bulk bodies select rows by `ids` or `filter`; transactionBulkService
// validates that selection (its messages are the established ones). The
// route checks `expected_count`, the filter-mode safety count. A missing body
// reads as an empty one.
//
// The casts name the shapes the service accepts; resolveBulkSelection checks
// them at runtime (validateBulkSelection: "ids contains invalid value: …",
// unknown filter fields).
const bulkSelectionShape = {
  ids: z
    .unknown()
    .optional()
    .transform((value) => value as number[] | undefined),
  filter: z
    .unknown()
    .optional()
    .transform((value) => value as BulkFilterInput | null | undefined),
  expected_count: z.unknown().optional(),
};

const withExpectedCount = <
  T extends { filter?: unknown; expected_count?: unknown },
>(
  body: T,
  ctx: z.RefinementCtx,
) => {
  try {
    return {
      ...body,
      expectedCount: parseBulkExpectedCount(body.expected_count, body.filter),
    };
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    ctx.addIssue({ code: "custom", message: err.message });
    return z.NEVER;
  }
};

const bulkBody = <S extends z.ZodType>(schema: S) =>
  bareMessages(z.preprocess((body) => body ?? {}, schema));

const bulkDeleteBodySchema = bulkBody(
  z.object(bulkSelectionShape).transform(withExpectedCount),
);

// Strip-mode parse: unknown keys are dropped, present keys are validated,
// absent keys stay absent — presence drives the SET clause build. Explicit-
// undefined values (unreachable via JSON) are dropped too, so a
// `category_id: undefined` can never become `SET category_id = NULL`.
const bulkUpdateFieldsBodySchema = z
  .custom<object>((value) => Boolean(value) && typeof value === "object", {
    message: "`fields` must be an object with at least one updatable property",
  })
  .transform((value, ctx) => {
    const result = bulkUpdateFieldsSchema.safeParse(value);
    if (!result.success) {
      ctx.addIssue({ code: "custom", message: formatZodIssues(result.error) });
      return z.NEVER;
    }
    const sanitized = Object.fromEntries(
      Object.entries(result.data).filter(([, field]) => field !== undefined),
    );
    if (Object.keys(sanitized).length === 0) {
      ctx.addIssue({
        code: "custom",
        message:
          "`fields` must contain at least one of: category_id, recipient_id, is_active",
      });
      return z.NEVER;
    }
    return sanitized;
  });

const bulkUpdateBodySchema = bulkBody(
  z
    .object({ ...bulkSelectionShape, fields: bulkUpdateFieldsBodySchema })
    .transform(withExpectedCount),
);

const bulkExportBodySchema = bulkBody(
  z
    .object({
      ...bulkSelectionShape,
      format: z
        .enum(["csv", "json"], { error: "`format` must be 'csv' or 'json'" })
        .default("csv"),
      include_balance: z.unknown().optional(),
    })
    .transform(withExpectedCount),
);

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
 *
 * Returns undefined when the param is absent/empty.
 */
function parseIdListQueryParam(
  raw: unknown,
  field: string,
): number[] | undefined {
  if (raw == null) return undefined;
  const joined = String(raw);
  if (joined === "") return undefined;
  const result = validateIntArray(joined.split(","), field);
  if (!result.valid) throw new ValidationError(result.error);
  return result.value;
}

// Shared list/export filter fields. Values that reach SQL as free-text strings
// are single-valued (a repeated/bracketed key is a 400); the rest keep their
// helpers' lenient readings. bareMessages keeps the established 400 texts
// ("account_id must be a positive integer").
const transactionFilterQueryShape = {
  // Every scalar id here goes through assertOptionalId — absent/empty means
  // "no filter" (undefined, 200), anything malformed is a 400. These were bare
  // `x ? parseInt(x) : null`, which took the leading digits of anything:
  // ?category_id=12abc filtered by category 12, ?recipient_group_id=1e3 by
  // group 1, ?transaction_id=0 and ?recipient_id=-4 reached the SQL builder
  // as ids no row can have, and a NaN (which is what the Transactions page
  // sends for a hand-edited URL) passed the `!= null` guard and reached
  // Postgres as a 22P02 500.
  transaction_id: optionalIdQuery("transaction_id"),
  start_date: guardField((value) => assertYmd(value, "start_date")),
  end_date: guardField((value) => assertYmd(value, "end_date")),
  // account_id is the preferred account filter (ADR-088 — reads key on the
  // FK); bank_account stays as a substring escape hatch.
  account_id: optionalIdQuery("account_id"),
  bank_account: singleQueryValue("bank_account"),
  category_id: optionalIdQuery("category_id"),
  category_ids: guardField((value) =>
    parseIdListQueryParam(value, "category_ids"),
  ),
  recipient_id: optionalIdQuery("recipient_id"),
  recipient_group_id: optionalIdQuery("recipient_group_id"),
  recipient_name: singleQueryValue("recipient_name"),
  search: singleQueryValue("search"),
  active: booleanQueryFlag(true),
  sort_by: singleQueryValue("sort_by"),
  sort_dir: z
    .unknown()
    .optional()
    .transform((value): "asc" | "desc" | undefined =>
      value === "asc" || value === "desc" ? value : undefined,
    ),
  include_balance: booleanQueryFlag(),
  transaction_type: z
    .unknown()
    .optional()
    .transform((value): "income" | "expense" | undefined =>
      value === "income" || value === "expense" ? value : undefined,
    ),
  amount_min: z.unknown().optional(),
  amount_max: z.unknown().optional(),
  amount_exact: z.unknown().optional(),
  amount_signed: booleanQueryFlag(),
  tags: z
    .unknown()
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      const slugs = String(value)
        .split(",")
        .map((slug) => slug.trim().toLowerCase())
        .filter(Boolean);
      return slugs.length ? slugs : undefined;
    }),
};

function optionalIdQuery(field: string) {
  return guardField((value) => assertOptionalId(value, field));
}

type TransactionFilterQuery = z.output<
  z.ZodObject<typeof transactionFilterQueryShape>
>;

/** The list/export service filter model from the parsed filter fields. */
function toTransactionFilters(query: TransactionFilterQuery) {
  // Amount coercion lives in filterBuilder.parseAmountFilter (shared with
  // bulkSelection). amount_exact is shorthand for min == max.
  const amountSigned = query.amount_signed;
  const amountExact = parseAmountFilter(query.amount_exact, amountSigned);
  const amountMin =
    amountExact != null
      ? amountExact
      : parseAmountFilter(query.amount_min, amountSigned);
  const amountMax =
    amountExact != null
      ? amountExact
      : parseAmountFilter(query.amount_max, amountSigned);

  return {
    transactionId: query.transaction_id,
    startDate: query.start_date,
    endDate: query.end_date,
    accountId: query.account_id,
    bankAccount: query.bank_account || undefined,
    categoryId: query.category_id,
    categoryIds: query.category_ids,
    recipientId: query.recipient_id,
    recipientGroupId: query.recipient_group_id,
    recipientName: query.recipient_name || undefined,
    search: query.search ? query.search.slice(0, 200) : undefined,
    active: query.active,
    sortBy: query.sort_by || undefined,
    sortDir: query.sort_dir,
    includeBalance: query.include_balance,
    transactionType: query.transaction_type,
    amountMin,
    amountMax,
    amountSigned,
    tagSlugs: query.tags,
  };
}

// GET / — the filters plus pagination, the uncategorised view and the
// optional EUR normalization.
const transactionListQuerySchema = bareMessages(
  z.looseObject({
    ...transactionFilterQueryShape,
    uncategorised: booleanQueryFlag(),
    normalize_to_eur: booleanQueryFlag(),
    target_currency: singleQueryValue("target_currency"),
  }),
).transform((query) => ({
  opts: {
    ...parsePagination(query, { maxLimit: 5000 }),
    ...toTransactionFilters(query),
  },
  uncategorised: query.uncategorised,
  normalizeToEur: query.normalize_to_eur,
  targetCurrency: query.target_currency,
}));

/**
 * The transactions export filters, as a service input model.
 *
 * Accepts the same raw query-string shape used by the list endpoint, including
 * `transaction_id`, `recipient_id`, `recipient_name`, `search`,
 * `transaction_type`, and `active`. SQL construction belongs to
 * `transactionExport`; the route returns only validated domain filters.
 *
 * Account multi-value support: `account_ids=1,2,3` → array of ids (preferred);
 * `bank_accounts=a,b,c` → array of trimmed strings (legacy escape hatch).
 */
const transactionExportQuerySchema = bareMessages(
  z.object({
    ...transactionFilterQueryShape,
    // Validated in full BEFORE the cap is applied, so a malformed id past
    // EXPORT_MAX_LIST_SIZE still rejects rather than being sliced away unseen.
    // The cap itself is unchanged (it silently truncates an over-long list —
    // a separate, pre-existing narrowing, shared with bank_accounts below).
    account_ids: guardField((value) =>
      parseIdListQueryParam(value, "account_ids")?.slice(
        0,
        EXPORT_MAX_LIST_SIZE,
      ),
    ),
    bank_accounts: z
      .unknown()
      .optional()
      .transform((value) =>
        value
          ? String(value)
              .split(",")
              .map((account) => account.trim())
              .filter(Boolean)
              .slice(0, EXPORT_MAX_LIST_SIZE)
          : undefined,
      ),
  }),
).transform((query) => {
  const opts = toTransactionFilters(query);
  return {
    includeBalance: opts.includeBalance,
    filters: {
      transactionId: opts.transactionId,
      startDate: opts.startDate,
      endDate: opts.endDate,
      accountId: opts.accountId,
      accountIds: query.account_ids?.length ? query.account_ids : undefined,
      bankAccount: opts.bankAccount,
      bankAccounts: query.bank_accounts?.length
        ? query.bank_accounts
        : undefined,
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
    },
  };
});

function normalizeTransactionPatchFields(
  body: Record<string, unknown>,
): Record<string, unknown> {
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
router.get("/transfer-suggestions", async (req, res) => {
  res.ok({ items: await transactionService.getTransferSuggestions() });
});

// POST /api/transactions/transfers — manually confirm a transfer pair (sticky)
router.post("/transfers", async (req, res) => {
  const { aId, bId } = parseInput(transferPairBodySchema, req.body);
  await transactionService.markTransfer(aId, bId);
  res.ok({ ok: true });
});

// DELETE /api/transactions/transfers/:id — clear a transfer mark and its peer
router.delete("/transfers/:id", async (req, res) => {
  await transactionService.unmarkTransfer(parseRouteId(req));
  // Deleting the transfer mark reports nothing the caller can't derive →
  // 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
  res.status(204).send();
});

// GET /api/transactions
router.get("/", async (req, res) => {
  const { opts, uncategorised, normalizeToEur, targetCurrency } = parseInput(
    transactionListQuerySchema,
    req.query,
  );

  let items: FormattableTransactionRow[];
  let total: number;
  if (uncategorised) {
    const result = await transactionService.getUncategorisedWithCount(opts);
    items = result.rows;
    total = result.total;
  } else {
    const result = await transactionService.getAllWithCount(opts);
    items = result.rows;
    total = result.total;
  }

  if (normalizeToEur) {
    // convertRowsToEur's JSDoc widens rows to Record<string, any>; it returns
    // the input rows with `amount_eur` added.
    items = (await convertRowsToEur(
      items,
      targetCurrency || "EUR",
    )) as FormattableTransactionRow[];
  }

  res.ok({
    items: items.map(formatTransaction),
    total,
    limit: opts.limit,
    offset: opts.offset,
    links: [],
  });
});

// GET /api/transactions/export/csv
// Rate-limited, streamed CSV. Chunked pagination bounds memory.
router.get(
  "/export/csv",
  rateLimiter({
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "transactions-export-csv",
  }),
  async (req, res) => {
    const { filters, includeBalance } = parseInput(
      transactionExportQuerySchema,
      req.query,
    );
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
  async (req, res) => {
    const { filters } = parseInput(transactionExportQuerySchema, req.query);
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
  async (req, res) => {
    const { transaction_ids, add_slugs, remove_slugs } = parseInput(
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
      addSlugs: add_slugs as string[],
      removeSlugs: remove_slugs as string[],
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
  async (req, res) => {
    const { ids, filter, expectedCount } = parseInput(
      bulkDeleteBodySchema,
      req.body,
    );
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
  async (req, res) => {
    const {
      ids,
      filter,
      fields: sanitized,
      expectedCount,
    } = parseInput(bulkUpdateBodySchema, req.body);

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
  async (req, res) => {
    const { ids, filter, format, include_balance } = parseInput(
      bulkExportBodySchema,
      req.body,
    );
    await streamBulkTransactionExport(res, {
      ids,
      filter,
      format,
      includeBalance: include_balance === true,
    });
  },
);

// GET /api/transactions/:id
router.get("/:id", async (req, res) => {
  const id = parseRouteId(req);
  const transaction = await transactionService.getById(id);
  if (!transaction) {
    throw new NotFoundError(`Transaction with ID ${id} not found`);
  }
  res.ok(formatTransaction(transaction));
});

// POST /api/transactions
router.post("/", async (req, res) => {
  // Validated body: currency is coerced (uppercased / undefined → repo
  // default); everything else is forwarded raw, exactly as before the schema.
  // The duplicate check, insert, claim, auto-link, and reconcile chain lives
  // in the service; a duplicate surfaces as ConflictError (409) from there.
  const data = parseInput(createTransactionSchema, req.body);

  // createTransactionSchema is a loose passthrough object (see module doc) —
  // its zod-inferred type makes every field optional, but the schema's own
  // superRefine already enforces date/account_id/recipient_id/amount are
  // present before this line runs (400s otherwise), matching
  // createManualTransaction's required-field param type.
  const { transaction, autoLink } =
    await transactionService.createManualTransaction(
      data as Parameters<typeof transactionService.createManualTransaction>[0],
    );

  res.status(201);
  res.ok({
    ...formatTransaction(transaction),
    auto_linked: autoLink.links[0]?.plannedTransactionId ?? null,
  });
});

// PATCH /api/transactions/:id
router.patch(
  "/:id",
  rateLimiter({
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "transactions-patch",
  }),
  async (req, res) => {
    const id = parseRouteId(req);
    // Whitelist-strip read-only keys, then validate/coerce the typed fields.
    // Absent keys stay absent (partial PATCH), null keeps its clear semantics
    // for the nullable FK columns, and unvalidated fields pass through loose.
    const fields = parseInput(patchTransactionBodySchema, req.body);

    // patchTransactionSchema's tagsField only validates "is an array" (item
    // type unchecked, matching pre-zod behavior); transactionRepository.update
    // types `tags` as `string[]` since that's what it writes to the junction
    // table — same "loose zod passthrough vs. typed repository param" gap as
    // the POST handler above.
    const updated = await transactionService.update(
      id,
      fields as Record<string, unknown> & { tags?: string[] },
    );
    if (!updated) {
      throw new NotFoundError(`Transaction with ID ${id} not found`);
    }

    res.ok(formatTransaction(updated));
  },
);

// DELETE /api/transactions/:id
router.delete("/:id", async (req, res) => {
  const id = parseRouteId(req);
  const deleted = await transactionService.hardDeleteWithCleanup(id);
  if (!deleted) {
    throw new NotFoundError(`Transaction with ID ${id} not found`);
  }
  // Hard delete → 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
  res.status(204).send();
});

/**
 * Format a transaction row for API response.
 * Maps the DB "date" column to "transaction_date" and adds empty links array.
 */
function formatTransaction(row: FormattableTransactionRow | null) {
  if (!row) return null;
  const amount = toNumber(toDecimal(row.amount));
  const amountEur =
    row.amount_eur != null ? toNumber(toDecimal(row.amount_eur)) : amount;
  return {
    id: row.id,
    // DATE column: emit the calendar day, not the raw pg Date (which JSON-
    // serializes as the previous day's ISO timestamp east of UTC).
    transaction_date: toWireDate(row.date),
    bank_account: row.bank_account,
    account_id: row.account_id,
    is_transfer: row.is_transfer,
    transfer_peer_id: row.transfer_peer_id,
    transfer_source: row.transfer_source,
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
    links: [],
  };
}

export { formatTransaction as __formatTransaction };
export default router;
