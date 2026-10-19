import { z } from "zod";

import { WireCurrencySchema } from "./common.ts";
import { SettingRecordSchema } from "./settings.ts";

/**
 * Additive (ADR-216): currencies of amounts left out for want of a stored
 * exchange rate, and the response fields that miss them. A tax figure listed
 * in `incompleteFigures` is incomplete, never computed at a guessed rate.
 */
const UnconvertedFiguresShape = {
  unconvertedCurrencies: z.array(z.string()),
  incompleteFigures: z.array(z.string()),
};

// ── /api/belgian-tax/dashboard ───────────────────────────────────────────────

const HistoricalCalculationSchema = z.looseObject({
  grossIncome: z.number().optional(),
  totalPIT: z.number().optional(),
  effectiveRate: z.number().optional(),
  netTakeHome: z.number().optional(),
});

/** `GET /api/belgian-tax/dashboard` — services/tax/dashboardService.getTaxDashboard. */
export const BelgianTaxDashboardSchema = z.looseObject({
  year: z.number().int(),
  currency: WireCurrencySchema,
  isHistorical: z.boolean(),
  hasIncomeSources: z.boolean(),
  hasStatsData: z.boolean(),
  isEmpty: z.boolean(),
  portfolioTaxesForYear: z.number(),
  totalTaxIncludingPortfolio: z.number(),
  totalTaxIncludingPropertyEstimate: z.number().nullable(),
  yearlyIncome: z.array(
    z.looseObject({
      year: z.string(),
      income: z.number(),
      estimatedTax: z.number(),
      netAfterTax: z.number(),
      isApproximated: z.boolean(),
    }),
  ),
  monthlyIncomeTax: z.array(
    z.looseObject({
      period: z.string(),
      income: z.number(),
      estimatedTax: z.number(),
    }),
  ),
  recordedIncomeByPartner: z
    .looseObject({ A: z.number(), B: z.number() })
    .nullable(),
  yearCalculations: z.array(
    z.looseObject({
      year: z.number().int(),
      calculation: HistoricalCalculationSchema,
      isFiled: z.boolean(),
      hasFrozenCalculation: z.boolean(),
      isCurrent: z.boolean(),
      hasSnapshot: z.boolean(),
      hasTransactions: z.boolean(),
    }),
  ),
  suggestions: z.array(
    z.looseObject({
      id: z.string(),
      titleKey: z.string(),
      descriptionKey: z.string(),
      descriptionParams: z.record(z.string(), z.number()).optional(),
      estimate: z.number().optional(),
      noteKey: z.string().optional(),
    }),
  ),
  householdBreakdownRows: z.array(
    z.looseObject({
      key: z.string(),
      tone: z.string(),
      partnerAmounts: z.record(z.string(), z.number()),
      household: z.number(),
    }),
  ),
  ...UnconvertedFiguresShape,
});

// ── /api/belgian-tax/portfolio-dashboard ─────────────────────────────────────

const CostEntrySchema = z.looseObject({
  nameKey: z.string(),
  value: z.number(),
});

