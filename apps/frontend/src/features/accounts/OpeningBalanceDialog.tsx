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
import { useLanguage } from '@/contexts/LanguageContext';
import { invalidateAccountDerived, invalidateTransactionData } from '@/lib/queryKeys';
import { toYmd } from '@/components/shared/dateUtils';
import { toast } from 'sonner';
import type { Account } from '@/types/api';

export function OpeningBalanceDialog({ account, open, onOpenChange }: {
  account: Account;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useLanguage();
  const queryClient = useQueryClient();

  // Prefill from an existing statement balance when present, else the computed
  // balance — a sensible starting figure the user can override.
  const [balance, setBalance] = useState(
    account.statement_balance != null
      ? String(account.statement_balance)
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
        currency: account.currency,
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

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="opening-balance">
              {t('accounts.openingBalance.balanceLabel')} ({account.currency})
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button disabled={!canSubmit} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Coins className="h-4 w-4 mr-1" />}
            {t('accounts.openingBalance.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
