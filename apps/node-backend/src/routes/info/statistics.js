/**
 * /api/info statistics + metadata endpoints:
 *   - GET /
 *   - GET /banks
 *   - GET /supported-adapters
 *   - GET /transaction-count
 *   - GET /transaction-summary
 *   - GET /planned-expenses-next-month
 *   - GET /recurring-patterns
 */

import { Router } from 'express';
import infoRepository from '../../services/infoService.js';
import { detectRecurringPatterns } from '../../services/recurringDetectionService.js';
import { logger } from '../../config/logger.js';
import { getTargetCurrency } from './_queryParams.js';

const router = Router();

router.get('/', async (req, res) => {
  const targetCurrency = getTargetCurrency(req);
  const stats = await infoRepository.getStatistics(targetCurrency);
  res.ok(stats);
});

router.get('/banks', async (req, res) => {
  const banks = await infoRepository.getBanks();
  res.ok({ banks });
});

router.get('/supported-adapters', async (req, res) => {
  const adapters = [
    { key: 'kbc', name: 'KBC', adapter_class: 'KBCAdapter' },
    { key: 'belfius', name: 'Belfius', adapter_class: 'BelfiusAdapter' },
    { key: 'ing', name: 'ING', adapter_class: 'INGAdapter' },
    { key: 'bnp', name: 'BNP Paribas Fortis', adapter_class: 'BNPAdapter' },
    { key: 'revolut', name: 'Revolut', adapter_class: 'RevolutAdapter' },
    { key: 'vision', name: 'Vision', adapter_class: 'VisionAdapter' },
    { key: 'sabb', name: 'SABB', adapter_class: 'SABBAdapter' },
    { key: 'wise', name: 'Wise', adapter_class: 'WiseAdapter' },
  ];
  res.ok({ adapters, total_count: adapters.length });
});

router.get('/transaction-count', async (req, res) => {
  const count = await infoRepository.getTransactionCount();
  res.ok({ total_transactions: count });
});

router.get('/transaction-summary', async (req, res) => {
  const { bank_account, start_date, end_date } = req.query;
  const targetCurrency = getTargetCurrency(req);
  const summary = await infoRepository.getTransactionSummary({
    bankAccount: bank_account || null,
    startDate: start_date || null,
    endDate: end_date || null,
    targetCurrency,
  });
  res.ok(summary);
});

router.get('/planned-expenses-next-month', async (req, res) => {
  const targetCurrency = getTargetCurrency(req);
  const data = await infoRepository.getPlannedExpensesNextMonth(targetCurrency);
  res.ok({ ...data, links: [] });
});

// Intentional graceful degradation: on failure emit empty envelope rather than 500.
router.get('/recurring-patterns', async (req, res) => {
  try {
    const data = await detectRecurringPatterns();
    res.ok(data);
  } catch (err) {
    logger.error('Error detecting recurring patterns; returning empty result', { error: err.message });
    res.ok({ patterns: [], total: 0 });
  }
});

export default router;
