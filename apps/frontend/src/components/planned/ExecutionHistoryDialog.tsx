import { useState, useCallback, useEffect } from "react";
import { Money } from "@/components/shared/Money";
import logger from "@/lib/logger";
import { ExternalLink } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatDateStringWithAppSettings } from "@/components/shared/dateUtils";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { apiClient } from "@/lib/api";
import { useNavigate } from "react-router-dom";
import type { PlannedPayment } from "@/hooks/usePlannedPayments";

type ExecutionHistoryItem = {
  plannedPaymentId: number;
  plannedPaymentName: string;
  executionDate: string;
  transactionId: number;
  transactionDate: string;
  recipientName?: string;
  categoryName?: string;
  amount: number;
  currency?: string;
  memo?: string;
};

interface ExecutionHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payments: PlannedPayment[];
}

export function ExecutionHistoryDialog({ open, onOpenChange, payments }: ExecutionHistoryDialogProps) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const navigate = useNavigate();

  const [historyLoading, setHistoryLoading] = useState(false);
  const [executionHistory, setExecutionHistory] = useState<ExecutionHistoryItem[]>([]);

  const loadExecutionHistory = useCallback(async () => {
    const links = payments.flatMap((payment) => {
      if (payment.executions && payment.executions.length > 0) {
        return payment.executions.map((execution) => ({
          plannedPaymentId: payment.id,
          plannedPaymentName: payment.name,
          executionDate: execution.execution_date,
          transactionId: execution.executed_transaction_id,
        }));
      }

      if (payment.executed_transaction_id) {
        return [{
          plannedPaymentId: payment.id,
          plannedPaymentName: payment.name,
          executionDate: payment.last_executed_date || payment.due_date,
          transactionId: payment.executed_transaction_id,
        }];
      }

      return [];
    });

    if (links.length === 0) {
      setExecutionHistory([]);
      return;
    }

    setHistoryLoading(true);
    try {
      const results = await Promise.allSettled(
        links.map(async (link): Promise<ExecutionHistoryItem | null> => {
          const txResponse = await apiClient.getTransactions({ transaction_id: link.transactionId, limit: 1 });
          const transaction = txResponse.items[0];
          if (!transaction) return null;

          return {
            plannedPaymentId: link.plannedPaymentId,
            plannedPaymentName: link.plannedPaymentName,
            executionDate: link.executionDate,
            transactionId: link.transactionId,
            transactionDate: transaction.transaction_date,
            recipientName: transaction.recipient_name,
            categoryName: transaction.category_name,
            amount: transaction.amount,
            currency: transaction.currency,
            memo: transaction.memo,
          } satisfies ExecutionHistoryItem;
        })
      );

      const resolved = results
        .filter((result): result is Extract<typeof result, { status: 'fulfilled' }> => result.status === 'fulfilled')
        .map((result) => result.value)
        .filter((item): item is ExecutionHistoryItem => item != null)
        .sort((a, b) => (b.executionDate || '').localeCompare(a.executionDate || ''));

      setExecutionHistory(resolved);
    } catch (err) {
      logger.error('Failed to load planned execution history', err);
      setExecutionHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [payments]);

  useEffect(() => {
    if (open) void loadExecutionHistory();
  }, [open, loadExecutionHistory]);

  const handleOpenChange = (isOpen: boolean) => {
    onOpenChange(isOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('plannedPage.history.title')}</DialogTitle>
        </DialogHeader>

        {historyLoading ? (
          <div className="py-10 text-center text-muted-foreground">{t('plannedPage.history.loading')}</div>
        ) : executionHistory.length === 0 ? (
          <div className="py-10 text-center text-muted-foreground">{t('plannedPage.history.empty')}</div>
        ) : (
          <div className="rounded-md border">
            <div className="grid grid-cols-12 gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
              <div className="col-span-2">{t('plannedPage.history.colExecutedOn')}</div>
              <div className="col-span-3">{t('plannedPage.history.colPlanned')}</div>
              <div className="col-span-5">{t('plannedPage.history.colTransaction')}</div>
              <div className="col-span-2 text-right">{t('plannedPage.col.amount')}</div>
            </div>
            <div className="max-h-[55vh] overflow-y-auto">
              {executionHistory.map((item) => (
                <div
                  key={`${item.plannedPaymentId}-${item.transactionId}-${item.executionDate}`}
                  className="grid grid-cols-12 gap-3 border-b px-3 py-2 text-sm last:border-b-0"
                >
                  <div className="col-span-2 text-muted-foreground">
                    {formatDateStringWithAppSettings(item.executionDate, appSettings.dateFormat) || '—'}
                  </div>
                  <div className="col-span-3 font-medium">{item.plannedPaymentName}</div>
                  <div className="col-span-5 min-w-0">
                    <div className="truncate">{item.memo || t('plannedPage.link.txFallback', { id: item.transactionId })}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {[item.recipientName, item.categoryName, formatDateStringWithAppSettings(item.transactionDate, appSettings.dateFormat)].filter(Boolean).join(' • ')}
                    </div>
                  </div>
                  <div className="col-span-2 flex items-center justify-end gap-2">
                    <span className={`tabular-nums font-semibold ${item.amount < 0 ? 'text-destructive' : 'text-accent'}`}>
                      {item.amount < 0 ? '−' : '+'}<Money amount={Math.abs(item.amount)} currency={item.currency} />
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="icon-touch-target"
                      title={t('plannedPage.history.openTransaction')}
                      onClick={() => {
                        onOpenChange(false);
                        navigate(`/transactions?transaction_id=${item.transactionId}`);
                      }}
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
