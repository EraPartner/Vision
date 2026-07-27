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
 * bulk-action SQL in transactionBulkService.
 */

import { Router } from 'express';
import { z } from 'zod';
import transactionService from '../services/transactionService.js';
import {
  bulkTagTransactions,
  bulkUpdateTransactions,
  bulkDeleteTransactions,
} from '../services/transactionBulkService.js';
import { resolveRecipientIdByName } from '../services/recipientService.js';
import { resolveCategoryIdByName } from '../services/categoryService.js';
import { convertRowsToEur } from '../services/currency/currencyConversionService.js';
import { validateIdParam, assertYmd, assertOptionalId, assertCurrency, assertMaxLength, MAX_MONEY_VALUE } from '../middleware/validation.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import {
  scheduleReconcile,
  getTransferSuggestions,
  markTransfer,
  unmarkTransfer,
} from '../services/transferReconciliationService.js';
import {
  ValidationError,
  NotFoundError,
} from '../middleware/errorHandler.js';
import { toDecimal, toNumber } from '../lib/money.js';
import { buildTransactionWhere, parseAmountFilter } from '../lib/filterBuilder.js';
import {
  EXPORT_MAX_LIST_SIZE,
  streamCsvExport,
  streamNdjsonExport,
  buildIdListWhere,
} from '../services/transactionExport.js';
import { resolveBulkSelection } from '../services/bulkSelection.js';
import { parsePagination } from '../lib/pagination.js';
import { toWireDate } from '../lib/dateFormat.js';

const router = Router();

function parseRouteId(req) {
  return parseInt(req.params.id, 10);
}

/* ── Zod schemas ─────────────────────────────────────────────────────────── */

const tagsField = z.array(z.unknown(), { error: 'tags must be an array of strings' }).optional();

// bank_account is TEXT on transactions but VARCHAR(100) on the raw mirror
// (manual_raw_transactions); cap it up front so the mirror insert can't 500
// *after* the main row already committed. null/short values pass untouched.
const bankAccountField = z.unknown().transform((value, ctx) => {
  try {
    return assertMaxLength(value, 100, 'bank_account');
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: err.message });
    return z.NEVER;
  }
}).optional();

// Normalise/validate currency (ISO-4217) so free text never reaches the
// VARCHAR(3) column + 0046 CHECK as a raw 400/500. `rejectEmpty` picks the
// clear-vs-default semantics: POST maps absent/'' to undefined (repo default),
// PATCH rejects a cleared value (the column is NOT NULL).
const currencyField = ({ rejectEmpty = false } = {}) => z.unknown().transform((value, ctx) => {
  if (rejectEmpty && (value == null || value === '')) {
    ctx.addIssue({ code: 'custom', message: 'currency cannot be cleared' });
    return z.NEVER;
  }
  try {
    return assertCurrency(value);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: err.message });
    return z.NEVER;
  }
}).optional();

// recipient_id/category_id on PATCH: null clears (both columns are nullable),
// but a present non-null value must be a positive integer — a non-integer here
// otherwise reached the DB as an FK type error and surfaced as a 500. The
// coerced integer replaces the raw input.
const nullableFkField = (field) => z.unknown().transform((value, ctx) => {
  if (value === null) return null;
  const idNum = Number(value);
  if (!Number.isInteger(idNum) || idNum <= 0) {
    ctx.addIssue({ code: 'custom', message: `${field} must be a positive integer` });
    return z.NEVER;
  }
  return idNum;
}).optional();

