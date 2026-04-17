/**
 * Transaction routes.
 *
 * Mirrors: apps/backend/api/api_routes_transactions.py
 */

import { Router } from 'express';
import { query as dbQuery } from '../database/connection.js';
import transactionRepository from '../repositories/transactionRepository.js';
import { isManualDuplicate, recordManualRawTransaction } from '../services/deduplication.js';
import { convertRowsToEur } from '../services/currencyConversionService.js';
import { normalizeForMatching } from '../services/textNormalization.js';
import { logger } from '../config/logger.js';
import { validateIdParam } from '../middleware/validation.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import { scheduleRefresh } from '../services/materializedViewService.js';

const router = Router();

function parseRouteId(req) {
  return parseInt(req.params.id, 10);
}

function parseTransactionListQuery(query) {
  const {
    limit = 50, offset = 0,
    transaction_id,
    start_date, end_date, bank_account,
    category_id, recipient_id, recipient_name,
    active = 'true', search,
    sort_by, sort_dir,
    include_balance,
  } = query;

  return {
    limit: Math.min(parseInt(limit, 10) || 50, 5000),
    offset: parseInt(offset, 10) || 0,
    transactionId: transaction_id ? parseInt(transaction_id, 10) : null,
    startDate: start_date || null,
    endDate: end_date || null,
    bankAccount: bank_account || null,
    categoryId: category_id ? parseInt(category_id, 10) : null,
    recipientId: recipient_id ? parseInt(recipient_id, 10) : null,
    recipientName: recipient_name || null,
    search: search ? String(search).slice(0, 200) : null,
    active: active !== 'false',
    sortBy: sort_by || null,
    sortDir: sort_dir === 'asc' || sort_dir === 'desc' ? sort_dir : null,
    includeBalance: include_balance === 'true',
  };
}

const DANGEROUS_CSV_FORMULA_PREFIXES = new Set(['=', '+', '-', '@']);

function neutralizeCsvFormula(value) {
  if (!value) return value;
  const trimmedStart = value.trimStart();
  if (!trimmedStart) return value;
  const firstChar = trimmedStart.charAt(0);
  if (!DANGEROUS_CSV_FORMULA_PREFIXES.has(firstChar)) return value;
  return `'${value}`;
}

function escapeCsvValue(value) {
  if (value == null) return '';
  const stringValue = neutralizeCsvFormula(String(value));
  return stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')
    ? `"${stringValue.replace(/"/g, '""')}"`
    : stringValue;
}

function buildTransactionCsvRow(row, { includeBalance = false } = {}) {
  const cols = [
    row.date, row.bank_account, row.recipient_name, row.memo,
    row.amount, row.currency, row.balance, row.category_name, row.comment,
  ];
  if (includeBalance) cols.push(row.running_balance);
  return cols.map(escapeCsvValue).join(',');
}

const CSV_EXPORT_CHUNK_SIZE = 1000;

function buildTransactionExportFilename() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `transactions_export_${timestamp}.csv`;
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
      return `Recipient with name '${fields.recipient_name}' does not exist`;
    }
    fields.recipient_id = recipientResult.rows[0].id;
  }

  delete fields.recipient_name;
  return null;
}

async function resolveCategoryNameToId(fields) {
  if (fields.category_name && !fields.category_id) {
    const normalized = fields.category_name.toUpperCase().trim();
    if (!normalized.includes(':')) {
      return `Invalid category name format '${normalized}'. Expected format: 'General:Detail' (e.g., 'FOOD:BEVERAGES')`;
    }
    const [general, detail] = normalized.split(':', 2).map(s => s.trim());
    const catResult = await dbQuery(
      `SELECT id FROM categories WHERE general = $1 AND detail = $2 LIMIT 1`,
      [general, detail]
    );
    if (catResult.rows.length === 0) {
      return `Category '${normalized}' does not exist. Please create it first or use an existing category.`;
    }
    fields.category_id = catResult.rows[0].id;
  }

  delete fields.category_name;
  return null;
}

