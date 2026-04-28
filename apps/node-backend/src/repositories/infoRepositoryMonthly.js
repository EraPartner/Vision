/**
 * Info sub-repository — thin barrel composing three split modules:
 *   - infoRepo.monthly.js     → monthly financial summary
 *   - infoRepo.statistics.js  → rolling avg vs current
 *   - infoRepo.forecast.js    → cash-flow comparison + forecast series
 */

import { getMonthlyFinancialSummary } from './infoRepo.monthly.js';
import { getAverageVsCurrentSpending } from './infoRepo.statistics.js';
import {
  getCashflowComparison,
  getCashflowForecastData,
  getCashflowForecastDataByCategory,
  getCashflowForecastDataRolling,
} from './infoRepo.forecast.js';

export const monthlyRepository = {
  getMonthlyFinancialSummary,
  getAverageVsCurrentSpending,
  getCashflowComparison,
  getCashflowForecastData,
  getCashflowForecastDataByCategory,
  getCashflowForecastDataRolling,
};