// POST body: per-field guards run first; the cross-field required/amount/
// recipient checks mirror the pre-zod handler (raw values are forwarded to the
// repository — POST never coerced amount/recipient_id in the created row).
const createTransactionSchema = z.looseObject({
  tags: tagsField,
  currency: currencyField(),
  bank_account: bankAccountField,
}).superRefine((data, ctx) => {
  const txDate = data.transaction_date || data.date;
  if (!txDate || !data.bank_account || !data.recipient_id || data.amount == null) {
    ctx.addIssue({ code: 'custom', message: 'Missing required fields: date, bank_account, recipient_id, amount' });
    return;
  }
  // Sign carries meaning (− expense / + income), so a zero amount is
  // meaningless and only pollutes aggregations — reject it up front.
  const amountNum = Number(data.amount);
  if (!Number.isFinite(amountNum) || amountNum === 0 || Math.abs(amountNum) > MAX_MONEY_VALUE) {
    ctx.addIssue({ code: 'custom', message: 'amount must be a non-zero finite number within range' });
  }
  // Validate recipient_id is a positive integer up front — a non-integer here
  // otherwise reached the DB as an FK type error and surfaced as a 500.
  const recipientIdNum = Number(data.recipient_id);
  if (!Number.isInteger(recipientIdNum) || recipientIdNum <= 0) {
    ctx.addIssue({ code: 'custom', message: 'recipient_id must be a positive integer' });
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
  transaction_date: z.unknown().transform((value, ctx) => {
    if (!value) {
      ctx.addIssue({ code: 'custom', message: 'transaction_date cannot be cleared' });
      return z.NEVER;
    }
    try {
      return assertYmd(value, 'transaction_date');
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: err.message });
      return z.NEVER;
    }
  }).optional(),
  amount: z.unknown().transform((value, ctx) => {
    const amountNum = Number(value);
    if (value == null || value === '' || !Number.isFinite(amountNum) || Math.abs(amountNum) > MAX_MONEY_VALUE) {
      ctx.addIssue({ code: 'custom', message: 'amount must be a number within range' });
      return z.NEVER;
    }
    return amountNum;
  }).optional(),
  currency: currencyField({ rejectEmpty: true }),
  bank_account: bankAccountField,
  recipient_id: nullableFkField('recipient_id'),
  category_id: nullableFkField('category_id'),
});

const bulkTagSchema = z.object({
  transaction_ids: z.array(z.unknown(), { error: 'transaction_ids must be a non-empty array of up to 500 IDs' })
    .min(1, { error: 'transaction_ids must be a non-empty array of up to 500 IDs' })
    .max(500, { error: 'transaction_ids must be a non-empty array of up to 500 IDs' }),
  add_slugs: z.array(z.unknown(), { error: 'add_slugs must be an array of up to 50 slugs' })
    .max(50, { error: 'add_slugs must be an array of up to 50 slugs' })
    .default([]),
  remove_slugs: z.array(z.unknown(), { error: 'remove_slugs must be an array of up to 50 slugs' })
    .max(50, { error: 'remove_slugs must be an array of up to 50 slugs' })
    .default([]),
}).superRefine((data, ctx) => {
  if (data.add_slugs.length === 0 && data.remove_slugs.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'At least one of add_slugs or remove_slugs must be non-empty' });
  }
});

// bulk-update `fields`: strict (no coercion) — the pre-zod code required real
// numbers/booleans here. Unknown keys are stripped, exactly like the old
// manual sanitized{} build; presence drives the SET clause construction.
const bulkUpdateFieldsSchema = z.object({
  category_id: z.number({ error: '`fields.category_id` must be a positive integer or null' })
    .int({ error: '`fields.category_id` must be a positive integer or null' })
    .positive({ error: '`fields.category_id` must be a positive integer or null' })
    .nullable().optional(),
  recipient_id: z.number({ error: '`fields.recipient_id` must be a positive integer' })
    .int({ error: '`fields.recipient_id` must be a positive integer' })
    .positive({ error: '`fields.recipient_id` must be a positive integer' })
    .optional(),
  is_active: z.boolean({ error: '`fields.is_active` must be a boolean' }).optional(),
});

// schema → safeParse → joined issues → ValidationError (settings.js idiom).
function parseTransactionBody(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const msg = result.error.issues
      .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
      .join('; ');
    throw new ValidationError(msg);
  }
  return result.data;
}

