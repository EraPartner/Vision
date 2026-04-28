/**
 * Transaction routes.
 *
 * Mirrors: apps/backend/api/api_routes_transactions.py
 */

import { Router } from 'express';
import { query as dbQuery } from '../database/connection.js';
import transactionRepository from '../repositories/transactionRepository.js';
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
import { escapeCsvValue } from '../lib/csv.js';
import { buildTransactionWhere } from '../services/filterBuilder.js';

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
  } = query;

  const parsedCategoryIds = category_ids
    ? String(category_ids).split(',').map((id) => parseInt(id, 10)).filter((id) => Number.isFinite(id) && id > 0)
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
  };
}

function buildTransactionCsvRow(row, { includeBalance = false } = {}) {
  const cols = [
    row.date, row.bank_account, row.recipient_name, row.memo,
    row.amount, row.currency, row.balance, row.category_name, row.comment,
  ];
  if (includeBalance) cols.push(row.running_balance);
  return cols.map(escapeCsvValue).join(',');
}

const EXPORT_CHUNK_SIZE = 1000;
const EXPORT_MAX_LIST_SIZE = 50;

function buildExportTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function buildTransactionExportFilename() {
  return `transactions_export_${buildExportTimestamp()}.csv`;
}

function buildTransactionExportJsonFilename() {
  return `transactions_export_${buildExportTimestamp()}.ndjson`;
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
  });

  return { whereSql: sql, params, nextParamIdx };
}

const EXPORT_JOINS_SQL = `
    FROM transactions t
    LEFT JOIN recipients r ON t.recipient_id = r.id
    LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN categories rc ON r.default_category_id = rc.id
    LEFT JOIN categories pc ON pr.default_category_id = pc.id`;

function buildExportProbeSql(whereSql) {
  return `SELECT 1 ${EXPORT_JOINS_SQL} WHERE ${whereSql} LIMIT 1`;
}

function buildExportChunkSql(whereSql, limitParamIdx, offsetParamIdx) {
  return `
    SELECT t.id, t.date, t.bank_account,
           COALESCE(pr.name, r.name) AS recipient_name, t.memo,
           t.amount, t.currency, t.balance,
           CASE
             WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
             WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
             WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
             ELSE ''
           END AS category_name,
           t.comment
    ${EXPORT_JOINS_SQL}
    WHERE ${whereSql}
    ORDER BY t.date ASC, t.id ASC
    LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}
  `;
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

    const probe = await dbQuery(buildExportProbeSql(whereSql), params);
    if (probe.rows.length === 0) {
      throw new NotFoundError('No transactions found matching filters');
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${buildTransactionExportFilename()}`);

    const header = includeBalance
      ? 'Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment,Running Balance'
      : 'Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment';
    res.write(`${header}\n`);

    const chunkSql = buildExportChunkSql(whereSql, nextParamIdx, nextParamIdx + 1);
    let chunkOffset = 0;
    let runningBalance = 0;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const chunk = await dbQuery(chunkSql, [...params, EXPORT_CHUNK_SIZE, chunkOffset]);
        if (chunk.rows.length === 0) break;
        const lines = chunk.rows.map((row) => {
          if (includeBalance) {
            runningBalance = toDecimal(runningBalance).plus(toDecimal(row.amount ?? 0)).toNumber();
            return buildTransactionCsvRow({ ...row, running_balance: runningBalance }, { includeBalance });
          }
          return buildTransactionCsvRow(row);
        });
        res.write(`${lines.join('\n')}\n`);
        if (chunk.rows.length < EXPORT_CHUNK_SIZE) break;
        chunkOffset += EXPORT_CHUNK_SIZE;
      }
      res.end();
    } catch (err) {
      if (res.headersSent) {
        logger.error('CSV export failed mid-stream', { error: err.message });
        res.end();
        return;
      }
      throw err;
    }
  },
);

// GET /api/transactions/export/json
// Rate-limited, streamed NDJSON (newline-delimited JSON). One JSON object per line.
router.get(
  '/export/json',
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'transactions-export-json' }),
  async (req, res) => {
    const { whereSql, params, nextParamIdx } = buildExportFilters(req.query);

    const probe = await dbQuery(buildExportProbeSql(whereSql), params);
    if (probe.rows.length === 0) {
      throw new NotFoundError('No transactions found matching filters');
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', `attachment; filename=${buildTransactionExportJsonFilename()}`);

    const chunkSql = buildExportChunkSql(whereSql, nextParamIdx, nextParamIdx + 1);
    let chunkOffset = 0;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const chunk = await dbQuery(chunkSql, [...params, EXPORT_CHUNK_SIZE, chunkOffset]);
        if (chunk.rows.length === 0) break;
        for (const row of chunk.rows) {
          res.write(JSON.stringify({
            id: row.id,
            date: row.date,
            bank_account: row.bank_account,
            recipient: row.recipient_name ?? null,
            memo: row.memo ?? null,
            amount: row.amount,
            currency: row.currency ?? null,
            balance: row.balance ?? null,
            category: row.category_name || null,
            comment: row.comment ?? null,
          }));
          res.write('\n');
        }
        if (chunk.rows.length < EXPORT_CHUNK_SIZE) break;
        chunkOffset += EXPORT_CHUNK_SIZE;
      }
      res.end();
    } catch (err) {
      if (res.headersSent) {
        logger.error('JSON export failed mid-stream', { error: err.message });
        res.end();
        return;
      }
      throw err;
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
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    links: [],
  };
}

export default router;
