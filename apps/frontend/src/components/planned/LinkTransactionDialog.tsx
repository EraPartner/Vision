import { useState, useEffect } from "react";
import { toast } from "sonner";
import logger from "@/lib/logger";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/shared/DatePicker";
import { formatDateStringWithAppSettings, parseLocalDateFromYmd, toYmd } from "@/components/shared/dateUtils";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { apiClient } from "@/lib/api";
import type { Transaction } from "@/types/api";
import type { PlannedPayment } from "@/hooks/usePlannedPayments";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";

interface LinkTransactionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payment: PlannedPayment | null;
  onExecute: (paymentId: number, txId: number, executionDate?: string) => Promise<void>;
}

export function LinkTransactionDialog({ open, onOpenChange, payment, onExecute }: LinkTransactionDialogProps) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const formatDisplayCurrency = (amount: number, currency?: string) =>
    formatCurrency(amount, currency || appSettings.defaultCurrency, locale);

  const [txSearchQuery, setTxSearchQuery] = useState("");
  const [candidateTxs, setCandidateTxs] = useState<Transaction[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [selectedTxId, setSelectedTxId] = useState<number | null>(null);
  const [executionDate, setExecutionDate] = useState<string>(() => toYmd(new Date()));
  const [txFilters, setTxFilters] = useState({
    start_date: "",
    end_date: "",
    bank_account: "",
    recipient_name: "",
    uncategorised: false,
    active: true,
    matchAmount: true,
    amountTolerancePct: 5,
  });

  useEffect(() => {
    if (payment) {
      setTxFilters((prev) => ({
        ...prev,
        recipient_name: payment.recipient || prev.recipient_name,
        start_date: payment.due_date || prev.start_date,
        bank_account: payment.bank_account || prev.bank_account,
      }));
    }
  }, [payment]);

  useEffect(() => {
    let isMounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchTransactions = async () => {
      if (!open || !payment) return;
      setTxLoading(true);
      try {
        const params: Record<string, string | number | boolean> = { limit: 50 };
        if (txFilters.start_date) params.start_date = txFilters.start_date;
        if (txFilters.end_date) params.end_date = txFilters.end_date;
        if (txFilters.bank_account) params.bank_account = txFilters.bank_account;
        if (txFilters.recipient_name) params.recipient_name = txFilters.recipient_name;
        else if (payment.recipient) params.recipient_name = payment.recipient;
        if (txFilters.uncategorised) params.uncategorised = true;
        params.active = txFilters.active;

        const res = await apiClient.getTransactions(params);
        if (isMounted) setCandidateTxs(res.items || []);
      } catch (err) {
        logger.error("Failed to fetch transactions:", err);
        if (isMounted) setCandidateTxs([]);
      } finally {
        if (isMounted) setTxLoading(false);
      }
    };

    if (open && payment) {
      timer = setTimeout(fetchTransactions, 250);
    }

    return () => {
      isMounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [open, payment, txFilters, txSearchQuery]);

  const handleClose = () => {
    onOpenChange(false);
    setSelectedTxId(null);
    setTxSearchQuery("");
    setCandidateTxs([]);
  };

  const handleLinkAndExecute = async () => {
    if (!payment || !selectedTxId) return;
    setActionLoading(true);
    try {
      await onExecute(payment.id, selectedTxId, executionDate || undefined);
      handleClose();
    } catch (err) {
      logger.error("Failed to link/execute planned payment:", err);
      toast.error(t('plannedPage.link.executeFailed'));
    } finally {
      setActionLoading(false);
    }
  };

  const filteredCandidates = candidateTxs.filter((tx) => {
    if (txSearchQuery) {
      const q = txSearchQuery.toLowerCase();
      if (!((tx.memo || "").toLowerCase().includes(q) || (tx.recipient_name || "").toLowerCase().includes(q) || String(tx.amount).includes(q))) {
        return false;
      }
    }
    if (txFilters.matchAmount && payment && typeof payment.amount === "number") {
      const planned = Math.abs(payment.amount);
      const txAmt = Math.abs(tx.amount);
      const tol = Math.max(1, planned * (txFilters.amountTolerancePct / 100));
      if (Math.abs(txAmt - planned) > tol) return false;
    }
    return true;
  });

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('plannedPage.link.title', { name: payment?.name })}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input placeholder={t('plannedPage.link.searchPlaceholder')} value={txSearchQuery} onChange={(e) => setTxSearchQuery(e.target.value)} />
            <div className="space-y-1">
              <DatePicker
                value={executionDate ? parseLocalDateFromYmd(executionDate) : undefined}
                onChange={(date) => setExecutionDate(date ? toYmd(date) : "")}
                placeholder={t('plannedPage.link.pickDate')}
                allowClear
                clearLabel={t('common.clear')}
              />
              {selectedTxId && (
                <div className="text-xs text-muted-foreground">
                  {t('plannedPage.link.txDate')} {candidateTxs.find((x) => x.id === selectedTxId)?.transaction_date || '—'}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-3 p-3 border rounded-lg bg-muted/30 mt-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="tx-start-date">{t('importPage.startDate')}</Label>
                <DatePicker
                  value={txFilters.start_date ? parseLocalDateFromYmd(txFilters.start_date) : undefined}
                  onChange={(date) => setTxFilters({ ...txFilters, start_date: date ? toYmd(date) : "" })}
                  placeholder={t('plannedPage.link.pickDate')}
                  allowClear
                  clearLabel={t('common.clear')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tx-end-date">{t('importPage.endDate')}</Label>
                <DatePicker
                  value={txFilters.end_date ? parseLocalDateFromYmd(txFilters.end_date) : undefined}
                  onChange={(date) => setTxFilters({ ...txFilters, end_date: date ? toYmd(date) : "" })}
                  placeholder={t('plannedPage.link.pickDate')}
                  allowClear
                  clearLabel={t('common.clear')}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="tx-bank-account">{t('importPage.bankAccount')}</Label>
                <Input id="tx-bank-account" placeholder={t('importPage.bankAccount') || "e.g., Main Account"} value={txFilters.bank_account} onChange={(e) => setTxFilters({ ...txFilters, bank_account: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tx-recipient">{t('recipientsPage.col.recipient')}</Label>
                <Input id="tx-recipient" placeholder={t('recipientsPage.search') || "Partial recipient name"} value={txFilters.recipient_name} onChange={(e) => setTxFilters({ ...txFilters, recipient_name: e.target.value })} />
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Checkbox id="tx-uncategorised" checked={txFilters.uncategorised} onCheckedChange={(v: boolean) => setTxFilters({ ...txFilters, uncategorised: v })} />
                <Label htmlFor="tx-uncategorised">{t('plannedPage.link.uncategorised')}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="tx-active" checked={txFilters.active} onCheckedChange={(v: boolean) => setTxFilters({ ...txFilters, active: v })} />
                <Label htmlFor="tx-active">{t('plannedPage.link.activeOnly')}</Label>
              </div>
              <div className="flex items-center gap-2 ml-4">
                <Checkbox id="tx-match-amount" checked={txFilters.matchAmount} onCheckedChange={(v: boolean) => setTxFilters({ ...txFilters, matchAmount: v })} />
                <Label htmlFor="tx-match-amount">{t('plannedPage.link.matchAmount')}</Label>
                <Input
                  id="tx-amount-tolerance"
                  type="number"
                  className="w-16"
                  value={txFilters.amountTolerancePct}
                  onChange={(e) => setTxFilters({ ...txFilters, amountTolerancePct: Number(e.target.value) })}
                  min={0}
                  step={1}
                  disabled={!txFilters.matchAmount}
                  aria-label={t('importPage.toleranceAriaLabel')}
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto border rounded-md p-2">
            {txLoading ? (
              <div className="text-center py-6">{t('plannedPage.link.loading')}</div>
            ) : filteredCandidates.length === 0 ? (
              <div className="text-sm text-muted-foreground">{t('plannedPage.link.empty')}</div>
            ) : (
              filteredCandidates.map((tx) => (
                <label key={tx.id} className="flex items-center justify-between gap-3 p-2 rounded hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
                  <div className="flex items-center gap-3">
                    <input type="radio" name="selectedTx" checked={selectedTxId === tx.id} onChange={() => { setSelectedTxId(tx.id); setExecutionDate(tx.transaction_date); }} />
                    <div className="flex flex-col">
                      <span className="font-medium">{tx.memo || t('plannedPage.link.txFallback', { id: tx.id })}</span>
                      <span className="text-xs text-muted-foreground">
                        {[tx.recipient_name, tx.transaction_date ? formatDateStringWithAppSettings(tx.transaction_date, appSettings.dateFormat) : null].filter(Boolean).join(' • ')}
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`font-semibold ${tx.amount < 0 ? 'text-destructive' : 'text-accent'}`}>{tx.amount < 0 ? '−' : '+'}{formatDisplayCurrency(Math.abs(tx.amount), tx.currency)}</div>
                    <div className="text-xs text-muted-foreground">#{tx.id}</div>
                  </div>
                </label>
              ))
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>{t('common.cancel')}</Button>
          <Button onClick={handleLinkAndExecute} disabled={actionLoading || !selectedTxId}>
            {t('plannedPage.link.linkAndExecute')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