// GET /api/transactions
router.get('/', async (req, res) => {
  try {
    const { uncategorised, normalize_to_eur = 'false', target_currency } = req.query;
    const opts = parseTransactionListQuery(req.query);

    // Fetch items and total count in parallel — they're fully independent queries
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

    // Map date field to transaction_date for frontend compatibility
    const mappedItems = items.map(formatTransaction);

    res.json({
      items: mappedItems,
      total,
      limit: opts.limit,
      offset: opts.offset,
      links: [],
    });
  } catch (err) {
    logger.error('Error retrieving transactions', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving transactions' });
  }
});

// GET /api/transactions/export/csv
// Apply a modest per-route rate limiter to protect the DB-heavy export operation.
// Streams CSV in fixed-size chunks so memory stays bounded regardless of row count.
router.get(
  '/export/csv',
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'transactions-export-csv' }),
  async (req, res) => {
  try {
    const { start_date, end_date, bank_account, category_id, include_balance } = req.query;
    const includeBalance = include_balance === 'true';

    const filterClauses = [`t.is_active = true`];
    const params = [];
    let paramIdx = 1;

    if (start_date) { filterClauses.push(`t.date >= $${paramIdx++}`); params.push(start_date); }
    if (end_date) { filterClauses.push(`t.date <= $${paramIdx++}`); params.push(end_date); }
    if (bank_account) { filterClauses.push(`t.bank_account ILIKE $${paramIdx++}`); params.push(`%${bank_account}%`); }
    if (category_id) { filterClauses.push(`t.category_id = $${paramIdx++}`); params.push(parseInt(category_id, 10)); }

    const whereSql = filterClauses.join(' AND ');

    // Probe for existence before opening the stream so 404 still works cleanly.
    const probeSql = `SELECT 1 FROM transactions t WHERE ${whereSql} LIMIT 1`;
    const probe = await dbQuery(probeSql, params);
    if (probe.rows.length === 0) {
      return res.status(404).json({ detail: 'No transactions found matching filters' });
    }

    const filename = buildTransactionExportFilename();
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);

    const header = includeBalance
      ? 'Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment,Running Balance'
      : 'Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment';
    res.write(header);
    res.write('\n');

    // Chunked keyset-free pagination. Stable ORDER BY (date ASC, id ASC) guarantees
    // no gaps/dupes across pages, and the running_balance window runs per chunk so
    // it stays consistent with the ORDER BY.
    const limitParamIdx = paramIdx;
    const offsetParamIdx = paramIdx + 1;
    const chunkSql = `
      SELECT t.id, t.date, t.bank_account, COALESCE(pr.name, r.name) AS recipient_name, t.memo,
             t.amount, t.currency, t.balance,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               ELSE ''
             END AS category_name,
             t.comment
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN categories rc ON r.default_category_id = rc.id
      LEFT JOIN categories pc ON pr.default_category_id = pc.id
      WHERE ${whereSql}
      ORDER BY t.date ASC, t.id ASC
      LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}
    `;

    // Running balance accumulated in JS so it stays correct across chunks.
    let offset = 0;
    let runningBalance = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const chunk = await dbQuery(chunkSql, [...params, CSV_EXPORT_CHUNK_SIZE, offset]);
      if (chunk.rows.length === 0) break;
      const lines = chunk.rows.map((row) => {
        if (includeBalance) {
          runningBalance += row.amount != null ? parseFloat(row.amount) : 0;
          return buildTransactionCsvRow({ ...row, running_balance: runningBalance }, { includeBalance });
        }
        return buildTransactionCsvRow(row);
      });
      res.write(lines.join('\n'));
      res.write('\n');
      if (chunk.rows.length < CSV_EXPORT_CHUNK_SIZE) break;
      offset += CSV_EXPORT_CHUNK_SIZE;
    }

    res.end();
  } catch (err) {
    logger.error('Error exporting transactions', { error: err.message });
    if (!res.headersSent) {
      res.status(500).json({ detail: 'Error exporting transactions' });
    } else {
      res.end();
    }
  }
});

