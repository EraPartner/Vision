/**
 * Per-account net-worth breakdown (ADR-093): each account's cash + holdings at
 * market, in the app's display currency. Cash is the account's computed balance
 * (ADR-094, latest active transaction balance); holdings are the per-account
 * portfolio positions (ADR-091) aggregated across every investment.
 *
 * Only accounts flagged `in_net_worth` contribute, mirroring the net-worth
 * aggregate (liabilities included as negative balances, ADR-092). Holdings that
 * are not yet assigned to an account surface as a single "unassigned" row.
 */

import { useMemo } from 'react';
import type { Investment } from '@/types/api';
import type { InvestmentSummary } from '@/types/portfolio';
import { todayYmd } from '@/lib/timezone';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useAccounts } from '@/hooks/useAccounts';
import { toNumber, multiply } from '@/lib/money';
import { accountPositionsFor } from '@/hooks/portfolio/useAccountPositions';

export interface AccountNetWorthRow {
  /** null = the aggregated "unassigned holdings" row. */
  accountId: number | null;
  name: string | null;
  cash: number;
  /** Liability-account balance (negative); kept out of `cash` so debt is not shown as liquid (ADR-092). */
  liabilities: number;
  holdings: number;
  total: number;
}

export function useAccountNetWorth(summaries: InvestmentSummary[]): AccountNetWorthRow[] {
  const { appSettings } = useAppSettings();
  const { multiplierFor } = useExchangeRates();
  const { data: accountsData } = useAccounts({ active: 'all' });

  return useMemo(() => {
    const target = (appSettings.defaultCurrency || 'EUR').toUpperCase();
    const costBasisMethod = appSettings.costBasisMethod ?? 'weighted_avg';
    const today = todayYmd();
    const accounts = accountsData?.items ?? [];
    const nameById = new Map(accounts.map((a) => [a.id, a.display_name || a.name]));

    // Holdings at market per account, across all investments.
    const holdingsByAccount = new Map<number | null, number>();
    for (const summary of summaries) {
      const native = (summary.originalCurrency || summary.currency || 'EUR').toUpperCase();
      const positions = accountPositionsFor(summary as unknown as Investment, summary.transactions, {
        costBasisMethod,
        multiplier: multiplierFor(native, target),
        today,
        accountName: (id) => nameById.get(id) ?? `#${id}`,
      });
      for (const pos of positions) {
        holdingsByAccount.set(pos.accountId, (holdingsByAccount.get(pos.accountId) ?? 0) + pos.currentValue);
      }
    }

    const rows: AccountNetWorthRow[] = [];
    for (const a of accounts) {
      if (!a.in_net_worth) continue;
      const balance = toNumber(multiply(a.computed_balance ?? 0, multiplierFor(a.currency || 'EUR', target)));
      // Liability balances are debt, not liquid cash — surface them separately.
      const isLiability = a.type === 'liability';
      const cash = isLiability ? 0 : balance;
      const liabilities = isLiability ? balance : 0;
      const holdings = holdingsByAccount.get(a.id) ?? 0;
      rows.push({ accountId: a.id, name: a.display_name || a.name, cash, liabilities, holdings, total: cash + liabilities + holdings });
    }

    const unassignedHoldings = holdingsByAccount.get(null) ?? 0;
    if (Math.abs(unassignedHoldings) > 0.005) {
      rows.push({ accountId: null, name: null, cash: 0, liabilities: 0, holdings: unassignedHoldings, total: unassignedHoldings });
    }

    return rows.sort((x, y) => y.total - x.total);
  }, [summaries, accountsData, appSettings.defaultCurrency, appSettings.costBasisMethod, multiplierFor]);
}
