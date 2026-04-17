/**
 * Category breakdown aggregation.
 *
 * Thin calc-layer wrapper over infoRepository.getCategoryBreakdown. Backed
 * by mv_category_totals in the repository; when exclusions land in Phase 6
 * the wrapper will pass them through.
 */

import infoRepository from '../../../repositories/infoRepository.js';
import { buildEnvelope } from './_envelope.js';

export async function computeCategoryBreakdown({
  targetCurrency = 'EUR',
} = {}) {
  const categories = await infoRepository.getCategoryBreakdown(targetCurrency);
  return buildEnvelope({ categories }, { source: 'mv' });
}

export default { computeCategoryBreakdown };