function parseTransactionListQuery(query) {
  const {
    transaction_id,
    start_date, end_date, account_id, bank_account,
    category_id, category_ids, recipient_id, recipient_group_id, recipient_name,
    active = 'true', search,
    sort_by, sort_dir,
    include_balance,
    transaction_type,
    amount_min, amount_max, amount_exact, amount_signed,
    tags,
  } = query;
  const { limit, offset } = parsePagination(query, { maxLimit: 5000 });

  const parsedCategoryIds = category_ids
    ? String(category_ids).split(',').map((id) => parseInt(id, 10)).filter((id) => Number.isFinite(id) && id > 0)
    : null;

  const parsedTagSlugs = tags
    ? String(tags).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : null;

  // Amount coercion lives in filterBuilder.parseAmountFilter (shared with
  // bulkSelection). amount_exact is shorthand for min == max.
  const amountSigned = amount_signed === 'true' || amount_signed === '1';
  const amountExact = parseAmountFilter(amount_exact, amountSigned);
  const amountMin = amountExact != null ? amountExact : parseAmountFilter(amount_min, amountSigned);
  const amountMax = amountExact != null ? amountExact : parseAmountFilter(amount_max, amountSigned);

  return {
    limit,
    offset,
    transactionId: transaction_id ? parseInt(transaction_id, 10) : null,
    startDate: assertYmd(start_date, 'start_date'),
    endDate: assertYmd(end_date, 'end_date'),
    // account_id is the preferred account filter (ADR-088 — reads key on the
    // FK); bank_account stays as a substring escape hatch.
    accountId: assertOptionalId(account_id, 'account_id'),
    bankAccount: bank_account || null,
    categoryId: category_id ? parseInt(category_id, 10) : null,
    categoryIds: parsedCategoryIds?.length ? parsedCategoryIds : null,
    recipientId: recipient_id ? parseInt(recipient_id, 10) : null,
    recipientGroupId: recipient_group_id ? parseInt(recipient_group_id, 10) : null,
    recipientName: recipient_name || null,
    search: search ? String(search).slice(0, 200) : null,
    active: active !== 'false',
    sortBy: sort_by || null,
    sortDir: sort_dir === 'asc' || sort_dir === 'desc' ? sort_dir : null,
    includeBalance: include_balance === 'true',
    transactionType: transaction_type === 'income' || transaction_type === 'expense' ? transaction_type : null,
    amountMin,
    amountMax,
    amountSigned,
    tagSlugs: parsedTagSlugs?.length ? parsedTagSlugs : null,
  };
}

/**
 * Build WHERE clause + params for the transactions export endpoints.
 *
 * Delegates to the shared `buildTransactionWhere` so the export filter set stays
 * in lockstep with the list endpoint (`GET /api/transactions`). Accepts the same
 * raw query-string shape used by the list endpoint, including `transaction_id`,
 * `recipient_id`, `recipient_name`, `search`, `transaction_type`, and `active`.
 *
 * Account multi-value support: `account_ids=1,2,3` → array of ids (preferred);
 * `bank_accounts=a,b,c` → array of trimmed strings (legacy escape hatch).
 *
 * Returns { whereSql, params, nextParamIdx }.
 */
function buildExportFilters(query) {
  const opts = parseTransactionListQuery(query);

  const accountIds = query.account_ids
    ? String(query.account_ids)
        .split(',')
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n) && n > 0)
        .slice(0, EXPORT_MAX_LIST_SIZE)
    : null;

  const bankAccounts = query.bank_accounts
    ? String(query.bank_accounts)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, EXPORT_MAX_LIST_SIZE)
    : null;

  const { sql, params, nextParamIdx } = buildTransactionWhere({
    transactionId: opts.transactionId,
    startDate: opts.startDate,
    endDate: opts.endDate,
    accountId: opts.accountId,
    accountIds: accountIds && accountIds.length > 0 ? accountIds : null,
    bankAccount: opts.bankAccount,
    bankAccounts: bankAccounts && bankAccounts.length > 0 ? bankAccounts : null,
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
  });

  return { whereSql: sql, params, nextParamIdx };
}

function normalizeTransactionPatchFields(body) {
  // Immutable-rest sanitization (docs/reference/code-patterns.md) — strip
  // read-only keys via destructuring, never with in-place delete.
  const { links: _links, id: _id, created_at: _createdAt, date, ...fields } = body;

  // Remap whenever the key is present — a cleared date ('' / null) must also
  // land on transaction_date so the PATCH validation can reject it instead of
  // letting `SET "date" = ''` reach Postgres.
  if ('date' in body) {
    fields.transaction_date = date;
  }

  return fields;
}

// The name→id resolvers return the id to use (or undefined to leave the
// column untouched) instead of mutating the fields object — the caller strips
// the *_name keys immutably and applies the resolved ids itself.
async function resolveRecipientNameToId(fields) {
  if (!fields.recipient_name || fields.recipient_id) return fields.recipient_id;
  return resolveRecipientIdByName(fields.recipient_name);
}