/** `GET /api/belgian-tax/portfolio-dashboard` — services/tax/portfolioDashboardService. */
export const BelgianPortfolioTaxDashboardSchema = z.looseObject({
  year: z.number().int(),
  currency: WireCurrencySchema,
  isEmpty: z.boolean(),
  hasProfile: z.boolean(),
  hasInKindIncomeUnclassified: z.boolean(),
  totals: z.looseObject({
    totalTaxes: z.number(),
    totalFees: z.number(),
    totalTaxesAndFees: z.number(),
    totalRecordedTaxes: z.number(),
    totalRecordedFees: z.number(),
    totalManualTaxes: z.number(),
    totalManualFees: z.number(),
    totalRealizedGain: z.number(),
    totalUnrealizedGain: z.number(),
    effectiveTaxRate: z.number(),
    totalPIT: z.number(),
    portfolioTaxesPlusPIT: z.number(),
  }),
  taxBreakdown: z.array(CostEntrySchema),
  feeBreakdown: z.array(CostEntrySchema),
  taxByAssetClass: z.array(
    z.looseObject({
      assetClass: z.string(),
      taxes: z.number(),
      fees: z.number(),
      total: z.number(),
    }),
  ),
  investmentBreakdown: z.array(
    z.looseObject({
      id: z.number().int(),
      name: z.string(),
      symbol: z.string().nullable(),
      assetClass: z.string(),
      recordedTaxes: z.number(),
      recordedFees: z.number(),
      manualTaxes: z.number(),
      manualFees: z.number(),
      taxes: z.number(),
      fees: z.number(),
      total: z.number(),
      realizedGain: z.number(),
      currency: WireCurrencySchema,
    }),
  ),
  yearlyCostTrend: z.array(
    z.looseObject({
      period: z.string(),
      taxes: z.number(),
      fees: z.number(),
    }),
  ),
  dividend: z.looseObject({
    totalDividendIncome: z.number(),
    grossDividendWht: z.number(),
    dividendExemption: z.number(),
    dividendWhtReclaim: z.number().nullable(),
    dividendWhtNetCost: z.number().nullable(),
    unknownDividendConventionCount: z.number().int(),
  }),
  estimates: z.looseObject({
    tobRecorded: z.number(),
    tobAutoEstimate: z.number(),
    tacrEstimate: z.number(),
    reyndersEstimate: z.number(),
    cgtEstimate: z.number(),
  }),
  taxTable: z.looseObject({
    securitiesAccountTaxRate: z.number(),
    capitalGainsTaxRate: z.number(),
    reyndersTaxRate: z.number(),
    dividendWHTRate: z.number(),
    securitiesAccountTaxThreshold: z.number(),
  }),
  summaries: z.array(
    z.looseObject({
      id: z.number().int(),
      name: z.string(),
      symbol: z.string().nullable(),
      assetClass: z.string(),
      currency: WireCurrencySchema,
    }),
  ),
  records: z.array(SettingRecordSchema),
  ...UnconvertedFiguresShape,
});

// ── /api/belgian-tax/compute and /api/belgian-tax/overview ───────────────────

/** Legacy-compatible PIT figures (`toBelgianTaxCalculation`); frozen ones may be older shapes. */
const BelgianTaxCalculationSchema = z.looseObject({
  grossIncome: z.number(),
  taxableIncome: z.number(),
  totalPIT: z.number(),
  totalTaxBurden: z.number(),
  effectiveRate: z.number(),
  marginalRate: z.number(),
  netTakeHome: z.number(),
  propertyTaxEstimate: z.number(),
  breakdown: z.array(z.looseObject({ label: z.string(), amount: z.number() })),
});

/** Household engine result (`computeHouseholdTax`). */
const BelgianTaxHouseholdResultSchema = z.looseObject({
  incomeYear: z.number().int(),
  assessment: z.looseObject({
    mode: z.enum(["single", "separate", "joint"]),
    reason: z.string(),
    legalBasis: z.string(),
  }),
  partners: z.array(
    z.looseObject({
      partnerId: z.enum(["A", "B"]),
      grossIncome: z.number(),
      taxableIncome: z.number(),
      totalPIT: z.number(),
    }),
  ),
  quotient: z.looseObject({
    applied: z.boolean(),
    transfer: z.number(),
    benefit: z.number(),
  }),
  totals: z.looseObject({}),
  issues: z.array(z.looseObject({ code: z.string(), severity: z.string() })),
});

/** `POST /api/belgian-tax/compute` — stateless engine run on a submitted household. */
export const BelgianTaxComputationSchema = z.looseObject({
  result: BelgianTaxHouseholdResultSchema,
  calculation: BelgianTaxCalculationSchema,
});

const HouseholdSchema = z.looseObject({
  version: z.literal(2),
  taxYear: z.number().int(),
  partners: z.array(z.looseObject({ id: z.enum(["A", "B"]) })),
});

/** `GET /api/belgian-tax/overview` — services/tax/overviewService.getTaxOverview. */
export const BelgianTaxOverviewSchema = z.looseObject({
  year: z.number().int(),
  liveYear: z.number().int(),
  isHistorical: z.boolean(),
  hasSnapshot: z.boolean(),
  hasProfile: z.boolean(),
  household: HouseholdSchema,
  liveHousehold: HouseholdSchema,
  householdSnapshots: z.record(z.string(), HouseholdSchema),
  snapshotMetas: z.record(z.string(), z.looseObject({})),
  metadata: z.looseObject({}),
  calculation: HistoricalCalculationSchema,
  result: z.looseObject({}),
  calculationSource: z.enum(["frozen", "computed"]),
  householdResultSource: z.enum(["frozen", "computed"]),
  householdMigrationNeeded: z.boolean(),
  snapshotsMigrationNeeded: z.boolean(),
  storedValueInvalid: z.boolean(),
  warnings: z.array(z.looseObject({ key: z.string(), kind: z.string() })),
  records: z.array(SettingRecordSchema),
});
