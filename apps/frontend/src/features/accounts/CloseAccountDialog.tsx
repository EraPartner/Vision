/**
 * Close-account workflow — the ONE lifecycle verb (§3 F5): closing sets
 * is_active=false, and the server also drops the account from aggregates
 * (in_net_worth=false, WP-A3 semantics). History and transactions are kept;
 * the account can be reopened later. The old ADR-091 flag-gated "transfer
 * holdings first" step was deleted with the per-account holdings machinery
 * (ADR-108); a residual computed balance is surfaced as a heads-up instead.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle, DoorClosed, Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { invalidateAccountRepoint } from '@/lib/queryKeys';
import { useCurrencyFormatter } from '@/hooks/useCurrencyFormatter';
import { apiErrorToMessage } from '@/lib/api/errorMessage';
import { useLanguage } from '@/contexts/LanguageContext';
import { toast } from 'sonner';
import type { Account } from '@/types/api';

interface CloseAccountDialogProps {
  account: Account;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

export function CloseAccountDialog({ account, open, onOpenChange }: CloseAccountDialogProps) {
  const { t } = useLanguage();
  const fmtCur = useCurrencyFormatter();
  const queryClient = useQueryClient();

  const close = useMutation({
    mutationFn: async () => {
      // Closing = is_active:false; the backend also sets in_net_worth=false
      // (WP-A3) so aggregates drop the account the moment it closes.
      await apiClient.updateAccount(account.id, { is_active: false });
    },
    onSuccess: () => {
      // Closing archives the account, so the same account/transaction/planned/
      // portfolio trees restate as in a merge. Invalidate exactly those instead
      // of the whole cache — see invalidateAccountRepoint.
      invalidateAccountRepoint(queryClient);
      toast.success(t('accounts.close.done', { name: account.display_name || account.name }));
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(t('accounts.close.failed'), { description: apiErrorToMessage(e, t) }),
  });

  const residual = account.computed_balance ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('accounts.close.title', { name: account.display_name || account.name })}</DialogTitle>
          <DialogDescription>{t('accounts.close.description')}</DialogDescription>
        </DialogHeader>

        {residual !== 0 && (
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t('accounts.close.residual', { balance: fmtCur(residual, account.currency) })}</span>
          </div>
        )}

        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button disabled={close.isPending} onClick={() => close.mutate()}>
            {close.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <DoorClosed className="h-4 w-4 mr-1" />}
            {t('accounts.close.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
