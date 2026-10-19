import { z } from "zod";
import { SettingRecordSchema } from "./settings.ts";

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
  currency: z.string(),
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
});

// ── /api/belgian-tax/portfolio-dashboard ─────────────────────────────────────

const CostEntrySchema = z.looseObject({
  nameKey: z.string(),
  value: z.number(),
});

/** `GET /api/belgian-tax/portfolio-dashboard` — services/tax/portfolioDashboardService. */
export const BelgianPortfolioTaxDashboardSchema = z.looseObject({
  year: z.number().int(),
  currency: z.string(),
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
      currency: z.string(),
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
      currency: z.string(),
    }),
  ),
  records: z.array(SettingRecordSchema),
});
