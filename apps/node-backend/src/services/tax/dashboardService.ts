import {
  computeHouseholdTax,
  toBelgianTaxCalculation,
} from "@vision/shared-utils/belgian-tax/household";
import {
  applyProfileV1PatchToHousehold,
  projectHouseholdToProfileV1,
} from "@vision/shared-utils/belgian-tax/householdMigration";
import { filesJointly } from "@vision/shared-utils/belgian-tax/assessment";
import { isApproximatedTaxYear } from "@vision/shared-utils/belgian-tax/constants";
import {
  attributeToPartners,
  householdForRecordedIncome,
  householdHasPartnerB,
  type OwnerAmounts,
} from "@vision/shared-utils/belgian-tax/recordedIncomeAttribution";
import {
  leaveOutUnconverted,
  recordedTaxesForYear,
  type MaybeConvertFn,
  type PortfolioTaxInvestment,
  type UnconvertedFigures,
} from "@vision/shared-utils/belgian-tax/portfolioTax";
import type { BelgianTaxCalculation } from "@vision/shared-utils/belgian-tax/types";
import type {
  HouseholdTaxResult,
  PartnerTaxResult,
} from "@vision/shared-utils/belgian-tax/householdTypes";
import { computeMonthlySummary } from "../calculations/aggregation/monthly.ts";
import { computeCategoryPivot } from "../calculations/aggregation/categoryPivot.ts";
import {
  convertCodeAtLatestRates,
  loadLatestRatesToEur,
} from "../currency/latestRateConversion.ts";
import { portfolioTransactionRepository } from "../../repositories/portfolioTransactionRepository.ts";
import { firstOfMonthYmd, todayAppDateString } from "../../lib/timezone.ts";
import { toYmd } from "../../lib/dateFormat.ts";
import { getTaxOverview } from "./overviewService.ts";
import { buildDashboardSuggestions } from "./dashboardSuggestions.ts";
import { restateAtTransactionDateRates } from "./transactionDateFx.ts";

type Overview = Awaited<ReturnType<typeof getTaxOverview>>;
type Monthly = { year: number; month: number; total_income: number };
/** Rows the monthly summary left out for want of a stored rate. */
type MonthlyUnconverted = {
  unconverted_count: number;
  unconverted_currencies: string[];
};
type Pivot = Awaited<ReturnType<typeof computeCategoryPivot>>["data"];
export interface TaxDashboardOptions {
  year?: number | undefined;
  targetCurrency?: string | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  excludedCategoryIds?: number[] | undefined;
  excludedRecipientIds?: number[] | undefined;
}
function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export const TAX_DASHBOARD_RULES = [
  {
    titleKey: "tax.rules.federalBracketsTitle",
    itemKeys: [1, 2, 3, 4].map((n) => `tax.rules.federalBrackets.${n}`),
  },
  {
    titleKey: "tax.rules.socialSecurityTitle",
    itemKeys: ["employee", "special", "employer", "selfEmployed"].map(
      (n) => `tax.rules.ss.${n}`,
    ),
  },
  {
    titleKey: "tax.rules.investmentTitle",
    itemKeys: ["savings", "dividends", "foreign"].map(
      (n) => `tax.rules.investment.${n}`,
    ),
  },
  {
    titleKey: "tax.rules.otherTaxesTitle",
    itemKeys: ["vat", "tob", "property"].map((n) => `tax.rules.other.${n}`),
  },
];