// GET /api/transactions/:id
router.get('/:id', validateIdParam, async (req, res) => {
  try {
    const transaction = await transactionRepository.getById(parseInt(req.params.id, 10));
    if (!transaction) {
      return res.status(404).json({ detail: `Transaction with ID ${req.params.id} not found` });
    }
    res.json(formatTransaction(transaction));
  } catch (err) {
    logger.error('Error retrieving transaction', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving transaction' });
  }
});

// POST /api/transactions
router.post('/', async (req, res) => {
  try {
    const data = req.body;
    // Support alias "date" -> "transaction_date"
    const txDate = data.transaction_date || data.date;
    if (!txDate || !data.bank_account || !data.recipient_id || data.amount == null) {
      return res.status(400).json({ detail: 'Missing required fields: date, bank_account, recipient_id, amount' });
    }

    // Deduplication check for manually added transactions
    const dupCheck = await isManualDuplicate({
      date: txDate,
      amount: data.amount,
      recipientId: data.recipient_id,
      memo: data.memo || '',
      bankAccount: data.bank_account,
    });

    if (dupCheck.isDuplicate) {
      return res.status(409).json({
        detail: 'Duplicate transaction detected',
        existing_transaction_id: dupCheck.existingTransactionId,
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

    // Record in manual raw transactions table for future dedup
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
    res.status(201).json(formatTransaction(transaction));
  } catch (err) {
    logger.error('Error creating transaction', { error: err.message });
    res.status(500).json({ detail: 'Error creating transaction' });
  }
});

// PATCH /api/transactions/:id
// Mirrors Python's TransactionService.update() with name-to-ID resolution
// Apply per-route rate limiting because this handler performs several DB lookups
// (recipient/category resolution) and updates which could be abused.
router.patch(
  '/:id',
  validateIdParam,
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'transactions-patch' }),
  async (req, res) => {
  try {
    const id = parseRouteId(req);
    const fields = normalizeTransactionPatchFields(req.body);

    const [recipientResolutionError, categoryResolutionError] = await Promise.all([
      resolveRecipientNameToId(fields),
      resolveCategoryNameToId(fields),
    ]);

    if (recipientResolutionError) {
      return res.status(400).json({ detail: recipientResolutionError });
    }
    if (categoryResolutionError) {
      return res.status(400).json({ detail: categoryResolutionError });
    }

    const updated = await transactionRepository.update(id, fields);
    if (!updated) {
      return res.status(404).json({ detail: `Transaction with ID ${id} not found` });
    }

    scheduleRefresh();
    res.json(formatTransaction(updated));
  } catch (err) {
    logger.error('Error updating transaction', { error: err.message });
    res.status(500).json({ detail: 'Error updating transaction' });
  }
});

// DELETE /api/transactions/:id
router.delete('/:id', validateIdParam, async (req, res) => {
  try {
    const id = parseRouteId(req);
    const deleted = await transactionRepository.hardDelete(id);
    if (!deleted) {
      return res.status(404).json({ detail: `Transaction with ID ${id} not found` });
    }
    scheduleRefresh();
    res.json({ message: 'Transaction deleted permanently', details: { method: 'hard delete' }, links: [] });
  } catch (err) {
    logger.error('Error deleting transaction', { error: err.message });
    res.status(500).json({ detail: 'Error deleting transaction' });
  }
});

/**
 * Format a transaction row for API response.
 * Maps the DB "date" column to "transaction_date" and adds empty links array.
 */
function formatTransaction(row) {
  if (!row) return null;
  const amount = row.amount != null ? parseFloat(row.amount) : 0;
  const amountEur = row.amount_eur != null ? parseFloat(row.amount_eur) : amount;
  return {
    id: row.id,
    transaction_date: row.date,
    date: row.date, // alias for backend compatibility
    bank_account: row.bank_account,
    recipient_id: row.recipient_id,
    recipient_name: row.recipient_name || null,
    memo: row.memo,
    amount,
    amount_eur: amountEur,
    currency: row.currency,
    balance: row.balance != null ? parseFloat(row.balance) : null,
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
