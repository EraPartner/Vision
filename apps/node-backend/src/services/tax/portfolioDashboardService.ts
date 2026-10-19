import {
  buildPortfolioTaxDashboard,
  type PortfolioDashboardInvestment,
} from "@vision/shared-utils/belgian-tax/portfolioDashboard";
import { projectHouseholdToProfileV1 } from "@vision/shared-utils/belgian-tax/householdMigration";
import { filesJointly } from "@vision/shared-utils/belgian-tax/assessment";
import { investmentRepository } from "../../repositories/investmentRepository.ts";
import { portfolioTransactionRepository } from "../../repositories/portfolioTransactionRepository.ts";
import { getPortfolioSummary } from "../portfolio/portfolioSummaryService.ts";
import {
  convertAtLatestRates,
  loadLatestRatesToEur,
} from "../currency/latestRateConversion.ts";
import settingsService from "../settingsService.ts";
import { getTaxOverview } from "./overviewService.ts";

export async function getPortfolioTaxDashboard(
  year?: number,
  currency = "EUR",
) {
  const target = currency.toUpperCase();
  const [overview, holdings, metadata, rates, { settings, expected }] =
    await Promise.all([
      getTaxOverview(year),
      // Archived holdings use the same dated-FX canonical summaries as the
      // web portfolio (ADR-216), not the current-rate archive presentation.
      getPortfolioSummary(target, { activeInvestmentsOnly: false }),
      investmentRepository.getAllWithCount({
        limit: 500,
        offset: 0,
        active: false,
      }),
      loadLatestRatesToEur(),
      settingsService.getAllWithBaselines(),
    ]);
  // Match useInvestmentsQuery's first 500 metadata rows, then attach newest 1000 ordinary
  // transactions per investment (not custody/adjustment rows or stripped math projections).
  const transactions =
    await portfolioTransactionRepository.getAllByInvestmentIds({
      investmentIds: metadata.rows.map((inv) => inv.id),
      perInvestmentLimit: 1000,
    });
  const canonical = new Map(holdings.summaries.map((inv) => [inv.id, inv]));
  const byInvestment = new Map<number, typeof transactions>();
  for (const txn of transactions) {
    const bucket = byInvestment.get(txn.investment_id) ?? [];
    bucket.push(txn);
    byInvestment.set(txn.investment_id, bucket);
  }
  const summaries = metadata.rows.flatMap((inv) => {
    const summary = canonical.get(inv.id);
    if (!summary)
      throw new Error("Portfolio tax summary missing for listed investment");
    return [
      {
        ...summary,
        assetClass: inv.asset_class,
        transactions: (byInvestment.get(inv.id) ?? []).map((txn) => ({
          ...txn,
          taxes: txn.taxes ?? 0,
          fees: txn.fees ?? 0,
        })),
      },
    ];
  }) satisfies PortfolioDashboardInvestment[];
  // Latest stored rates only (ADR-216). A currency without one converts to
  // undefined: the dashboard leaves that amount out and flags the figures it
  // feeds (`unconvertedCurrencies`, `incompleteFigures`).
  const convert = (amount: number, source?: string) => {
    const from = (source ?? "EUR").toUpperCase();
    if (from === target) return amount;
    const converted = convertAtLatestRates(amount, from, target, rates);
    return converted === undefined ? undefined : converted.toNumber();
  };
  const calculation = overview.calculation as { totalPIT?: unknown };
  if (
    typeof calculation?.totalPIT !== "number" ||
    !Number.isFinite(calculation.totalPIT)
  )
    throw new Error("Portfolio tax overview has no valid PIT calculation");
  const profile = projectHouseholdToProfileV1(overview.household, filesJointly);
  const live = projectHouseholdToProfileV1(overview.liveHousehold, filesJointly);
  return {
    ...buildPortfolioTaxDashboard({
      summaries,
      year: overview.year,
      currency: target,
      totalPIT: calculation.totalPIT,
      filingStatus: profile.filingStatus ?? "single",
      hasProfile: live.profileConfigured || live.grossAnnualIncome > 0,
      convert,
      adjustments: settings.portfolio_tax_adjustments_v1,
      classifications: settings.portfolio_tax_classifications_v1,
    }),
    records: [
      "portfolio_tax_adjustments_v1",
      "portfolio_tax_classifications_v1",
    ].map((key) => ({
      key,
      value: settings[key] ?? null,
      expected: expected[key] ?? { exists: false },
    })),
  };
}
