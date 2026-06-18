/**
 * Per-account positioning (ADR-091): derive a holding's position split across
 * the accounts that custody it ("AAPL 150 → IBKR 100 · Degiro 50").
 *
 * A position = (investment, account). The split is a pure grouping over the
 * investment's lots (each carries an `account_id`) re-run through the SAME shared
 * cost-basis math the per-investment summary uses, then converted with the SAME
 * single FX multiplier — so the per-account rows re-sum to the per-investment
 * totals by construction (the ADR-091 divergence guarantee).
 */

import { useMemo } from 'react';
import { buildInvestmentSummaryCore, type CostBasisMethod } from '@vision/shared-utils/portfolio';
import type { Investment, PortfolioTransaction } from '@/types/api';
import type { InvestmentSummary } from '@/types/portfolio';
import { todayYmd } from '@/lib/timezone';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useAccounts } from '@/hooks/useAccounts';
import { toNumber, multiply } from '@/lib/money';

export interface AccountPosition {
  /** null = lots not yet assigned to an account ("unassigned" / global). */
  accountId: number | null;
  accountName: string | null;
  totalUnits: number;
  currentValue: number;
  /** Gross buy cost (acquisition costs folded in where the asset class records them). */
  costBasis: number;
  gainLoss: number;
}

interface ComputeOpts {
  costBasisMethod: CostBasisMethod;
  multiplier: number;
  today: string;
  accountName: (id: number) => string | null;
}

/**
 * Pure per-account split for one investment. `inv` only needs the security
 * fields the cost-basis core reads (current_price, asset_class, interest_rate);
 * an InvestmentSummary (a superset of Investment) satisfies it.
 */
export function accountPositionsFor(
  inv: Investment,
  transactions: PortfolioTransaction[],
  { costBasisMethod, multiplier, today, accountName }: ComputeOpts,
): AccountPosition[] {
  const groups = new Map<number | null, PortfolioTransaction[]>();
  for (const txn of transactions) {
    const key = txn.account_id ?? null;
    const bucket = groups.get(key);
    if (bucket) bucket.push(txn);
    else groups.set(key, [txn]);
  }

  const conv = (v: Parameters<typeof multiply>[0]) => toNumber(multiply(v, multiplier));

  const positions: AccountPosition[] = [];
  for (const [accountId, txns] of groups) {
    const core = buildInvestmentSummaryCore(inv, txns, { costBasisMethod, todayYmd: today });
    positions.push({
      accountId,
      accountName: accountId == null ? null : accountName(accountId),
      totalUnits: toNumber(core.totalUnits),
      currentValue: conv(core.currentValue),
      costBasis: conv(core.totalBuyCost),
      gainLoss: conv(core.gainLoss),
    });
  }

  // Largest value first; unassigned (null) sinks to the bottom on ties.
  return positions.sort((a, b) => b.currentValue - a.currentValue);
}

/**
 * Per-account breakdown for a single investment summary, in the app's display
 * currency. Returns [] until accounts/rates load.
 */
export function useAccountPositions(summary: InvestmentSummary): AccountPosition[] {
  const { appSettings } = useAppSettings();
  const { multiplierFor } = useExchangeRates();
  const { data: accountsData } = useAccounts({ active: 'all' });

  return useMemo(() => {
    const target = (appSettings.defaultCurrency || 'EUR').toUpperCase();
    const native = (summary.originalCurrency || summary.currency || 'EUR').toUpperCase();
    const nameById = new Map((accountsData?.items ?? []).map((a) => [a.id, a.display_name || a.name]));
    return accountPositionsFor(summary as unknown as Investment, summary.transactions, {
      costBasisMethod: appSettings.costBasisMethod ?? 'weighted_avg',
      multiplier: multiplierFor(native, target),
      today: todayYmd(),
      accountName: (id) => nameById.get(id) ?? `#${id}`,
    });
  }, [summary, appSettings.defaultCurrency, appSettings.costBasisMethod, multiplierFor, accountsData]);
}
