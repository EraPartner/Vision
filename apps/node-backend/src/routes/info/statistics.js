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
import { listAdapters } from '../../services/importPipeline/adapters/index.js';
import { logger } from '../../config/logger.js';
import { getTargetCurrency } from './_queryParams.js';
import { assertOptionalId } from '../../middleware/validation.js';

const router = Router();

// (Removed legacy GET /api/info and GET /api/info/transaction-summary — Phase 9
// cutover (ADR-010): the aggregations.js routes superseded them and they had
// zero production callers. The category breakdown lives on via getCategoryBreakdown.)

router.get('/banks', async (req, res) => {
  const banks = await infoRepository.getBanks();
  res.ok({ banks });
});

router.get('/supported-adapters', async (req, res) => {
  // Derived from the adapter registry (single source of truth) so a newly
  // registered adapter appears in the import card + onboarding wizard without a
  // second hardcoded list to update. (The old list also referenced
  // *Adapter-class names that don't exist anywhere in the codebase.)
  const adapters = listAdapters();
  res.ok({ adapters, total_count: adapters.length });
});

router.get('/transaction-count', async (req, res) => {
  const accountId = assertOptionalId(req.query.account_id, 'account_id');
  const count = await infoRepository.getTransactionCount({ accountId });
  res.ok({ total_transactions: count });
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
