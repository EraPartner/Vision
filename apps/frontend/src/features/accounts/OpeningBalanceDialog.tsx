/**
 * Set-opening-balance workflow (ADR-094 second addendum, D4).
 *
 * Manual/cash-only accounts (a wallet, an account whose bank has no CSV export)
 * have no way to seed a starting balance since `transactions.balance` became
 * import-pipeline-only. This dialog calls the single sanctioned exception —
 * POST /api/accounts/:id/opening-balance — which stamps one server-side anchor
 * row (amount=0, transfer_source='opening') per account+currency, anchoring the
 * account's computed balance and drift. Running it again updates the anchor.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Coins, Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { apiErrorToMessage } from '@/lib/api/errorMessage';
import { useLanguage } from '@/stores/hydration/LanguageHydration';
import { invalidateAccountDerived, invalidateTransactionData } from '@/lib/queryKeys';
import { toYmd } from '@/lib/dateUtils';
import { toast } from 'sonner';
import type { Account } from '@/types/api';

export function OpeningBalanceDialog({ account, open, onOpenChange }: {
  account: Account;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useLanguage();
  const queryClient = useQueryClient();

  // The anchor is stamped per (account, currency) and is a NATIVE figure, so
  // every number this dialog offers must be denominated in the currency it
  // stamps. That is `reconcilable_currency` — the one currency partition the
  // statement figure is a statement for (ReconcileDialog's `baseCurrency`,
  // which its §3 F4 backfill posts the anchor in). It falls back to the
  // account's own currency for a payload without the field (an older server, or
  // the detail endpoint, which does not return it), which is also the exact
  // value on every single-currency account.
  const anchorCurrency = account.reconcilable_currency ?? account.currency;

  // Prefill from an existing statement balance when present, else the
  // reconciliation base — a sensible starting figure the user can override.
  // NOT `computed_balance`: that is every partition FX-converted into the
  // account currency at today's rate, so on a multi-currency account it would
  // offer a cross-currency total as this partition's native opening anchor
  // (same defect class as the reconcile dialog's, fixed there). `statement_balance`
  // and `reconcilable_balance` are both already in `anchorCurrency`; the
  // `computed_balance` tail only fires when `reconcilable_balance` is absent,
  // where the two coincide anyway.
  const [balance, setBalance] = useState(
    account.statement_balance != null
      ? String(account.statement_balance)
      : account.reconcilable_balance != null
        ? String(account.reconcilable_balance)
        : account.computed_balance != null
          ? String(account.computed_balance)
          : '',
  );
  const [date, setDate] = useState(
    account.statement_balance_date
      ? account.statement_balance_date.slice(0, 10)
      : toYmd(new Date()),
  );

  const reset = () => {
    setBalance(account.statement_balance != null ? String(account.statement_balance) : '');
  };

  const save = useMutation({
    mutationFn: () =>
      apiClient.setOpeningBalance(account.id, {
        balance: Number(balance),
        date,
        // Stamp the anchor in the currency the prefilled figure is denominated
        // in (see `anchorCurrency`) — same code the reconcile backfill posts.
        currency: anchorCurrency,
      }),
    onSuccess: (result) => {
      // Account balance/drift and every net-worth view derive from the ledger.
      invalidateAccountDerived(queryClient);
      // The anchor is a real ledger row, so the transaction lists must refetch
      // for it to appear.
      invalidateTransactionData(queryClient);
      // A mid-history anchor is inert (a later import stamp wins) — surface it.
      if (result.warning) toast.warning(t('accounts.openingBalance.saved'), { description: result.warning });
      else toast.success(t('accounts.openingBalance.saved'));
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(t('accounts.openingBalance.failed'), { description: apiErrorToMessage(e, t) }),
  });

  const canSubmit = !save.isPending && balance.trim() !== '' && Number.isFinite(Number(balance)) && !!date;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('accounts.openingBalance.title')}</DialogTitle>
          <DialogDescription>
            {t('accounts.openingBalance.description', { name: account.display_name || account.name })}
          </DialogDescription>
        </DialogHeader>

        {/* Real <form> so Enter in either field saves. grid gap-5 mirrors
            DialogContent's layout, so the wrapper is layout-neutral. */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) save.mutate();
          }}
          className="grid gap-5"
        >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="opening-balance">
              {t('accounts.openingBalance.balanceLabel')} ({anchorCurrency})
            </Label>
            <Input
              id="opening-balance"
              type="number"
              inputMode="decimal"
              step="0.01"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="opening-balance-date">{t('accounts.openingBalance.dateLabel')}</Label>
            <Input
              id="opening-balance-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter className="pt-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={!canSubmit}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Coins className="h-4 w-4 mr-1" />}
            {t('accounts.openingBalance.submit')}
          </Button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
