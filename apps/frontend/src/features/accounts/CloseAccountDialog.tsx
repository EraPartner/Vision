/**
 * Close-account workflow (ADR-091): a guided "deal with the holdings, then archive"
 * flow. An account that still owns lots can't be hard-deleted (ON DELETE RESTRICT),
 * and leaving positions in an archived account hides them — so this lists the
 * account's holdings and offers to transfer them all (in-specie, cost-basis
 * preserving) to another account before archiving (is_active=false).
 */

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Archive, ArrowRight, Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { invalidateAccountRepoint } from '@/lib/queryKeys';
import { toNumber } from '@/lib/money';
import { todayYmd } from '@/lib/timezone';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { accountPositionsFor } from '@/hooks/portfolio/useAccountPositions';
import { usePortfolio } from '@/hooks/usePortfolio';
import { isPerAccountHoldingsEnabled } from '@/lib/env';
import { useCurrencyFormatter } from '@/hooks/useCurrencyFormatter';
import { toast } from 'sonner';
import type { Account, Investment } from '@/types/api';
import type { InvestmentSummary } from '@/types/portfolio';

interface AccountHolding {
  investmentId: number;
  name: string;
  units: number;
  currentValue: number;
}

const EMPTY_SUMMARIES: InvestmentSummary[] = [];

interface CloseAccountDialogProps {
  account: Account;
  accounts: Account[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

/**
 * Fetches the portfolio summaries the holdings-transfer step needs. Split into
 * its own component so the (expensive: investments → dependent bulk
 * portfolio-transactions waterfall + cost-basis math) `usePortfolio()` pipeline
 * runs only when the per-account-holdings flag is on AND the close dialog is
 * actually open — never on every AccountsPage paint (ADR-103 keeps the flag off).
 */
function CloseAccountDialogWithPortfolio(props: CloseAccountDialogProps) {
  const { summaries } = usePortfolio();
  return <CloseAccountDialogView {...props} summaries={summaries} />;
}

export function CloseAccountDialog(props: CloseAccountDialogProps) {
  // `isPerAccountHoldingsEnabled` is a build-time constant, so this branch is
  // stable across renders (no rules-of-hooks issue).
  return isPerAccountHoldingsEnabled
    ? <CloseAccountDialogWithPortfolio {...props} />
    : <CloseAccountDialogView {...props} summaries={EMPTY_SUMMARIES} />;
}

function CloseAccountDialogView({ account, accounts, summaries, open, onOpenChange }: CloseAccountDialogProps & {
  summaries: InvestmentSummary[];
}) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const { multiplierFor } = useExchangeRates();
  const queryClient = useQueryClient();
  const [destId, setDestId] = useState('');

  const target = (appSettings.defaultCurrency || 'EUR').toUpperCase();
  // Shared cached currency formatter (app locale + showDecimalPlaces defaults).
  const fmt = useCurrencyFormatter(target);

  // Investments still holding a non-empty position in this account.
  // With per-account holdings off (ADR-103), there is no holdings transfer — the
  // account simply archives — so skip the per-account position computation.
  const holdings = useMemo<AccountHolding[]>(() => {
    if (!isPerAccountHoldingsEnabled) return [];
    const out: AccountHolding[] = [];
    for (const summary of summaries) {
      const native = (summary.originalCurrency || summary.currency || 'EUR').toUpperCase();
      const positions = accountPositionsFor(summary as unknown as Investment, summary.transactions, {
        costBasisMethod: appSettings.costBasisMethod ?? 'weighted_avg',
        multiplier: multiplierFor(native, target),
        // The other two call sites pass todayYmd() — '' made accrued interest
        // NaN in the transfer preview (''.split('-').map(Number)).
        today: todayYmd(),
        accountName: () => null,
      });
      const here = positions.find((p) => p.accountId === account.id);
      if (here && (Math.abs(here.totalUnits) > 1e-9 || Math.abs(here.currentValue) > 0.005)) {
        out.push({ investmentId: summary.id, name: summary.name, units: toNumber(here.totalUnits), currentValue: here.currentValue });
      }
    }
    return out;
  }, [summaries, account.id, appSettings.costBasisMethod, multiplierFor, target]);

  const destinations = accounts.filter((a) => a.id !== account.id && a.is_active);
  const needsDestination = holdings.length > 0;

  const close = useMutation({
    mutationFn: async () => {
      // Transfer every holding whole to the destination first (in-specie), then archive.
      if (needsDestination) {
        const to = Number(destId);
        for (const h of holdings) {
          await apiClient.moveHolding(h.investmentId, { from_account_id: account.id, to_account_id: to });
        }
      }
      await apiClient.updateAccount(account.id, { is_active: false });
    },
    onSuccess: () => {
      // Closing transfers holdings in-specie then archives the account, so the same
      // account/transaction/planned/portfolio trees restate as in a merge. Invalidate
      // exactly those instead of the whole cache — see invalidateAccountRepoint.
      invalidateAccountRepoint(queryClient);
      toast.success(t('accounts.close.done', { name: account.display_name || account.name }));
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(t('accounts.close.failed'), { description: e.message }),
  });

  const canSubmit = !close.isPending && (!needsDestination || !!destId);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setDestId(''); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('accounts.close.title', { name: account.display_name || account.name })}</DialogTitle>
          <DialogDescription>{t('accounts.close.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {holdings.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('accounts.close.noHoldings')}</p>
          ) : (
            <>
              <div className="rounded-md border divide-y text-sm">
                {holdings.map((h) => (
                  <div key={h.investmentId} className="flex items-center justify-between p-2">
                    <span className="truncate">{h.name}</span>
                    <span className="tabular-nums text-muted-foreground">{fmt(h.currentValue)}</span>
                  </div>
                ))}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="close-dest" className="flex items-center gap-1.5">
                  <ArrowRight className="h-3.5 w-3.5" /> {t('accounts.close.transferTo')}
                </Label>
                <Select value={destId} onValueChange={setDestId}>
                  <SelectTrigger id="close-dest"><SelectValue placeholder={t('portfolio.move.selectAccount')} /></SelectTrigger>
                  <SelectContent>
                    {destinations.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>{a.display_name || a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {destinations.length === 0 && (
                  <p className="text-xs text-destructive">{t('accounts.close.noDestination')}</p>
                )}
              </div>
            </>
          )}
        </div>

        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button disabled={!canSubmit} onClick={() => close.mutate()}>
            {close.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Archive className="h-4 w-4 mr-1" />}
            {needsDestination ? t('accounts.close.transferAndArchive') : t('accounts.close.archive')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
