/**
 * Info/Statistics routes.
 *
 * Mirrors: apps/backend/api/api_routes_info.py
 */

import { Router } from 'express';
import infoRepository from '../repositories/infoRepository.js';
import { detectRecurringPatterns } from '../services/recurringDetectionService.js';
import { refreshMaterializedViews } from '../services/materializedViewService.js';
import { logger } from '../config/logger.js';

const router = Router();

// GET /api/info
router.get('/', async (req, res) => {
  try {
    const stats = await infoRepository.getStatistics();
    res.json(stats);
  } catch (err) {
    logger.error('Error retrieving statistics', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving statistics' });
  }
});

// GET /api/info/banks
router.get('/banks', async (req, res) => {
  try {
    const banks = await infoRepository.getBanks();
    res.json({ banks });
  } catch (err) {
    logger.error('Error retrieving banks', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving banks' });
  }
});

// GET /api/info/supported-adapters
router.get('/supported-adapters', async (req, res) => {
  // Static config - mirrors Python BANK_CONFIGURATIONS
  const adapters = [
    { key: 'kbc', name: 'KBC', adapter_class: 'KBCAdapter' },
    { key: 'belfius', name: 'Belfius', adapter_class: 'BelfiusAdapter' },
    { key: 'revolut', name: 'Revolut', adapter_class: 'RevolutAdapter' },
    { key: 'vault_voyager', name: 'Vault Voyager', adapter_class: 'VaultVoyagerAdapter' },
    { key: 'sabb', name: 'SABB', adapter_class: 'SABBAdapter' },
    { key: 'wise', name: 'Wise', adapter_class: 'WiseAdapter' },
  ];
  res.json({ adapters, total_count: adapters.length });
});

// GET /api/info/transaction-count
router.get('/transaction-count', async (req, res) => {
  try {
    const count = await infoRepository.getTransactionCount();
    res.json({ total_transactions: count });
  } catch (err) {
    logger.error('Error retrieving transaction count', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving transaction count' });
  }
});

// GET /api/info/transaction-summary
router.get('/transaction-summary', async (req, res) => {
  try {
    const { bank_account, start_date, end_date } = req.query;
    const summary = await infoRepository.getTransactionSummary({
      bankAccount: bank_account || null,
      startDate: start_date || null,
      endDate: end_date || null,
    });
    res.json(summary);
  } catch (err) {
    logger.error('Error retrieving transaction summary', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving transaction summary' });
  }
});

// GET /api/info/monthly-summary
router.get('/monthly-summary', async (req, res) => {
  try {
    let excludedCategoryIds = req.query.excluded_category_ids;
    if (excludedCategoryIds) {
      if (!Array.isArray(excludedCategoryIds)) excludedCategoryIds = [excludedCategoryIds];
      excludedCategoryIds = excludedCategoryIds.map(Number);
    } else {
      excludedCategoryIds = [9, 22]; // Default exclusions
    }

    logger.debug('Monthly summary request', { excludedCategoryIds });
    const data = await infoRepository.getMonthlyFinancialSummary(excludedCategoryIds);
    logger.debug('Monthly summary response', { monthCount: data.months?.length, summary: data.summary });
    res.json({ ...data, links: [] });
  } catch (err) {
    // Use console.error directly to guarantee output regardless of logger config
    console.error('[monthly-summary] ERROR:', err.message, '\n', err.stack);
    logger.error('Error retrieving monthly summary', { error: err.message, stack: err.stack });
    res.status(500).json({ detail: 'Error retrieving monthly financial summary' });
  }
});

// GET /api/info/planned-expenses-next-month
router.get('/planned-expenses-next-month', async (req, res) => {
  try {
    const data = await infoRepository.getPlannedExpensesNextMonth();
    res.json({ ...data, links: [] });
  } catch (err) {
    logger.error('Error retrieving planned expenses next month', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving planned expenses next month' });
  }
});

// GET /api/info/average-vs-current-spending
router.get('/average-vs-current-spending', async (req, res) => {
  try {
    const data = await infoRepository.getAverageVsCurrentSpending();
    res.json({ ...data, links: [] });
  } catch (err) {
    logger.error('Error retrieving average vs current spending', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving average vs current spending' });
  }
});

// GET /api/info/cashflow-comparison
router.get('/cashflow-comparison', async (req, res) => {
  try {
    let excludedCategoryIds = req.query.excluded_category_ids;
    if (excludedCategoryIds) {
      if (!Array.isArray(excludedCategoryIds)) excludedCategoryIds = [excludedCategoryIds];
      excludedCategoryIds = excludedCategoryIds.map(Number);
    } else {
      excludedCategoryIds = [];
    }
    const data = await infoRepository.getCashflowComparison(excludedCategoryIds);
    res.json(data);
  } catch (err) {
    logger.error('Error retrieving cashflow comparison', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving cashflow comparison' });
  }
});

// GET /api/info/category-breakdown - Detailed category breakdown with amounts
router.get('/category-breakdown', async (req, res) => {
  try {
    const stats = await infoRepository.getStatistics();
    res.json({
      categories: stats.categories,
      links: [],
    });
  } catch (err) {
    logger.error('Error retrieving category breakdown', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving category breakdown' });
  }
});

// GET /api/info/bank-balances - Current and historical balance per bank account
router.get('/bank-balances', async (req, res) => {
  try {
    const data = await infoRepository.getBankBalances();
    res.json(data);
  } catch (err) {
    logger.error('Error retrieving bank balances', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving bank balances' });
  }
});

// GET /api/info/recurring-patterns - Detect recurring transaction patterns
router.get('/recurring-patterns', async (req, res) => {
  try {
    const data = await detectRecurringPatterns();
    res.json(data);
  } catch (err) {
    logger.error('Error detecting recurring patterns; returning empty result', { error: err.message });
    res.json({ patterns: [], total: 0 });
  }
});

// GET /api/info/net-worth - Net worth combining bank balances + portfolio
router.get('/net-worth', async (req, res) => {
  try {
    const data = await infoRepository.getNetWorth();
    res.json(data);
  } catch (err) {
    logger.error('Error retrieving net worth', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving net worth' });
  }
});

// GET /api/info/recipient-insights - Merchant/recipient spending insights
router.get('/recipient-insights', async (req, res) => {
  try {
    const data = await infoRepository.getRecipientInsights();
    res.json(data);
  } catch (err) {
    logger.error('Error retrieving recipient insights', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving recipient insights' });
  }
});

// POST /api/info/refresh-views - Manually refresh materialized views
router.post('/refresh-views', async (req, res) => {
  try {
    const start = Date.now();
    await refreshMaterializedViews();
    res.json({ message: 'Materialized views refreshed', duration_ms: Date.now() - start });
  } catch (err) {
    logger.error('Error refreshing materialized views', { error: err.message });
    res.status(500).json({ detail: 'Error refreshing materialized views' });
  }
});

export default router;
