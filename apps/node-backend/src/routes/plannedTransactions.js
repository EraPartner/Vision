/**
 * Planned Transaction routes.
 *
 * Mirrors: apps/backend/api/api_routes_planned_transactions.py
 */

import { Router } from 'express';
import plannedTransactionRepository from '../repositories/plannedTransactionRepository.js';
import { logger } from '../config/logger.js';
import { validateIdParam } from '../middleware/validation.js';
import { rateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// GET /api/planned-transactions
router.get('/', async (req, res) => {
  try {
    const {
      limit = 50, offset = 0,
      start_date, end_date, bank_account,
      category_id, recipient_id,
      is_recurring, is_executed, active = 'true', search,
    } = req.query;

    const opts = {
      limit: Math.min(parseInt(limit, 10) || 50, 5000),
      offset: parseInt(offset, 10) || 0,
      startDate: start_date || null,
      endDate: end_date || null,
      bankAccount: bank_account || null,
      categoryId: category_id ? parseInt(category_id, 10) : null,
      recipientId: recipient_id ? parseInt(recipient_id, 10) : null,
      isRecurring: is_recurring != null ? is_recurring === 'true' : null,
      isExecuted: is_executed != null ? is_executed === 'true' : null,
      search: search ? String(search).slice(0, 200) : null,
      active: active !== 'false',
    };

    const { items, total } = await plannedTransactionRepository.getAll(opts);

    res.json({
      items: items.map(formatPlannedTransaction),
      total,
      limit: opts.limit,
      offset: opts.offset,
      links: [],
    });
  } catch (err) {
    logger.error('Error retrieving planned transactions', { error: err.message });
    res.status(500).json({ detail: `Failed to retrieve planned transactions: ${err.message}` });
  }
});

// POST /api/planned-transactions
router.post('/', async (req, res) => {
  try {
    const data = req.body;
    if (!data.planned_date || !data.bank_account || data.amount == null) {
      return res.status(400).json({ detail: 'Missing required fields: planned_date, bank_account, amount' });
    }

    const created = await plannedTransactionRepository.create(data);
    res.status(201).json(formatPlannedTransaction(created));
  } catch (err) {
    logger.error('Error creating planned transaction', { error: err.message });
    res.status(500).json({ detail: `Failed to create planned transaction: ${err.message}` });
  }
});

// GET /api/planned-transactions/:id
router.get('/:id', validateIdParam, async (req, res) => {
  try {
    const pt = await plannedTransactionRepository.getById(parseInt(req.params.id, 10));
    if (!pt) {
      return res.status(404).json({ detail: `Planned transaction ${req.params.id} not found` });
    }
    res.json(formatPlannedTransaction(pt));
  } catch (err) {
    logger.error('Error retrieving planned transaction', { error: err.message });
    res.status(500).json({ detail: `Failed to retrieve planned transaction: ${err.message}` });
  }
});

// PATCH /api/planned-transactions/:id
// Mirrors Python's planned transaction update with name-to-ID resolution
// PATCH /api/planned-transactions/:id
// Apply a per-route rate limiter because this handler performs DB lookups
// and name-to-id resolution which can be expensive when abused.
router.patch(
  '/:id',
  validateIdParam,
  rateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'planned-transactions-patch' }),
  async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await plannedTransactionRepository.getById(id);
    if (!existing) {
      return res.status(404).json({ detail: `Planned transaction ${id} not found` });
    }

    const fields = { ...req.body };
    delete fields.links;
    delete fields.id;
    delete fields.executions;
    delete fields.execution_count;
    delete fields.executed_transaction_id;

    // Resolve recipient_name to recipient_id (mirrors Python PATCH)
    if (fields.recipient_name && !fields.recipient_id) {
      const normalized = fields.recipient_name.toUpperCase().trim();
      const { query: dbQuery } = await import('../database/connection.js');
      const recipientResult = await dbQuery(
        `SELECT id FROM recipients WHERE UPPER(name) = $1 LIMIT 1`,
        [normalized]
      );
      if (recipientResult.rows.length > 0) {
        fields.recipient_id = recipientResult.rows[0].id;
      }
    }
    delete fields.recipient_name;

    // Resolve category_name to category_id (mirrors Python PATCH)
    if (fields.category_name && !fields.category_id) {
      const normalized = fields.category_name.toUpperCase().trim();
      const parts = normalized.split(':');
      if (parts.length === 2) {
        const { query: dbQuery } = await import('../database/connection.js');
        const catResult = await dbQuery(
          `SELECT id FROM categories WHERE general = $1 AND detail = $2 LIMIT 1`,
          [parts[0].trim(), parts[1].trim()]
        );
        if (catResult.rows.length > 0) {
          fields.category_id = catResult.rows[0].id;
        }
      }
    }
    delete fields.category_name;

    const updated = await plannedTransactionRepository.update(id, fields);
    res.json(formatPlannedTransaction(updated));
  } catch (err) {
    logger.error('Error updating planned transaction', { error: err.message });
    res.status(500).json({ detail: `Failed to update planned transaction: ${err.message}` });
  }
});