async function resolveCategoryNameToId(fields) {
  if (!fields.category_name || fields.category_id) return fields.category_id;
  return resolveCategoryIdByName(fields.category_name);
}

// ── Internal transfers (ADR-083) ───────────────────────────────────────────
// Defined before the `/:id` routes; all have 2 path segments or a literal first
// segment so they never collide with the single-segment `/:id` handlers.

// GET /api/transactions/transfer-suggestions — ambiguous transfer matches
router.get('/transfer-suggestions', async (req, res) => {
  res.ok({ items: await getTransferSuggestions() });
});

// POST /api/transactions/transfers — manually confirm a transfer pair (sticky)
router.post('/transfers', async (req, res) => {
  const aId = parseInt(req.body?.aId, 10);
  const bId = parseInt(req.body?.bId, 10);
  if (!Number.isInteger(aId) || !Number.isInteger(bId) || aId === bId) {
    throw new ValidationError('aId and bId must be two distinct transaction ids');
  }
  await markTransfer(aId, bId);
  scheduleReconcile();
  res.ok({ ok: true });
});

// DELETE /api/transactions/transfers/:id — clear a transfer mark and its peer
router.delete('/transfers/:id', validateIdParam, async (req, res) => {
  await unmarkTransfer(parseInt(req.params.id, 10));
  scheduleReconcile();
  // Deleting the transfer mark reports nothing the caller can't derive →
  // 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
  res.status(204).send();
});

// GET /api/transactions
router.get('/', async (req, res) => {
  const { uncategorised, normalize_to_eur = 'false', target_currency } = req.query;
  const opts = parseTransactionListQuery(req.query);

  let items, total;
  if (uncategorised === 'true') {
    const result = await transactionService.getUncategorisedWithCount(opts);
    items = result.rows;
    total = result.total;
  } else {
    const result = await transactionService.getAllWithCount(opts);
    items = result.rows;
    total = result.total;
  }

  if (normalize_to_eur === 'true') {
    items = await convertRowsToEur(items, target_currency || 'EUR');
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
  '/export/csv',
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'transactions-export-csv' }),
  async (req, res) => {
    const includeBalance = req.query.include_balance === 'true';
    const { whereSql, params, nextParamIdx } = buildExportFilters(req.query);
    await streamCsvExport(res, { whereSql, params, nextParamIdx, includeBalance });
  },
);

// GET /api/transactions/export/json
// Rate-limited, streamed NDJSON (newline-delimited JSON). One JSON object per line.
router.get(
  '/export/json',
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'transactions-export-json' }),
  async (req, res) => {
    const { whereSql, params, nextParamIdx } = buildExportFilters(req.query);
    await streamNdjsonExport(res, { whereSql, params, nextParamIdx });
  },
);

// POST /api/transactions/bulk-tag
router.post(
  '/bulk-tag',
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'transactions-bulk-tag' }),
  async (req, res) => {
    const { transaction_ids, add_slugs, remove_slugs } = parseTransactionBody(bulkTagSchema, req.body);

    const result = await bulkTagTransactions({
      transactionIds: transaction_ids,
      addSlugs: add_slugs,
      removeSlugs: remove_slugs,
    });
    res.ok(result);
  },
);

// POST /api/transactions/bulk-delete
// Hard-deletes a set of transactions selected by `ids` or `filter`.
// CASCADE on transaction_tags / transaction_splits / attachments handles
// dependent rows; raw_transactions and import_batches use SET NULL.
router.post(
  '/bulk-delete',
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'transactions-bulk-delete' }),
  async (req, res) => {
    const { ids, filter } = req.body ?? {};
    const deleted = await bulkDeleteTransactions({ ids, filter });
    res.ok({ deleted });
  },
);