/** Same chart and recorded-income derivation as useTaxOverviewData. */
export function buildTaxDashboard(
  overview: Overview,
  months: Monthly[],
  pivot: Pivot,
  investments: PortfolioTaxInvestment[],
  convert: MaybeConvertFn,
  currency: string,
  monthlyUnconverted: MonthlyUnconverted = {
    unconverted_count: 0,
    unconverted_currencies: [],
  },
) {
  // Amounts without an exchange rate are left out of the figures they feed,
  // which are listed in `incompleteFigures` (never converted 1:1).
  const missing: UnconvertedFigures = {
    currencies: new Set(),
    figures: new Set(),
  };
  const profile = projectHouseholdToProfileV1(overview.household, filesJointly);
  const selected = new Set(profile.taxIncomeCategoryIds ?? []);
  const liveSelected = new Set(
    projectHouseholdToProfileV1(overview.liveHousehold, filesJointly).taxIncomeCategoryIds ??
      [],
  );
  const hasIncomeSources = selected.size > 0;
  const incomeByMonth = new Map<string, number>();
  const ownersByMonth = new Map<string, OwnerAmounts>();
  const transactionYears = new Set<number>();
  for (const [period, cells] of Object.entries(pivot.categoryPivot)) {
    for (const cell of cells) {
      const path = cell.categoryPathIds?.length > 0
        ? cell.categoryPathIds
        : cell.categoryId != null
          ? [cell.categoryId]
          : [];
      if (cell.income > 0 && path.some((id) => liveSelected.has(id)))
        transactionYears.add(Number(period.slice(0, 4)));
      if (!path.some((id) => selected.has(id))) continue;
      incomeByMonth.set(period, (incomeByMonth.get(period) ?? 0) + cell.income);
      const owners = ownersByMonth.get(period) ?? {};
      for (const key of ["partner", "joint"] as const) {
        const ownerIncome = cell.incomeByOwner?.[key];
        if (ownerIncome !== undefined && ownerIncome !== 0)
          owners[key] = (owners[key] ?? 0) + ownerIncome;
      }
      ownersByMonth.set(period, owners);
    }
  }
  const ownersFor = (periods: string[]) => {
    const result: OwnerAmounts = {};
    for (const period of periods)
      for (const key of ["partner", "joint"] as const)
        result[key] =
          (result[key] ?? 0) + (ownersByMonth.get(period)?.[key] ?? 0);
    return result;
  };
  const householdForYear = (year: number) =>
    year === overview.liveYear
      ? overview.liveHousehold
      : (overview.householdSnapshots[year] ?? {
          ...overview.liveHousehold,
          taxYear: year,
        });
  const metadataFor = (year: number) => object(overview.snapshotMetas[year]);
  const pitForGross = (gross: number, year: number, owners?: OwnerAmounts) => {
    if (gross <= 0) return 0;
    const frozen = object(metadataFor(year).frozenCalculation);
    if (typeof frozen.grossIncome === "number" && frozen.grossIncome > 0)
      return Number(frozen.totalPIT) * (gross / frozen.grossIncome);
    const household = householdForYear(year);
    const attributed = householdForRecordedIncome(household, gross, owners);
    const next = attributed
      ? { ...attributed, taxYear: year }
      : applyProfileV1PatchToHousehold(household, { grossAnnualIncome: gross }, filesJointly);
    return toBelgianTaxCalculation(computeHouseholdTax(next), next).totalPIT;
  };
  const monthly = months
    .map((m) => ({
      period: `${m.year}-${String(m.month).padStart(2, "0")}`,
      income: m.total_income,
    }))
    .sort((a, b) => a.period.localeCompare(b.period));
  const yearIncome = new Map<number, number>();
  for (const month of monthly) {
    const year = Number(month.period.slice(0, 4));
    yearIncome.set(
      year,
      (yearIncome.get(year) ?? 0) +
        (hasIncomeSources
          ? (incomeByMonth.get(month.period) ?? 0)
          : month.income),
    );
  }
  const yearlyIncome = [...yearIncome]
    .sort(([a], [b]) => a - b)
    .filter(([, income]) => income > 0)
    .map(([year, income]) => {
      const estimatedTax = pitForGross(
        income,
        year,
        hasIncomeSources
          ? ownersFor(
              [...ownersByMonth.keys()].filter((p) => p.startsWith(`${year}-`)),
            )
          : undefined,
      );
      return {
        year: String(year),
        income,
        estimatedTax,
        netAfterTax: Math.max(income - estimatedTax, 0),
        isApproximated: isApproximatedTaxYear(year),
      };
    });
  const filtered = monthly
    .filter((m) =>
      hasIncomeSources ? incomeByMonth.has(m.period) : m.income > 0,
    )
    .filter(
      (m) => !overview.isHistorical || m.period.startsWith(`${overview.year}-`),
    );
  const series = (overview.isHistorical ? filtered : filtered.slice(-12))
    .map((m) => ({
      period: m.period,
      income: hasIncomeSources ? (incomeByMonth.get(m.period) ?? 0) : m.income,
    }))
    .filter((m) => m.income > 0);
  // Web chart proration preserves its original number accumulation order.
  // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
  const gross = series.reduce((sum, m) => sum + m.income, 0);
  const referenceYear = overview.isHistorical
    ? overview.year
    : Number(series.at(-1)?.period.slice(0, 4));
  const annualPIT =
    gross > 0
      ? pitForGross(
          gross,
          referenceYear,
          hasIncomeSources ? ownersFor(series.map((m) => m.period)) : undefined,
        )
      : 0;
  const monthlyIncomeTax = series.map((m) => ({
    ...m,
    estimatedTax: annualPIT * (m.income / gross),
  }));
  let portfolioTaxesForYear = 0;
  for (const inv of investments) {
    portfolioTaxesForYear += recordedTaxesForYear(
      inv,
      overview.year,
      leaveOutUnconverted(
        convert,
        missing,
        "portfolioTaxesForYear",
        "totalTaxIncludingPortfolio",
        "totalTaxIncludingPropertyEstimate",
      ),
    );
    for (const txn of inv.transactions)
      if (
        Number(txn.taxes) > 0 ||
        Number(txn.fees) > 0 ||
        txn.type === "tax" ||
        txn.type === "fee"
      ) {
        const year = Number(txn.date?.slice(0, 4));
        if (Number.isFinite(year)) transactionYears.add(year);
      }
  }
  const viewedIncome = [...incomeByMonth]
    .filter(([period]) => period.startsWith(`${overview.year}-`))
    // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
    .reduce((sum, [, amount]) => sum + amount, 0);
  const recordedIncomeByPartner =
    hasIncomeSources && householdHasPartnerB(overview.household)
      ? attributeToPartners(
          viewedIncome,
          ownersFor(
            [...ownersByMonth.keys()].filter((p) =>
              p.startsWith(`${overview.year}-`),
            ),
          ),
          true,
        )
      : null;
  const years = new Set([
    overview.liveYear,
    ...Object.keys(overview.householdSnapshots).map(Number),
    ...Object.keys(overview.snapshotMetas).map(Number),
    ...transactionYears,
  ]);
  const yearCalculations = [...years]
    .filter(Number.isFinite)
    .sort((a, b) => b - a)
    .map((year) => {
      const meta = metadataFor(year);
      const household = householdForYear(year);
      const calculation =
        meta.frozenCalculation ??
        toBelgianTaxCalculation(computeHouseholdTax(household), household);
      return {
        year,
        calculation,
        isFiled: !!meta.filing,
        hasFrozenCalculation: !!meta.frozenCalculation,
        isCurrent: year === overview.liveYear,
        hasSnapshot: Object.hasOwn(overview.householdSnapshots, year),
        hasTransactions: transactionYears.has(year),
      };
    });
  const calculation = overview.calculation as Partial<BelgianTaxCalculation>;
  const totalTaxIncludingPortfolio =
    (calculation.totalPIT ?? 0) + portfolioTaxesForYear;
  const totalTaxIncludingPropertyEstimate =
    calculation.propertyTaxEstimate == null
      ? null
      : totalTaxIncludingPortfolio + calculation.propertyTaxEstimate;
  const result = overview.result as HouseholdTaxResult;
  const row = (
    key: string,
    tone: string,
    pick: (partner: PartnerTaxResult) => number,
  ) => ({
    key,
    tone,
    partnerAmounts: Object.fromEntries(
      result.partners.map((p) => [p.partnerId, pick(p)]),
    ),
    // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
    household: result.partners.reduce((sum, p) => sum + pick(p), 0),
  });
  const pensionPart = (p: PartnerTaxResult) =>
    Math.min(p.pensionReduction, p.reductionsApplied);
  const householdBreakdownRows =
    (metadataFor(overview.year).frozenCalculation &&
      !metadataFor(overview.year).frozenHouseholdResult) ||
    result.partners.length < 2
      ? []
      : [
          row("taxableIncome", "base", (p) => p.taxableIncome),
          row("taxFreeSum", "base", (p) => p.exemption.applied),
          row("pitAfterExemption", "base", (p) => p.pitAfterExemption),
          ...(result.partners.some((p) => p.pensionReduction > 0)
            ? [row("pensionReduction", "reduction", pensionPart)]
            : []),
          row(
            "reductions",
            "reduction",
            (p) => p.reductionsApplied - pensionPart(p),
          ),
          row(
            "regionalAndCommunal",
            "adjustment",
            (p) => p.totalPIT - (p.pitAfterExemption - p.reductionsApplied),
          ),
          row("finalTax", "total", (p) => p.totalPIT),
        ];
  const hasStatsData = monthly.some((m) => m.income > 0);
  const liveProfile = projectHouseholdToProfileV1(overview.liveHousehold, filesJointly);
  const liveCalculation = toBelgianTaxCalculation(
    computeHouseholdTax(overview.liveHousehold),
    overview.liveHousehold,
  );
  // Recorded income comes from the category pivot when income categories are
  // selected, else from the monthly summary; transactions either left out
  // make the income figures and the taxes estimated from them incomplete.
  const incomeSource = hasIncomeSources
    ? {
        unconverted_count: pivot.unconverted_count,
        unconverted_currencies: pivot.unconverted_currencies,
      }
    : monthlyUnconverted;
  if (incomeSource.unconverted_count > 0) {
    for (const code of incomeSource.unconverted_currencies)
      missing.currencies.add(code);
    for (const figure of [
      "yearlyIncome",
      "monthlyIncomeTax",
      ...(recordedIncomeByPartner ? ["recordedIncomeByPartner"] : []),
    ])
      missing.figures.add(figure);
  }
  return {
    year: overview.year,
    currency,
    isHistorical: overview.isHistorical,
    hasIncomeSources,
    hasStatsData,
    isEmpty: !overview.hasProfile && !hasStatsData,
    portfolioTaxesForYear,
    totalTaxIncludingPortfolio,
    totalTaxIncludingPropertyEstimate,
    yearlyIncome,
    monthlyIncomeTax,
    recordedIncomeByPartner,
    yearCalculations,
    currentInputs: profile,
    exportProfile: profile,
    suggestions: buildDashboardSuggestions(
      liveProfile,
      liveCalculation.marginalRate,
    ),
    householdBreakdownRows,
    rules: TAX_DASHBOARD_RULES,
    unconvertedCurrencies: [...missing.currencies].sort(),
    incompleteFigures: [...missing.figures].sort(),
  };
}

