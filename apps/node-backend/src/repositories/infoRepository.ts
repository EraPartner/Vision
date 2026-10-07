/**
 * Info/Statistics Repository — barrel module.
 *
 * Assembles domain sub-repositories into a single object so existing consumers
 * (both default-import and named-import) continue to work unchanged.
 *
 * Sub-modules:
 *   infoRepositoryHelpers.js          — shared utilities (only clearMvCache re-exported here)
 *   infoRepositoryStatistics.js       — getCategoryBreakdown, getBanks,
 *                                        getTransactionCount, getCategoryPivot
 *   infoRepositoryMonthly.js          — getMonthlyFinancialSummary
 *   infoRepositoryAverageVsCurrent.js — getAverageVsCurrentSpending
 *   infoRepositoryForecast.js         — getCashflowComparison + forecast series
 *   infoRepositoryBanks.js            — getBankBalances
 *   infoRepositoryNetWorth.js         — getNetWorthFromSnapshots
 *   infoRepositoryPlanned.js          — getPlannedExpensesNextMonth
 *   infoRepositoryRecipients.js       — getRecipientInsights (getRecipientPivot is
 *                                        imported directly by the aggregation layer,
 *                                        see below)
 *
 * infoRepositoryTags.js (getTagPivot) is deliberately NOT assembled here. Like
 * getRecipientPivot, it is a pivot-style method consumed only by the calc/
 * aggregation layer (services/calculations/aggregation/tagPivot.js), which
 * imports tagInsightsRepository directly rather than going through this
 * facade — mirroring how recipientPivot.js bypasses the facade for
 * getRecipientPivot. Nothing else needs getTagPivot, so there is no barrel
 * entry to add.
 */

export { clearMvCache } from "./infoRepositoryHelpers.ts";

import { getIncludeTransfers } from "./infoRepositoryHelpers.ts";
import { statisticsRepository } from "./infoRepositoryStatistics.ts";
import { getMonthlyFinancialSummary } from "./infoRepositoryMonthly.ts";
import { getAverageVsCurrentSpending } from "./infoRepositoryAverageVsCurrent.ts";
import {
  getCashflowComparison,
  getCashflowForecastData,
  getCashflowForecastDataByCategory,
  getCashflowForecastDataRolling,
} from "./infoRepositoryForecast.ts";
import { banksRepository } from "./infoRepositoryBanks.ts";
import { netWorthRepository } from "./infoRepositoryNetWorth.ts";
import { plannedRepository } from "./infoRepositoryPlanned.ts";
import { recipientInsightsRepository } from "./infoRepositoryRecipients.ts";

export const infoRepository = {
  ...statisticsRepository,
  // ADR-083 toggle read. Exposed on the facade because the forecast cache key
  // (services/calculations/forecast/index.js) needs it before it decides
  // whether to call any of the repositories below.
  getIncludeTransfers,
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
