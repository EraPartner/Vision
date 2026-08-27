import { roundMoney } from '../money.js';
import { sanitizeIsolatedValueSpikes } from './valueSpikeSanitizer.js';

/**
 * Smooth isolated one-day investment-value spikes while preserving sustained
 * changes. Net worth is recomputed with the canonical liabilities-as-negative
 * convention when a point is corrected.
 *
 * @param {Array<{ date: string, liquid: number, liabilities: number, investments: number, netWorth: number }>} snapshots
 * @returns {Array<{ date: string, liquid: number, liabilities: number, investments: number, netWorth: number }>}
 */
export function sanitizeIsolatedDailyInvestmentSpikes(snapshots) {
  const sanitized = sanitizeIsolatedValueSpikes(snapshots, 'investments');
  if (sanitized === snapshots) return sanitized;

  for (let i = 0; i < sanitized.length; i += 1) {
    if (sanitized[i].investments === snapshots[i].investments) continue;
    const liquid = Number(sanitized[i]?.liquid) || 0;
    const liabilities = Number(sanitized[i]?.liabilities) || 0;
    sanitized[i].netWorth = roundMoney(liquid + liabilities + Number(sanitized[i].investments));
  }

  return sanitized;
}
