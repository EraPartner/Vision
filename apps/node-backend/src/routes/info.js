/**
 * Info/Statistics routes.
 *
 * Mirrors: apps/backend/api/api_routes_info.py
 */

import { Router } from 'express';
import infoRepository from '../repositories/infoRepository.js';
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

    const data = await infoRepository.getMonthlyFinancialSummary(excludedCategoryIds);
    res.json({ ...data, links: [] });
  } catch (err) {
    logger.error('Error retrieving monthly summary', { error: err.message });
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
    const data = await infoRepository.getCashflowComparison();
    res.json(data);
  } catch (err) {
    logger.error('Error retrieving cashflow comparison', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving cashflow comparison' });
  }
});

export default router;
