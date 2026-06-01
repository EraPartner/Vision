/**
 * Transaction routes.
 *
 * Mirrors: apps/backend/api/api_routes_transactions.py
 */

import { Router } from 'express';
import { query as dbQuery, withTransaction } from '../database/connection.js';
import transactionRepository from '../services/transactionService.js';
import { isManualDuplicate, recordManualRawTransaction } from '../services/deduplication.js';
import { convertRowsToEur } from '../services/currency/currencyConversionService.js';
import { normalizeForMatching } from '../services/textNormalization.js';
import { logger } from '../config/logger.js';
import { validateIdParam } from '../middleware/validation.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import { scheduleRefresh } from '../services/materializedViewService.js';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
} from '../middleware/errorHandler.js';
import { toDecimal, toNumber } from '../lib/money.js';
import { buildTransactionWhere, validateInt4Ids } from '../services/filterBuilder.js';
import {
  EXPORT_MAX_LIST_SIZE,
  streamCsvExport,
  streamNdjsonExport,
  buildIdListWhere,
} from '../services/transactionExport.js';
import { resolveBulkSelection } from '../services/bulkSelection.js';

const router = Router();

function parseRouteId(req) {
  return parseInt(req.params.id, 10);
}

function parseTransactionListQuery(query) {
  const {
    limit = 50, offset = 0,
    transaction_id,
    start_date, end_date, bank_account,
    category_id, category_ids, recipient_id, recipient_group_id, recipient_name,
    active = 'true', search,
    sort_by, sort_dir,
    include_balance,
    transaction_type,
    tags,
  } = query;

  const parsedCategoryIds = category_ids
    ? String(category_ids).split(',').map((id) => parseInt(id, 10)).filter((id) => Number.isFinite(id) && id > 0)
    : null;

  const parsedTagSlugs = tags
    ? String(tags).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : null;

  return {
    limit: Math.max(1, Math.min(parseInt(limit, 10) || 50, 5000)),
    offset: Math.max(0, parseInt(offset, 10) || 0),
    transactionId: transaction_id ? parseInt(transaction_id, 10) : null,
    startDate: start_date || null,
    endDate: end_date || null,
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
 * Bank-account multi-value support: `bank_accounts=a,b,c` → array of trimmed values.
 *
 * Returns { whereSql, params, nextParamIdx }.
 */
function buildExportFilters(query) {
  const opts = parseTransactionListQuery(query);

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
    tagSlugs: opts.tagSlugs,
  });

  return { whereSql: sql, params, nextParamIdx };
}

function normalizeTransactionPatchFields(body) {
  const fields = { ...body };

  if (fields.date) {
    fields.transaction_date = fields.date;
    delete fields.date;
  }

  delete fields.links;
  delete fields.id;
  delete fields.created_at;

  return fields;
}

async function resolveRecipientNameToId(fields) {
  if (fields.recipient_name && !fields.recipient_id) {
    const normalized = normalizeForMatching(fields.recipient_name);
    const recipientResult = await dbQuery(
      `SELECT id FROM recipients WHERE normalized_name = $1 LIMIT 1`,
      [normalized]
    );
    if (recipientResult.rows.length === 0) {
      throw new ValidationError(`Recipient with name '${fields.recipient_name}' does not exist`);
    }
    fields.recipient_id = recipientResult.rows[0].id;
  }

  delete fields.recipient_name;
}

async function resolveCategoryNameToId(fields) {
  if (fields.category_name && !fields.category_id) {
    const normalized = fields.category_name.toUpperCase().trim();
    if (!normalized.includes(':')) {
      throw new ValidationError(
        `Invalid category name format '${normalized}'. Expected format: 'General:Detail' (e.g., 'FOOD:BEVERAGES')`,
      );
    }
    const [general, detail] = normalized.split(':', 2).map(s => s.trim());
    const catResult = await dbQuery(
      `SELECT id FROM categories WHERE general = $1 AND detail = $2 LIMIT 1`,
      [general, detail]
    );
    if (catResult.rows.length === 0) {
      throw new ValidationError(
        `Category '${normalized}' does not exist. Please create it first or use an existing category.`,
      );
    }
    fields.category_id = catResult.rows[0].id;
  }

  delete fields.category_name;
}

