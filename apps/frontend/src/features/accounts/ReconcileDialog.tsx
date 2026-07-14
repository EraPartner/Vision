/**
 * Drift reconciliation workflow (ADR-094, Phase C — accounts rewrite).
 *
 * The drift badge on an account card (statement_balance − computed_balance) used
 * to be a dead-end `title` tooltip: the only way to clear a drift was Edit →
 * Advanced. This dialog, opened by clicking the badge, shows the statement figure,
 * the computed (ledger) figure and their difference, then offers two explicit
 * resolutions backed by POST /api/accounts/:id/reconcile:
 *
 *   - "accept"     — adopt the computed balance: the stored statement figure is
 *                    rewritten to match it (no transaction created).
 *   - "adjustment" — keep the statement as truth: the server stamps one balancing
 *                    'adjustment' ledger row so the computed balance rises to meet
 *                    it. Opt-in and balance-free, preserving the ADR-094
 *                    descriptive-only default.
 *
 * Either way the drift collapses to 0 and every balance/net-worth view refreshes.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Check, Loader2, Plus } from 'lucide-react';
import { apiClient } from '@/lib/api';
import type { ReconcileMode } from '@/lib/api/accounts';
import { useCurrencyFormatter } from '@/hooks/useCurrencyFormatter';
import { useLanguage } from '@/contexts/LanguageContext';
import { invalidateTransactionLists } from '@/hooks/useTransactions';
import { toast } from 'sonner';
import type { Account } from '@/types/api';

export function ReconcileDialog({ account, open, onOpenChange }: {
  account: Account;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useLanguage();
  const fmtCur = useCurrencyFormatter();
  const queryClient = useQueryClient();

  const statement = account.statement_balance ?? 0;
  const computed = account.computed_balance ?? 0;
  const delta = account.drift ?? statement - computed;

  const reconcile = useMutation({
    mutationFn: (mode: ReconcileMode) => apiClient.reconcileAccount(account.id, mode),
    onSuccess: (_result, mode) => {
      // Balance, drift and every net-worth view derive from the ledger + statement.
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['net-worth'] });
      queryClient.invalidateQueries({ queryKey: ['net-worth-by-account'] });
      // The 'adjustment' mode stamps a real ledger row; the lists live under
      // ['transactions-virtual', …] (+ derived widgets), so invalidate them all.
      invalidateTransactionLists(queryClient);
      toast.success(t(mode === 'accept' ? 'accounts.reconcile.acceptSaved' : 'accounts.reconcile.adjustSaved'));
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(t('accounts.reconcile.failed'), { description: e.message }),
  });

  const busy = reconcile.isPending;
  const pendingMode = reconcile.variables;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('accounts.reconcile.title')}</DialogTitle>
          <DialogDescription>
            {t('accounts.reconcile.description', { name: account.display_name || account.name })}
          </DialogDescription>
        </DialogHeader>

        {/* Statement vs computed + delta */}
        <dl className="glass-thin rounded-xl p-4 text-sm">
          <div className="flex items-center justify-between py-1">
            <dt className="text-muted-foreground">{t('accounts.reconcile.statementLabel')}</dt>
            <dd className="tabular-nums font-medium">{fmtCur(statement, account.currency)}</dd>
          </div>
          <div className="flex items-center justify-between py-1">
            <dt className="text-muted-foreground">{t('accounts.reconcile.computedLabel')}</dt>
            <dd className="tabular-nums font-medium">{fmtCur(computed, account.currency)}</dd>
          </div>
          <div className="mt-1 flex items-center justify-between border-t border-border/50 pt-2">
            <dt className="font-medium">{t('accounts.reconcile.deltaLabel')}</dt>
            <dd className="tabular-nums font-semibold text-destructive">
              {delta > 0 ? '+' : ''}{fmtCur(delta, account.currency)}
            </dd>
          </div>
        </dl>

        {/* Two explicit resolutions */}
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('accounts.reconcile.acceptTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('accounts.reconcile.acceptDescription')}</p>
            <Button
              variant="outline"
              className="mt-1 w-full"
              disabled={busy}
              onClick={() => reconcile.mutate('accept')}
            >
              {busy && pendingMode === 'accept'
                ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
                : <Check className="h-4 w-4 mr-1" />}
              {t('accounts.reconcile.acceptSubmit')}
            </Button>
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('accounts.reconcile.adjustTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('accounts.reconcile.adjustDescription')}</p>
            <Button
              className="mt-1 w-full"
              disabled={busy}
              onClick={() => reconcile.mutate('adjustment')}
            >
              {busy && pendingMode === 'adjustment'
                ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
                : <Plus className="h-4 w-4 mr-1" />}
              {t('accounts.reconcile.adjustSubmit')}
            </Button>
          </div>
        </div>

        <DialogFooter className="pt-2">
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
