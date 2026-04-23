/**
 * Info/Statistics Repository — barrel module.
 *
 * Assembles domain sub-repositories into a single object so existing consumers
 * (both default-import and named-import) continue to work unchanged.
 *
 * Sub-modules:
 *   infoRepositoryHelpers.js    — shared utilities (not re-exported here)
 *   infoRepositoryStatistics.js — getStatistics, getCategoryBreakdown, getBanks,
 *                                  getTransactionCount, getTransactionSummary
 *   infoRepositoryMonthly.js    — getMonthlyFinancialSummary, getAverageVsCurrentSpending,
 *                                  getCashflowComparison
 *   infoRepositoryBanks.js      — getBankBalances
 *   infoRepositoryNetWorth.js   — getNetWorthFromSnapshots
 *   infoRepositoryPlanned.js    — getPlannedExpensesNextMonth
 *   infoRepositoryRecipients.js — getRecipientInsights
 */

export { clearMvCache } from './infoRepositoryHelpers.js';

import { statisticsRepository } from './infoRepositoryStatistics.js';
import { monthlyRepository } from './infoRepositoryMonthly.js';
import { banksRepository } from './infoRepositoryBanks.js';
import { netWorthRepository } from './infoRepositoryNetWorth.js';
import { plannedRepository } from './infoRepositoryPlanned.js';
import { recipientInsightsRepository } from './infoRepositoryRecipients.js';

export const infoRepository = {
  ...statisticsRepository,
  ...monthlyRepository,
  ...banksRepository,
  ...netWorthRepository,
  ...plannedRepository,
  ...recipientInsightsRepository,
};

export default infoRepository;
