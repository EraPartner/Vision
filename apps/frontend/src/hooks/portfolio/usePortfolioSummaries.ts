/**
 * Composes investment queries + shared calculations into InvestmentSummary[].
 * Provides totals and byAssetClass() filtered view.
 *
 * The per-investment math is @vision/shared-utils/portfolio's
 * buildInvestmentSummaryCore — the same implementation the backend summary
 * service runs — so the two sides cannot drift. This hook only adds FX
 * conversion to the app's display currency, rounding via toNumber, and the
 * InvestmentSummary shape.
 */

import { useCallback, useMemo } from 'react';
import type { AssetClass, Investment, PortfolioTransaction } from '@/types/api';
import type { InvestmentSummary } from '@/types/portfolio';
import {
  buildInvestmentSummaryCore,
  type CostBasisMethod,
} from '@vision/shared-utils/portfolio';
import { todayYmd } from '@/lib/timezone';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { toNumber, multiply, addAll } from '@/lib/money';

interface BuildSummaryOpts {
  costBasisMethod: CostBasisMethod;
  targetCurrency: string;
  /** Multiplier converting the investment's native currency → targetCurrency. */
  multiplier: number;
  today: string;
}

function buildSummary(
  inv: Investment,
  txns: PortfolioTransaction[],
  { costBasisMethod, targetCurrency, multiplier, today }: BuildSummaryOpts
): InvestmentSummary {
  const core = buildInvestmentSummaryCore(inv, txns, { costBasisMethod, todayYmd: today });

  const conv = (v: Parameters<typeof multiply>[0]) => toNumber(multiply(v, multiplier));

  return {
    ...inv,
    // All monetary fields below are converted to the app's display currency;
    // the native currency stays available for labelling (mirrors the backend
    // summary response shape).
    currency: targetCurrency,
    originalCurrency: (inv.currency || 'EUR').toUpperCase(),
    assetClass: inv.asset_class,
    totalUnits: toNumber(core.totalUnits),
    totalInvested: conv(core.totalInvested),
    totalFees: conv(core.totalFees),
    totalTaxes: conv(core.totalTaxes),
    feeTransactions: conv(core.feeTxnAmount),
    taxTransactions: conv(core.taxTxnAmount),
    totalDividends: conv(core.totalDividends),
    totalIncome: conv(core.totalIncome),
    currentValue: conv(core.currentValue),
    currentPrice: Number(inv.current_price) ? conv(Number(inv.current_price)) : undefined,
    interestRate: Number(inv.interest_rate) || undefined,
    avgCostBasis: conv(core.avgCostBasis),
    realizedGain: conv(core.realizedGain),
    unrealizedGain: conv(core.unrealizedGain),
    totalGain: conv(core.totalGain),
    gainLoss: conv(core.gainLoss),
    gainLossPercent: toNumber(core.gainLossPercent),
    accruedInterest: conv(core.accruedInterest),
    projectedAnnualInterest: conv(core.projectedAnnualInterest),
    totalAppreciation: conv(core.totalAppreciation),
    totalBuyCost: conv(core.totalBuyCost),
    totalSellProceeds: conv(core.totalSellProceeds),
    transactions: txns,
  } as InvestmentSummary;
}

interface UsePortfolioSummariesInput {
  investments: Investment[];
  transactions: PortfolioTransaction[];
}

// Stable empty result so a single-class lookup with no matches keeps its
// identity across renders.
const EMPTY_SUMMARIES: InvestmentSummary[] = [];

export function usePortfolioSummaries({
  investments,
  transactions,
}: UsePortfolioSummariesInput) {
  const { appSettings } = useAppSettings();
  const { multiplierFor } = useExchangeRates();
  const costBasisMethod: CostBasisMethod = appSettings.costBasisMethod ?? 'weighted_avg';
  const targetCurrency = (appSettings.defaultCurrency || 'EUR').toUpperCase();

  const summaries: InvestmentSummary[] = useMemo(() => {
    const txnsByInvestment = new Map<number, PortfolioTransaction[]>();
    for (const txn of transactions) {
      const bucket = txnsByInvestment.get(txn.investment_id);
      if (bucket) bucket.push(txn);
      else txnsByInvestment.set(txn.investment_id, [txn]);
    }

    const today = todayYmd();
    return investments.map((inv) =>
      buildSummary(inv, txnsByInvestment.get(inv.id) ?? [], {
        costBasisMethod,
        targetCurrency,
        multiplier: multiplierFor(inv.currency || 'EUR', targetCurrency),
        today,
      })
    );
  }, [investments, transactions, costBasisMethod, targetCurrency, multiplierFor]);

  const totals = useMemo(
    () => ({
      totalPortfolioValue: toNumber(addAll(summaries.map((s) => s.currentValue))),
      totalGainLoss: toNumber(addAll(summaries.map((s) => s.gainLoss))),
      totalRealizedGain: toNumber(addAll(summaries.map((s) => s.realizedGain))),
      totalUnrealizedGain: toNumber(addAll(summaries.map((s) => s.unrealizedGain))),
    }),
    [summaries]
  );

  // Pre-group once per summaries change. A single-class lookup then returns the
  // grouped array directly with a stable identity — previously every render
  // produced a fresh `.filter()` result, so the Stocks/Crypto/Metals pages
  // re-rendered even when nothing changed.
  const groupedByClass = useMemo(() => {
    const map = new Map<AssetClass, InvestmentSummary[]>();
    for (const s of summaries) {
      const cls = s.assetClass as AssetClass;
      const list = map.get(cls);
      if (list) list.push(s);
      else map.set(cls, [s]);
    }
    return map;
  }, [summaries]);

  const byAssetClass = useCallback(
    (cls: AssetClass | AssetClass[]): InvestmentSummary[] => {
      if (!Array.isArray(cls)) return groupedByClass.get(cls) ?? EMPTY_SUMMARIES;
      return cls.flatMap((c) => groupedByClass.get(c) ?? []);
    },
    [groupedByClass]
  );

  return { summaries, totals, byAssetClass };
}
