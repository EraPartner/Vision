/**
 * /api/info statistics + metadata endpoints:
 *   - GET /
 *   - GET /banks
 *   - GET /supported-adapters
 *   - GET /transaction-count
 *   - GET /transaction-summary
 *   - GET /planned-expenses-next-month
 *   - GET /recurring-patterns
 *   - GET /insights-digest
 *   - GET /deduction-candidates
 */

import { Router } from 'express';
import infoRepository from '../../services/infoService.js';
import { detectRecurringPatterns } from '../../services/recurringDetectionService.js';
import { getInsightsDigest } from '../../services/insightsDigestService.js';
import { computeDeductionCandidates } from '../../services/tax/deductionCandidatesService.js';
import { listAdapters } from '../../services/importPipeline/adapters/index.js';
import { logger } from '../../config/logger.js';
import { getTargetCurrency } from './_queryParams.js';
import { assertOptionalId } from '../../middleware/validation.js';
import { ValidationError } from '../../middleware/errorHandler.js';

const router = Router();

// (Removed legacy GET /api/info and GET /api/info/transaction-summary — Phase 9
// cutover (ADR-010): the aggregations.js routes superseded them and they had
// zero production callers. The category breakdown lives on via getCategoryBreakdown.)

// Both metadata lists use the canonical `{items, total}` collection shape
// (unpaginated — `total` is the row count, present so pagination could land
// without breaking the shape).
router.get('/banks', async (req, res) => {
  const banks = await infoRepository.getBanks();
  res.ok({ items: banks, total: banks.length });
});

router.get('/supported-adapters', async (req, res) => {
  // Derived from the adapter registry (single source of truth) so a newly
  // registered adapter appears in the import card + onboarding wizard without a
  // second hardcoded list to update. (The old list also referenced
  // *Adapter-class names that don't exist anywhere in the codebase.)
  const adapters = listAdapters();
  res.ok({ items: adapters, total: adapters.length });
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

// Pre-computed insight findings for the Statistics-page panel (no LLM) — same
// graceful degradation as /recurring-patterns: empty digest instead of a 500.
router.get('/insights-digest', async (req, res) => {
  try {
    const digest = await getInsightsDigest();
    res.ok(digest);
  } catch (err) {
    logger.error('Error building insights digest; returning empty result', { error: err.message });
    res.ok({
      subscriptionCreep: { new: [], priceChanges: [] },
      categoryOutliers: [],
      cashForecast: null,
    });
  }
});

/**
 * Optional `year` query param → validated integer, or null when absent.
 * Bounds match the AI-chat tax tools; malformed input (including trailing
 * garbage parseInt would swallow, e.g. `2025abc`) is a 400, not a silent guess.
 */
function assertOptionalYear(value) {
  if (value == null || value === '') return null;
  const year = Number.parseInt(value, 10);
  if (!Number.isInteger(year) || String(year) !== String(value).trim() || year < 1970 || year > 3000) {
    throw new ValidationError('year must be an integer between 1970 and 3000');
  }
  return year;
}

// Transaction-derived Belgian deduction-type candidates for the Tax Overview
// review card. `year` defaults to the current calendar year. Same graceful
// degradation as the siblings above — an empty candidate list instead of a 500
// (a malformed `year` still 400s: it is validated before the try).
router.get('/deduction-candidates', async (req, res) => {
  const year = assertOptionalYear(req.query.year) ?? new Date().getFullYear();
  try {
    const data = await computeDeductionCandidates({ year });
    res.ok(data);
  } catch (err) {
    logger.error('Error computing deduction candidates; returning empty result', { error: err.message });
    res.ok({
      year,
      from: `${year}-01-01`,
      to: `${year}-12-31`,
      currency: 'EUR',
      byDeductionType: [],
    });
  }
});

export default router;
