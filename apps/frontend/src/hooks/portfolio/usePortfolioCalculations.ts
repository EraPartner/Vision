/**
 * Pure portfolio calculations — thin wrappers over @vision/shared-utils/portfolio.
 *
 * Cost-basis implementations come from the same shared package used by backend
 * portfolio services, so the two sides can no longer drift. Only "today"
 * differs for accrued interest: the browser's local calendar day here and the
 * APP_TIMEZONE day on the server.
 */

import type { PortfolioTransaction } from '@/types/api';
import { todayYmd } from '@/lib/timezone';
import {
  calculateAccruedInterest as sharedCalculateAccruedInterest,
  projectedAnnualInterest as sharedProjectedAnnualInterest,
} from '@vision/shared-utils/portfolio';

export {
  calculateCostBasis,
  calculateCostBasisFIFO,
  calculateCostBasisLIFO,
  calculateCostBasisByMethod,
} from '@vision/shared-utils/portfolio';
export type { CostBasisResult, CostBasisMethod } from '@vision/shared-utils/portfolio';

/**
 * Accrued simple interest since last interest payment (or first buy),
 * evaluated against the browser's local calendar day.
 */
export function calculateAccruedInterest(
  txns: PortfolioTransaction[],
  principal: number,
  interestRate: number
): number {
  return sharedCalculateAccruedInterest(txns, principal, interestRate, todayYmd());
}

/**
 * Projected annual interest: P * r.
 */
export function calculateProjectedAnnualInterest(
  principal: number,
  interestRate: number
): number {
  return sharedProjectedAnnualInterest(principal, interestRate);
}
