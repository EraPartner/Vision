/**
 * Close-account workflow: archive the account (is_active=false). The ADR-091
 * flag-gated "transfer holdings first" step was deleted with the per-account
 * holdings machinery (ADR-108); the broker close flow (re-tag lots) arrives
 * with the unified close dialog in WP-C6.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Archive, Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { invalidateAccountRepoint } from '@/lib/queryKeys';
import { useLanguage } from '@/contexts/LanguageContext';
import { toast } from 'sonner';
import type { Account } from '@/types/api';

interface CloseAccountDialogProps {
  account: Account;
  accounts: Account[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

export function CloseAccountDialog({ account, open, onOpenChange }: CloseAccountDialogProps) {
  const { t } = useLanguage();
  const queryClient = useQueryClient();

  const close = useMutation({
    mutationFn: async () => {
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
    onError: (e: Error) => toast.error(t('accounts.close.failed'), { description: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('accounts.close.title', { name: account.display_name || account.name })}</DialogTitle>
          <DialogDescription>{t('accounts.close.description')}</DialogDescription>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">{t('accounts.close.noHoldings')}</p>

        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button disabled={close.isPending} onClick={() => close.mutate()}>
            {close.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Archive className="h-4 w-4 mr-1" />}
            {t('accounts.close.archive')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