// POST /api/planned-transactions/:id/execute
router.post('/:id/execute', validateIdParam, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { executed_transaction_id, execution_date } = req.body;

    if (!executed_transaction_id) {
      return res.status(400).json({ detail: 'Missing required field: executed_transaction_id' });
    }

    const existing = await plannedTransactionRepository.getById(id);
    if (!existing) {
      return res.status(404).json({ detail: `Planned transaction ${id} not found` });
    }

    // Add execution record
    await plannedTransactionRepository.addExecution(id, executed_transaction_id, execution_date);

    // Update is_executed and last_executed_date
    const execDate = execution_date || new Date().toISOString().split('T')[0];
    const updateFields = {
      is_executed: !existing.is_recurring, // For recurring, keep false
      last_executed_date: execDate,
    };

    // For recurring transactions, calculate and set next planned_date
    if (existing.is_recurring && existing.recurrence_pattern) {
      const { calculateNextDate } = await import('../services/recurrenceService.js');
      const baseDate = new Date(existing.planned_date);
      const nextDate = calculateNextDate(baseDate, existing.recurrence_pattern);
      if (nextDate) {
        updateFields.planned_date = nextDate.toISOString().split('T')[0];
        updateFields.is_executed = false; // Reset for next occurrence
      }
    }

    const updated = await plannedTransactionRepository.update(id, updateFields);

    res.json(formatPlannedTransaction(updated));
  } catch (err) {
    logger.error('Error executing planned transaction', { error: err.message });
    res.status(500).json({ detail: `Failed to execute planned transaction: ${err.message}` });
  }
});

// DELETE /api/planned-transactions/:id
router.delete('/:id', validateIdParam, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const deleted = await plannedTransactionRepository.hardDelete(id);
    if (!deleted) {
      return res.status(404).json({ detail: `Planned transaction ${id} not found` });
    }
    res.json({ message: `Planned transaction ${id} deleted permanently`, links: [] });
  } catch (err) {
    logger.error('Error deleting planned transaction', { error: err.message });
    res.status(500).json({ detail: `Failed to delete planned transaction: ${err.message}` });
  }
});

function formatPlannedTransaction(row) {
  if (!row) return null;
  return {
    id: row.id,
    planned_date: row.planned_date,
    bank_account: row.bank_account,
    recipient_id: row.recipient_id,
    recipient_name: row.recipient_name || null,
    memo: row.memo,
    amount: parseFloat(row.amount),
    currency: row.currency,
    category_id: row.category_id,
    category_name: row.category_name || null,
    comment: row.comment,
    url: row.url || null,
    is_recurring: row.is_recurring,
    recurrence_pattern: row.recurrence_pattern,
    is_executed: row.is_executed,
    last_executed_date: row.last_executed_date,
    executed_transaction_id: row.executed_transaction_id || null,
    execution_count: row.execution_count || 0,
    executions: (row.executions || []).map(e => ({
      id: e.id,
      executed_transaction_id: e.executed_transaction_id,
      execution_date: e.execution_date,
      created_at: e.created_at,
    })),
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    links: [],
  };
}

export default router;