export async function getTaxDashboard(options: TaxDashboardOptions = {}) {
  const currency = options.targetCurrency ?? "EUR";
  const today = todayAppDateString();
  const query = {
    ...options,
    targetCurrency: currency,
    startDate: options.startDate ?? firstOfMonthYmd(today, -23),
    endDate: options.endDate ?? today,
  };
  const [overview, monthly, pivot, transactions, latest] = await Promise.all([
    getTaxOverview(options.year),
    computeMonthlySummary(query),
    computeCategoryPivot(query),
    portfolioTransactionRepository.getRowsForPortfolioMath({
      activeInvestmentsOnly: false,
    }),
    loadLatestRatesToEur(),
  ]);
  // Recorded portfolio taxes convert at the rate of their transaction's date
  // (ADR-085, ADR-240); a row without a dated rate falls back to the latest
  // stored rate below. A currency without any stored rate converts to
  // undefined and is flagged.
  const convert = (amount: number, fromCurrency?: string) => {
    const from = (fromCurrency ?? "EUR").toUpperCase();
    const to = currency.toUpperCase();
    if (from === to) return amount;
    const converted = convertCodeAtLatestRates(amount, from, to, latest);
    return converted === undefined ? undefined : converted.toNumber();
  };
  const investment: PortfolioTaxInvestment = {
    id: 0,
    assetClass: "recorded",
    transactions: await restateAtTransactionDateRates(
      transactions.map((t) => ({
        type: t.type,
        date: toYmd(t.date),
        amount: Number(t.amount),
        taxes: Number(t.taxes),
        fees: Number(t.fees),
        currency: t.currency ?? "EUR",
        fx_rate_to_eur: t.fx_rate_to_eur,
      })),
      currency,
    ),
  };
  return buildTaxDashboard(
    overview,
    monthly.data.months,
    pivot.data,
    [investment],
    convert,
    currency,
    monthly.data,
  );
}
