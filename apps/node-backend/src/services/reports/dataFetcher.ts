/**
 * Financial data fetcher for PDF report generation.
 *
 * Fetches all data sources in parallel using Promise.allSettled so a single
 * failing source does not abort the entire report. Each source returns null
 * on failure; section renderers handle null gracefully.
 */

import { computeMonthlySummary } from '../calculations/aggregation/monthly.ts';
import { computeCategoryBreakdown } from '../calculations/aggregation/category.ts';
import { computeRecipientInsights } from '../calculations/aggregation/recipient.ts';
import { computeBankBalances } from '../calculations/aggregation/bankBalances.ts';
import { computeAverageVsCurrent } from '../calculations/aggregation/averageVsCurrent.ts';
import infoRepository from '../../repositories/infoRepository.ts';
import { logger } from '../../config/logger.ts';
import { RowContractError } from '../../database/rowContracts.ts';
import { toAppTz } from '../../lib/timezone.ts';

export type Period = { kind: 'ytd' }
  | { kind: 'rolling'; months: number }
  | { kind: 'custom'; from: string; to: string }
  | { kind: 'year'; year: number };

/**
 * A row of the `months` array shared by `monthly`/`filteredMonthly` below —
 * `computeMonthlySummary`'s envelope `.data`
 * (calculations/aggregation/monthly.js, backed by
 * infoRepositoryMonthly.js `getMonthlyFinancialSummary`), one row per
 * calendar month.
 */
export type MonthRow = {
  month: number; year: number;
  period_start: string | null; period_end: string | null;
  total_spending: number; total_income: number;
  net_amount: number; transaction_count: number;
};

/**
 * The rolled-up totals across a `months` array
 * (infoRepositoryHelpers.js `buildMonthlySummary`).
 */
export type MonthlySummaryTotals = {
  total_spending: number; total_income: number; net_amount: number;
  transaction_count: number;
  period_start: string | null | undefined; period_end: string | null | undefined;
};

export type MonthlyData = { months: MonthRow[]; summary: MonthlySummaryTotals };

/**
 * `computeCategoryBreakdown`'s envelope `.data`
 * (infoRepositoryStatistics.js `getCategoryBreakdown`).
 */
export type CategoryRow = { id: number | null; name: string; count: number; total: number };
export type CategoryData = { categories: CategoryRow[] };

/**
 * `computeRecipientInsights`'s envelope `.data`
 * (infoRepositoryRecipients.js `getRecipientInsights`).
 */
export type TopMerchantRow = {
  recipientId: number; name: string;
  totalSpend: number; transactionCount: number;
  firstSeen: string | null; lastSeen: string | null; avgAmount: number;
};
export type MonthOverMonthRow = {
  recipientId: number; name: string;
  currentSpend: number; previousSpend: number; changePercent: number;
};
export type RecipientData = { topMerchants: TopMerchantRow[]; monthOverMonth: MonthOverMonthRow[] };

/**
 * `computeBankBalances`'s envelope `.data`
 * (infoRepositoryBanks.js `getBankBalances`).
 */
export type BankAccountRow = {
  bank_account: string; display_name: string; balance: number;
  drift?: number; anchor_date?: string; post_anchor_count?: number;
  transaction_count: number;
  first_transaction: string | null; last_transaction: string | null;
};
export type BanksData = {
  accounts: BankAccountRow[];
  total_net_position: number;
  history: Record<string, Array<{ date: string; balance: number }>>;
  total_history: Array<{ date: string; balance: number }>;
};

/**
 * `computeAverageVsCurrent`'s envelope `.data`
 * (infoRepositoryAverageVsCurrent.js `getAverageVsCurrentSpending`).
 */
export type AveragesData = {
  past_6_months: { avg_daily_spending: number; avg_monthly_spending: number; months_counted: number };
  current_month: { daily_data: Array<{ date: string; spending: number; income: number }>; total_spending: number; days_elapsed: number; days_in_month: number };
  comparison: { projected_monthly_total: number; avg_monthly_spending: number; variance: number; pace: number|null };
};

/**
 * `infoRepository.getPlannedExpensesNextMonth`'s raw return shape — this
 * source carries no aggregation envelope (see the `planned:` comment in
 * `fetchFinancialData`'s return below).
 */
export type PlannedTxnRow = {
  id: number; recipient_name: string | null; amount: number;
  category_name: string | null; is_recurring: boolean; recurrence_pattern: string | null;
};
export type PlannedDayBucket = {
  date: string; total_income: number; total_expenses: number; transactions: PlannedTxnRow[];
};
export type PlannedData = {
  month: number; year: number; period_start: string; period_end: string;
  daily_data: PlannedDayBucket[];
  summary: { total_income: number; total_expenses: number; net_amount: number; transaction_count: number };
};

/**
 * Full result of {@link fetchFinancialData} — the data payload financial
 * report section renderers consume.
 */
export type FinancialReportData = {
  monthly: MonthlyData | null;
  filteredMonthly: MonthlyData | null;
  categories: CategoryData | null;
  recipients: RecipientData | null;
  banks: BanksData | null;
  averages: AveragesData | null;
  planned: PlannedData | null;
  exclusions: { categoryIds: number[]; recipientIds: number[] };
};

/**
 * Unwrap a settled Promise result; log and return null on rejection. A row
 * contract mismatch is rethrown instead: the report must not silently render
 * an empty section over data the code no longer understands (ADR-193).
 */
