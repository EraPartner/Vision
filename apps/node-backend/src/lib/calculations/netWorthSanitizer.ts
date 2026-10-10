import { roundMoney } from '../money.ts';
import { sanitizeIsolatedValueSpikes } from './valueSpikeSanitizer.ts';

/**
 * Smooth isolated one-day investment-value spikes while preserving sustained
 * changes. Net worth is recomputed with the canonical liabilities-as-negative
 * convention when a point is corrected.
 */
export type NetWorthSnapshot = {
  date: string;
  liquid: number;
  liabilities: number;
  investments: number;
  netWorth: number;
};

export function sanitizeIsolatedDailyInvestmentSpikes(
  snapshots: NetWorthSnapshot[],
): NetWorthSnapshot[] {
  const sanitized = sanitizeIsolatedValueSpikes(snapshots, 'investments');
  if (sanitized === snapshots) return sanitized;

  // `sanitized` is a same-length copy of `snapshots`.
  for (const [i, point] of sanitized.entries()) {
    if (point.investments === snapshots[i]?.investments) continue;
    const liquid = Number(point.liquid) || 0;
    const liabilities = Number(point.liabilities) || 0;
    point.netWorth = roundMoney(liquid + liabilities + Number(point.investments));
  }

  return sanitized;
}