// GET /api/transactions
router.get('/', async (req, res) => {
  const { uncategorised, normalize_to_eur = 'false', target_currency } = req.query;
  const opts = parseTransactionListQuery(req.query);

  let items, total;
  if (uncategorised === 'true') {
    const result = await transactionRepository.getUncategorisedWithCount(opts);
    items = result.rows;
    total = result.total;
  } else {
    const result = await transactionRepository.getAllWithCount(opts);
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
    const { transaction_ids, add_slugs = [], remove_slugs = [] } = req.body;

    if (!Array.isArray(transaction_ids) || transaction_ids.length === 0 || transaction_ids.length > 500) {
      throw new ValidationError('transaction_ids must be a non-empty array of up to 500 IDs');
    }
    if (!Array.isArray(add_slugs) || add_slugs.length > 50) {
      throw new ValidationError('add_slugs must be an array of up to 50 slugs');
    }
    if (!Array.isArray(remove_slugs) || remove_slugs.length > 50) {
      throw new ValidationError('remove_slugs must be an array of up to 50 slugs');
    }
    if (add_slugs.length === 0 && remove_slugs.length === 0) {
      throw new ValidationError('At least one of add_slugs or remove_slugs must be non-empty');
    }

    const txIds = validateInt4Ids(transaction_ids.map(Number));
    if (txIds.length === 0) {
      throw new ValidationError('transaction_ids contains no valid IDs');
    }

    const addTagIds = [];
    const removeTagIds = [];
    const allUnknown = [];

    if (add_slugs.length > 0) {
      const r = await dbQuery(
        'SELECT id, slug FROM tags WHERE slug = ANY($1::text[]) AND is_active = true',
        [add_slugs],
      );
      const found = new Map(r.rows.map((row) => [row.slug, row.id]));
      for (const s of add_slugs) {
        if (!found.has(s)) allUnknown.push(s);
        else addTagIds.push(found.get(s));
      }
    }

    if (remove_slugs.length > 0) {
      const r = await dbQuery(
        'SELECT id, slug FROM tags WHERE slug = ANY($1::text[])',
        [remove_slugs],
      );
      const found = new Map(r.rows.map((row) => [row.slug, row.id]));
      for (const s of remove_slugs) {
        if (!found.has(s)) allUnknown.push(s);
        else removeTagIds.push(found.get(s));
      }
    }

    if (allUnknown.length > 0) {
      throw new ValidationError(`Unknown or inactive tags: ${allUnknown.join(', ')}`);
    }

    const result = await withTransaction(async (client) => {
      let added = 0;
      let removed = 0;
      const affectedTxIds = new Set();

      if (addTagIds.length > 0) {
        const r = await client.query(
          `INSERT INTO transaction_tags (transaction_id, tag_id)
           SELECT t_id, g_id
           FROM unnest($1::int[]) AS t(t_id)
           CROSS JOIN unnest($2::int[]) AS g(g_id)
           ON CONFLICT DO NOTHING
           RETURNING transaction_id`,
          [txIds, addTagIds],
        );
        added = r.rows.length;
        r.rows.forEach((row) => affectedTxIds.add(row.transaction_id));
      }

      if (removeTagIds.length > 0) {
        const r = await client.query(
          `DELETE FROM transaction_tags
           WHERE transaction_id = ANY($1::int[]) AND tag_id = ANY($2::int[])
           RETURNING transaction_id`,
          [txIds, removeTagIds],
        );
        removed = r.rows.length;
        r.rows.forEach((row) => affectedTxIds.add(row.transaction_id));
      }

      return { added, removed, transactions_affected: affectedTxIds.size };
    });

    scheduleRefresh();
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
    const txIds = await resolveBulkSelection({ ids, filter });

    const deleted = await withTransaction(async (client) => {
      const r = await client.query(
        `DELETE FROM transactions WHERE id = ANY($1::int[]) RETURNING id`,
        [txIds],
      );
      return r.rows.length;
    });

    if (deleted > 0) scheduleRefresh();
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

    const sanitized = {};
    if ('category_id' in fields) {
      const v = fields.category_id;
      if (v !== null && (!Number.isInteger(v) || v <= 0)) {
        throw new ValidationError('`fields.category_id` must be a positive integer or null');
      }
      sanitized.category_id = v;
    }
    if ('recipient_id' in fields) {
      const v = fields.recipient_id;
      if (!Number.isInteger(v) || v <= 0) {
        throw new ValidationError('`fields.recipient_id` must be a positive integer');
      }
      sanitized.recipient_id = v;
    }
    if ('is_active' in fields) {
      if (typeof fields.is_active !== 'boolean') {
        throw new ValidationError('`fields.is_active` must be a boolean');
      }
      sanitized.is_active = fields.is_active;
    }

    if (Object.keys(sanitized).length === 0) {
      throw new ValidationError('`fields` must contain at least one of: category_id, recipient_id, is_active');
    }

    if (sanitized.category_id != null) {
      const r = await dbQuery(
        'SELECT id FROM categories WHERE id = $1 AND is_active = true',
        [sanitized.category_id],
      );
      if (r.rows.length === 0) {
        throw new ValidationError(`Category ${sanitized.category_id} does not exist or is inactive`);
      }
    }
    if (sanitized.recipient_id != null) {
      const r = await dbQuery(
        'SELECT id FROM recipients WHERE id = $1 AND is_active = true',
        [sanitized.recipient_id],
      );
      if (r.rows.length === 0) {
        throw new ValidationError(`Recipient ${sanitized.recipient_id} does not exist or is inactive`);
      }
    }

    const txIds = await resolveBulkSelection({ ids, filter });

    const setClauses = [];
    const params = [txIds];
    let p = 2;
    if ('category_id' in sanitized) {
      setClauses.push(`category_id = $${p++}`);
      params.push(sanitized.category_id);
    }
    if ('recipient_id' in sanitized) {
      setClauses.push(`recipient_id = $${p++}`);
      params.push(sanitized.recipient_id);
    }
    if ('is_active' in sanitized) {
      setClauses.push(`is_active = $${p}`);
      params.push(sanitized.is_active);
    }
    setClauses.push('updated_at = NOW()');

    const updated = await withTransaction(async (client) => {
      const r = await client.query(
        `UPDATE transactions SET ${setClauses.join(', ')} WHERE id = ANY($1::int[]) RETURNING id`,
        params,
      );
      return r.rows.length;
    });

    if (updated > 0) scheduleRefresh();
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
  const transaction = await transactionRepository.getById(parseInt(req.params.id, 10));
  if (!transaction) {
    throw new NotFoundError(`Transaction with ID ${req.params.id} not found`);
  }
  res.ok(formatTransaction(transaction));
});

// POST /api/transactions
router.post('/', async (req, res) => {
  const data = req.body;
  const txDate = data.transaction_date || data.date;
  if (!txDate || !data.bank_account || !data.recipient_id || data.amount == null) {
    throw new ValidationError('Missing required fields: date, bank_account, recipient_id, amount');
  }
  // Validate recipient_id is a positive integer up front — a non-integer here
  // otherwise reached the DB as an FK type error and surfaced as a 500.
  const recipientIdNum = Number(data.recipient_id);
  if (!Number.isInteger(recipientIdNum) || recipientIdNum <= 0) {
    throw new ValidationError('recipient_id must be a positive integer');
  }
  if (data.tags !== undefined && !Array.isArray(data.tags)) {
    throw new ValidationError('tags must be an array of strings');
  }

  const dupCheck = await isManualDuplicate({
    date: txDate,
    amount: data.amount,
    recipientId: data.recipient_id,
    memo: data.memo || '',
    bankAccount: data.bank_account,
  });

  if (dupCheck.isDuplicate) {
    throw new ConflictError('Duplicate transaction detected', {
      details: { existing_transaction_id: dupCheck.existingTransactionId },
    });
  }

  const transaction = await transactionRepository.create({
    transaction_date: txDate,
    bank_account: data.bank_account,
    recipient_id: data.recipient_id,
    amount: data.amount,
    memo: data.memo,
    currency: data.currency,
    balance: data.balance,
    category_id: data.category_id,
    comment: data.comment,
    tags: Array.isArray(data.tags) ? data.tags : null,
  });

  await recordManualRawTransaction({
    date: txDate,
    amount: data.amount,
    recipientId: data.recipient_id,
    memo: data.memo || '',
    bankAccount: data.bank_account,
    categoryId: data.category_id || null,
    comment: data.comment || null,
    transactionId: transaction.id,
  });

  logger.info('Transaction created', { id: transaction.id });
  scheduleRefresh();
  res.status(201);
  res.ok(formatTransaction(transaction));
});

// PATCH /api/transactions/:id
router.patch(
  '/:id',
  validateIdParam,
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'transactions-patch' }),
  async (req, res) => {
    const id = parseRouteId(req);
    const fields = normalizeTransactionPatchFields(req.body);

    if (fields.tags !== undefined && !Array.isArray(fields.tags)) {
      throw new ValidationError('tags must be an array of strings');
    }

    // Independent — touch disjoint fields, run in parallel.
    await Promise.all([
      resolveRecipientNameToId(fields),
      resolveCategoryNameToId(fields),
    ]);

    const updated = await transactionRepository.update(id, fields);
    if (!updated) {
      throw new NotFoundError(`Transaction with ID ${id} not found`);
    }

    scheduleRefresh();
    res.ok(formatTransaction(updated));
  },
);

// DELETE /api/transactions/:id
router.delete('/:id', validateIdParam, async (req, res) => {
  const id = parseRouteId(req);
  const deleted = await transactionRepository.hardDelete(id);
  if (!deleted) {
    throw new NotFoundError(`Transaction with ID ${id} not found`);
  }
  scheduleRefresh();
  res.ok({ message: 'Transaction deleted permanently', details: { method: 'hard delete' }, links: [] });
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
    transaction_date: row.date,
    date: row.date,
    bank_account: row.bank_account,
    recipient_id: row.recipient_id,
    recipient_name: row.recipient_name || null,
    memo: row.memo,
    amount,
    amount_eur: amountEur,
    currency: row.currency,
    balance: row.balance != null ? toNumber(toDecimal(row.balance)) : null,
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
