/**
 * Info/Statistics Repository — barrel module.
 *
 * Assembles domain sub-repositories into a single object so existing consumers
 * (both default-import and named-import) continue to work unchanged.
 *
 * Sub-modules:
 *   infoRepositoryHelpers.js          — shared utilities (only clearMvCache re-exported here)
 *   infoRepositoryStatistics.js       — getStatistics, getCategoryBreakdown, getBanks,
 *                                        getTransactionCount, getTransactionSummary
 *   infoRepositoryMonthly.js          — getMonthlyFinancialSummary
 *   infoRepositoryAverageVsCurrent.js — getAverageVsCurrentSpending
 *   infoRepositoryForecast.js         — getCashflowComparison + forecast series
 *   infoRepositoryBanks.js            — getBankBalances
 *   infoRepositoryNetWorth.js         — getNetWorthFromSnapshots
 *   infoRepositoryPlanned.js          — getPlannedExpensesNextMonth
 *   infoRepositoryRecipients.js       — getRecipientInsights
 */

export { clearMvCache } from './infoRepositoryHelpers.js';

import { statisticsRepository } from './infoRepositoryStatistics.js';
import { getMonthlyFinancialSummary } from './infoRepositoryMonthly.js';
import { getAverageVsCurrentSpending } from './infoRepositoryAverageVsCurrent.js';
import {
  getCashflowComparison,
  getCashflowForecastData,
  getCashflowForecastDataByCategory,
  getCashflowForecastDataRolling,
} from './infoRepositoryForecast.js';
import { banksRepository } from './infoRepositoryBanks.js';
import { netWorthRepository } from './infoRepositoryNetWorth.js';
import { plannedRepository } from './infoRepositoryPlanned.js';
import { recipientInsightsRepository } from './infoRepositoryRecipients.js';

export const infoRepository = {
  ...statisticsRepository,
  getMonthlyFinancialSummary,
  getAverageVsCurrentSpending,
  getCashflowComparison,
  getCashflowForecastData,
  getCashflowForecastDataByCategory,
  getCashflowForecastDataRolling,
  ...banksRepository,
  ...netWorthRepository,
  ...plannedRepository,
  ...recipientInsightsRepository,
};

export default infoRepository;