// POST /api/transactions/bulk-update
// Applies a single shared update (category, recipient, is_active) to a set of
// transactions selected by `ids` or `filter`. FK targets are validated up front
// so the entire batch fails atomically on the first invalid reference.
router.post(
  '/bulk-update',
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'transactions-bulk-update' }),
  async (req, res) => {
    const { ids, filter, fields } = req.body ?? {};

    if (!fields || typeof fields !== 'object') {
      throw new ValidationError('`fields` must be an object with at least one updatable property');
    }

    // Strip-mode parse: unknown keys are dropped, present keys are validated,
    // absent keys stay absent — presence drives the SET clause build below.
    // Explicit-undefined values (unreachable via JSON) are dropped too, so a
    // `category_id: undefined` can never become `SET category_id = NULL`.
    const sanitized = Object.fromEntries(
      Object.entries(parseTransactionBody(bulkUpdateFieldsSchema, fields))
        .filter(([, value]) => value !== undefined),
    );

    if (Object.keys(sanitized).length === 0) {
      throw new ValidationError('`fields` must contain at least one of: category_id, recipient_id, is_active');
    }

    const updated = await bulkUpdateTransactions({ ids, filter, fields: sanitized });
    res.ok({ updated });
  },
);

// POST /api/transactions/bulk-export
// Streams CSV / NDJSON for a set of transactions selected by `ids` or `filter`.
// Reuses the same chunked streaming pipeline as the GET export endpoints.
router.post(
  '/bulk-export',
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'transactions-bulk-export' }),
  async (req, res) => {
    const { ids, filter, format = 'csv', include_balance = false } = req.body ?? {};
    if (format !== 'csv' && format !== 'json') {
      throw new ValidationError("`format` must be 'csv' or 'json'");
    }

    const txIds = await resolveBulkSelection({ ids, filter });
    const { whereSql, params, nextParamIdx } = buildIdListWhere(txIds);

    if (format === 'csv') {
      await streamCsvExport(res, {
        whereSql,
        params,
        nextParamIdx,
        includeBalance: include_balance === true,
      });
    } else {
      await streamNdjsonExport(res, { whereSql, params, nextParamIdx });
    }
  },
);

// GET /api/transactions/:id
router.get('/:id', validateIdParam, async (req, res) => {
  const transaction = await transactionService.getById(parseInt(req.params.id, 10));
  if (!transaction) {
    throw new NotFoundError(`Transaction with ID ${req.params.id} not found`);
  }
  res.ok(formatTransaction(transaction));
});

// POST /api/transactions
router.post('/', async (req, res) => {
  // Validated body: currency is coerced (uppercased / undefined → repo
  // default); everything else is forwarded raw, exactly as before the schema.
  // The dup-check → insert → raw-mirror → auto-link → reconcile chain lives
  // in the service; a duplicate surfaces as ConflictError (409) from there.
  const data = parseTransactionBody(createTransactionSchema, req.body);

  const { transaction, autoLink } = await transactionService.createManualTransaction(data);

  res.status(201);
  res.ok({
    ...formatTransaction(transaction),
    auto_linked: autoLink.links[0]?.plannedTransactionId ?? null,
  });
});

// PATCH /api/transactions/:id
router.patch(
  '/:id',
  validateIdParam,
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'transactions-patch' }),
  async (req, res) => {
    const id = parseRouteId(req);
    // Whitelist-strip read-only keys, then validate/coerce the typed fields.
    // Absent keys stay absent (partial PATCH), null keeps its clear semantics
    // for the nullable FK columns, and unvalidated fields pass through loose.
    const fields = parseTransactionBody(
      patchTransactionSchema,
      normalizeTransactionPatchFields(req.body),
    );

    // Independent lookups — run in parallel, then apply immutably.
    const [recipientId, categoryId] = await Promise.all([
      resolveRecipientNameToId(fields),
      resolveCategoryNameToId(fields),
    ]);
    const { recipient_name: _recipientName, category_name: _categoryName, ...patch } = fields;
    if (recipientId !== undefined) patch.recipient_id = recipientId;
    if (categoryId !== undefined) patch.category_id = categoryId;

    const updated = await transactionService.update(id, patch);
    if (!updated) {
      throw new NotFoundError(`Transaction with ID ${id} not found`);
    }

    scheduleReconcile();
    res.ok(formatTransaction(updated));
  },
);

// DELETE /api/transactions/:id
router.delete('/:id', validateIdParam, async (req, res) => {
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
function formatTransaction(row) {
  if (!row) return null;
  const amount = toNumber(toDecimal(row.amount));
  const amountEur = row.amount_eur != null ? toNumber(toDecimal(row.amount_eur)) : amount;
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
    links: [],
  };
}

export default router;