function unwrap<T>(result: PromiseSettledResult<T>, label: string): T | null {
  if (result.status === 'fulfilled') return result.value;
  if (result.reason instanceof RowContractError) throw result.reason;
  logger.warn(`[dataFetcher] ${label} failed — section will be skipped`, { reason: result.reason?.message });
  return null;
}

/**
 * Maps each financial report section to the data source(s) it renders from.
 * Used to skip fetching sources whose sections were not requested, instead of
 * always aggregating all seven. Keep in sync with the section renderers'
 * `data.<source>` reads.
 */
const FINANCIAL_SECTION_SOURCES: Record<string, string[]> = {
  executiveSummary: ['monthly', 'filteredMonthly'],
  cashflowTrend: ['monthly'],
  categoryBreakdown: ['categories'],
  topRecipients: ['recipients'],
  bankBalances: ['banks'],
  rollingAverages: ['averages'],
  plannedOutlook: ['planned'],
};

/** Options for {@link fetchFinancialData}. */
export interface FinancialDataOptions {
  excludedCategoryIds?: number[];
  excludedRecipientIds?: number[];
  /**
   * When provided, limits fetching to the sources those sections render from;
   * unrequested sources resolve to null (renderers handle null). Omit / pass
   * null to fetch every source (default behaviour).
   */
  sections?: string[] | null;
}

/**
 * Fetch all data required for a financial PDF report in parallel.
 *
 * @param currency  Target currency (e.g. "EUR")
 */
export async function fetchFinancialData(
  currency: string,
  { excludedCategoryIds = [], excludedRecipientIds = [], sections = null }: FinancialDataOptions = {},
): Promise<FinancialReportData> {
  const hasExclusions = excludedCategoryIds.length > 0 || excludedRecipientIds.length > 0;

  // Null sections → fetch everything (unchanged default). Otherwise only fetch
  // the sources the requested sections actually render from.
  const neededSources = sections
    ? new Set(sections.flatMap((id) => FINANCIAL_SECTION_SOURCES[id] ?? []))
    : null;
  const want = (source: string) => !neededSources || neededSources.has(source);

  const [monthly, filteredMonthly, categories, recipients, banks, averages, planned] = await Promise.allSettled([
    want('monthly')
      ? computeMonthlySummary({ targetCurrency: currency, allTime: true })
      : Promise.resolve(null),
    hasExclusions && want('filteredMonthly')
      ? computeMonthlySummary({ targetCurrency: currency, allTime: true, excludedCategoryIds, excludedRecipientIds })
      : Promise.resolve(null),
    want('categories') ? computeCategoryBreakdown({ targetCurrency: currency }) : Promise.resolve(null),
    want('recipients') ? computeRecipientInsights({ targetCurrency: currency }) : Promise.resolve(null),
    want('banks') ? computeBankBalances({ targetCurrency: currency }) : Promise.resolve(null),
    want('averages') ? computeAverageVsCurrent({ targetCurrency: currency }) : Promise.resolve(null),
    want('planned') ? infoRepository.getPlannedExpensesNextMonth(currency) : Promise.resolve(null),
  ]);

  return {
    // Aggregation wrappers return { data, meta } — unwrap .data
    monthly: unwrap(monthly, 'computeMonthlySummary')?.data ?? null,
    filteredMonthly: hasExclusions ? (unwrap(filteredMonthly, 'computeMonthlySummary(filtered)')?.data ?? null) : null,
    categories: unwrap(categories, 'computeCategoryBreakdown')?.data ?? null,
    recipients: unwrap(recipients, 'computeRecipientInsights')?.data ?? null,
    banks: unwrap(banks, 'computeBankBalances')?.data ?? null,
    averages: unwrap(averages, 'computeAverageVsCurrent')?.data ?? null,
    // plannedRepository returns raw data (no envelope). Its declared day type
    // still admits the Decimal accumulators it collapses to numbers in place
    // before returning, so narrow to the post-collapse shape here.
    planned: unwrap(planned, 'getPlannedExpensesNextMonth') as PlannedData | null,
    exclusions: { categoryIds: excludedCategoryIds, recipientIds: excludedRecipientIds },
  };
}

/**
 * Filter a months array to the rows that fall within a given period.
 * Each month entry must have `year` (number) and `month` (1-based number) fields.
 */
export function filterMonthsByPeriod<M extends Pick<MonthRow, 'year' | 'month'>>(
  months: M[] | null | undefined,
  period: Period,
): M[] {
  if (!months?.length) return [];
  // Resolve "today" in APP_TIMEZONE, not the server process's local time
  // (ADR-009) — the two can disagree near midnight and shift YTD/rolling
  // month boundaries by one month.
  const { year: nowYear, month: nowMonth } = toAppTz(new Date());

  switch (period.kind) {
    case 'ytd':
      return months.filter(m => m.year === nowYear);

    case 'rolling': {
      const cutoff = new Date(Date.UTC(nowYear, nowMonth - period.months, 1));
      return months.filter(m => new Date(Date.UTC(m.year, m.month - 1, 1)) >= cutoff);
    }

    case 'custom': {
      // Compare on YYYY-MM keys. Parsing the ISO bounds with `new Date()`
      // yields UTC midnight while `new Date(m.year, m.month-1, 1)` is local
      // midnight — at a month boundary the two could disagree by a day and
      // drop or add an edge month.
      const fromYm = String(period.from).slice(0, 7);
      const toYm = String(period.to).slice(0, 7);
      return months.filter(m => {
        const mYm = `${m.year}-${String(m.month).padStart(2, '0')}`;
        return mYm >= fromYm && mYm <= toYm;
      });
    }

    case 'year':
      return months.filter(m => m.year === period.year);

    default:
      return months;
  }
}
