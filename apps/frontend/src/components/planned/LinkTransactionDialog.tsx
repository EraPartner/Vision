import { useState, useEffect } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Money } from "@/components/shared/Money";
import { toast } from "sonner";
import logger from "@/lib/logger";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/shared/DatePicker";
import { formatDateStringWithAppSettings, parseLocalDateFromYmd, toYmd } from "@/components/shared/dateUtils";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { apiClient } from "@/lib/api";
import { getRecipient } from "@/lib/api/recipients";
import { cn } from "@/lib/utils";
import type { Transaction } from "@/types/api";
import type { PlannedPayment } from "@/hooks/usePlannedPayments";

interface LinkTransactionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payment: PlannedPayment | null;
  onExecute: (paymentId: number, txId: number, executionDate?: string) => Promise<void>;
}

export function LinkTransactionDialog({ open, onOpenChange, payment, onExecute }: LinkTransactionDialogProps) {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();

  const [txSearchQuery, setTxSearchQuery] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [selectedTxId, setSelectedTxId] = useState<number | null>(null);
  const [txFilters, setTxFilters] = useState({
    start_date: "",
    end_date: "",
    bank_account: "",
    recipient_name: "",
    recipient_id: null as number | null,
    uncategorised: false,
    active: true,
    matchAmount: true,
    amountTolerancePct: 5,
  });

  useEffect(() => {
    if (payment) {
      // Search a window that opens ~2 weeks before the due date: direct debits
      // often post a few days early, and a strict on/after-due-date lower bound
      // hid them entirely. Upper bound stays open so late debits still appear.
      const due = payment.due_date ? parseLocalDateFromYmd(payment.due_date) : undefined;
      const windowStart = due
        ? toYmd(new Date(due.getFullYear(), due.getMonth(), due.getDate() - 14))
        : undefined;
      setTxFilters((prev) => ({
        ...prev,
        recipient_name: payment.recipient || prev.recipient_name,
        recipient_id: null,
        start_date: windowStart || prev.start_date,
        bank_account: payment.bank_account || prev.bank_account,
      }));
    }
  }, [payment]);

  useEffect(() => {
    if (!payment?.recipient_id) return;
    let cancelled = false;
    getRecipient(payment.recipient_id).then((r) => {
      if (cancelled) return;
      const clusterRootId = r.primary_recipient_id ?? r.id;
      setTxFilters((prev) => ({ ...prev, recipient_id: clusterRootId }));
    }).catch(() => { /* fall back to name-based search */ });
    return () => { cancelled = true; };
  }, [payment?.recipient_id]);

  // Debounce the query-key INPUT (not the fetch): txFilters churns at open time
  // (the payment + recipient effects rewrite it), so trail it by 250ms and only
  // let the settled value drive the query. Starts null so the first fetch also
  // waits the full debounce — preserving the deliberate 250ms delay — and resets
  // to null while closed so reopening re-debounces. txSearchQuery is deliberately
  // absent here: it only drives client-side filtering below, never the API.
  const [debouncedFilters, setDebouncedFilters] = useState<typeof txFilters | null>(null);
  useEffect(() => {
    if (!open || !payment) {
      setDebouncedFilters(null);
      return;
    }
    const timer = setTimeout(() => setDebouncedFilters(txFilters), 250);
    return () => clearTimeout(timer);
  }, [open, payment, txFilters]);

  const {
    data: candidateTxs = [],
    isLoading: txLoading,
    isError: txError,
    error: txErrorObj,
  } = useQuery({
    queryKey: ["linkTxCandidates", payment?.id, debouncedFilters],
    enabled: open && !!payment && debouncedFilters !== null,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const f = debouncedFilters!;
      const params: Record<string, string | number | boolean> = { limit: 50 };
      if (f.start_date) params.start_date = f.start_date;
      if (f.end_date) params.end_date = f.end_date;
      if (f.bank_account) params.bank_account = f.bank_account;
      if (f.recipient_id != null) {
        params.recipient_id = f.recipient_id;
      } else if (f.recipient_name) {
        params.recipient_name = f.recipient_name;
      } else if (payment?.recipient) {
        params.recipient_name = payment.recipient;
      }
      if (f.uncategorised) params.uncategorised = true;
      params.active = f.active;

      const res = await apiClient.getTransactions(params);
      return (res.items ?? []) as Transaction[];
    },
  });

  useEffect(() => {
    if (txError) logger.error("Failed to fetch transactions:", txErrorObj);
  }, [txError, txErrorObj]);

  const handleClose = () => {
    onOpenChange(false);
    setSelectedTxId(null);
    setTxSearchQuery("");
    // candidateTxs is now query-cached; closing disables the query
    // (debouncedFilters resets to null) so it re-fetches on reopen.
  };

  const handleLinkAndExecute = async () => {
    if (!payment || !selectedTxId) return;
    // The execution date is the linked transaction's own date — i.e. when the
    // money actually moved. (Falls back to the backend's app-today if absent.)
    const txDate = candidateTxs.find((x) => x.id === selectedTxId)?.transaction_date;
    const execDate = txDate ? (txDate.includes("T") ? txDate.split("T")[0] : txDate) : undefined;
    setActionLoading(true);
    try {
      await onExecute(payment.id, selectedTxId, execDate);
      handleClose();
    } catch (err) {
      logger.error("Failed to link/execute planned payment:", err);
      toast.error(t('plannedPage.link.executeFailed', { msg: (err as Error).message }));
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
          <DialogTitle>{t('plannedPage.link.title', { name: payment?.name ?? '' })}</DialogTitle>
          {payment?.due_date && (
            <DialogDescription>
              {t('plannedPage.link.dueOn', { date: formatDateStringWithAppSettings(payment.due_date, appSettings.dateFormat) })}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <Input placeholder={t('plannedPage.link.searchPlaceholder')} value={txSearchQuery} onChange={(e) => setTxSearchQuery(e.target.value)} />

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
                <Input id="tx-recipient" placeholder={t('recipientsPage.search') || "Partial recipient name"} value={txFilters.recipient_name} onChange={(e) => setTxFilters({ ...txFilters, recipient_name: e.target.value, recipient_id: null })} />
                {txFilters.recipient_id != null && (
                  <p className="text-xs text-muted-foreground">{t('plannedPage.link.includesLinked')}</p>
                )}
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
                <label key={tx.id} className="flex items-center justify-between gap-3 p-2 rounded-md hover:bg-muted/50 cursor-pointer">
                  <div className="flex items-center gap-3">
                    <input type="radio" name="selectedTx" checked={selectedTxId === tx.id} onChange={() => setSelectedTxId(tx.id)} />
                    <div className="flex flex-col">
                      <span className="font-medium">{tx.memo || t('plannedPage.link.txFallback', { id: tx.id })}</span>
                      <span className="text-xs text-muted-foreground">
                        {[tx.recipient_name, tx.transaction_date ? formatDateStringWithAppSettings(tx.transaction_date, appSettings.dateFormat) : null].filter(Boolean).join(' • ')}
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={cn('font-semibold', tx.amount < 0 ? 'text-loss' : 'text-gain')}>{tx.amount < 0 ? '−' : '+'}<Money amount={Math.abs(tx.amount)} currency={tx.currency} /></div>
                    <div className="text-xs text-muted-foreground">#{tx.id}</div>
                  </div>
                </label>
              ))
            )}
          </div>

          {selectedTxId && (
            <p className="text-xs text-muted-foreground">
              {t('plannedPage.link.recordedOn', { date: (() => { const d = candidateTxs.find((x) => x.id === selectedTxId)?.transaction_date; return d ? formatDateStringWithAppSettings(d, appSettings.dateFormat) : '—'; })() })}
            </p>
          )}
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
