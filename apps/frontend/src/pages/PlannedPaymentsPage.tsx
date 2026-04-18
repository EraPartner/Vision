import { useState, useMemo, useEffect } from "react";
import { format, differenceInDays } from "date-fns";
import logger from "@/lib/logger";
import { Plus, CalendarClock, Repeat, Trash2, Pencil, ToggleLeft, ToggleRight, AlertCircle, CheckCircle2, Circle, Eye, EyeOff, History, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { RecurringDetectionPanel } from "@/components/planned/RecurringDetectionPanel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/shared/DataTable";
import { Alert, AlertDescription } from "@/components/ui/alert";
import PlannedPaymentForm from "@/components/planned/PlannedPaymentForm";
import { DatePicker } from "@/components/shared/DatePicker";
import { formatDateStringWithAppSettings, parseLocalDateFromYmd, toYmd } from "@/components/shared/dateUtils";
import { usePlannedPayments, type PlannedPayment } from "@/hooks/usePlannedPayments";
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api";
import type { Transaction } from "@/types/api";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { formatCurrency } from "@/utils/currency";
import { numberFormatToLocale } from "@/utils/currency";
import { useNavigate } from "react-router-dom";

// map frequency -> translation key (use inside component with t())
const FREQ_LABEL_KEYS: Record<string, string> = {
  daily: 'plannedPage.freq.daily',
  weekly: 'plannedPage.freq.weekly',
  biweekly: 'plannedPage.freq.biweekly',
  monthly: 'plannedPage.freq.monthly',
  quarterly: 'plannedPage.freq.quarterly',
  yearly: 'plannedPage.freq.yearly',
  custom: 'plannedPage.freq.custom',
};

const LOAN_TYPE_LABEL_KEYS: Record<string, string> = {
  amortizing: 'plannedPage.loanType.amortizing',
  fixed_principal: 'plannedPage.loanType.fixedPrincipal',
  interest_only: 'plannedPage.loanType.interestOnly',
};

type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

function dueBadge(t: TranslateFn, dateFormat: string, dateStr?: string | null) {
  if (!dateStr || typeof dateStr !== "string") {
    return <Badge variant="secondary">{t('plannedPage.due.noDate')}</Badge>;
  }

  // Handle both YYYY-MM-DD and ISO datetime formats (e.g., "2025-01-15T00:00:00Z")
  // Extract just the date portion if it's a datetime string
  const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;

  // Parse the date string (YYYY-MM-DD) explicitly
  const [year, month, day] = datePart.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return <Badge variant="secondary">{t('plannedPage.due.invalid')}</Badge>;
  }

  // Get today's date at midnight in local time
  const today = new Date();
  const normalizedToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);

  // Create due date at midnight in local time
  const normalizedDue = new Date(year, month - 1, day, 0, 0, 0, 0);

  // Calculate the difference in days using normalized dates
  const days = differenceInDays(normalizedDue, normalizedToday);

  // Calculate if it's the same day
  if (days === 0) {
    return <Badge className="bg-chart-3/20 text-chart-3 border-chart-3/30">{t('plannedPage.due.today')}</Badge>;
  }

  if (days < 0) {
    return <Badge variant="destructive">{t('plannedPage.due.overdue')}</Badge>;
  }
  if (days === 1) {
    return <Badge className="bg-chart-5/20 text-chart-5 border-chart-5/30">{t('plannedPage.due.tomorrow')}</Badge>;
  }
  if (days <= 7) {
    return <Badge className="bg-chart-5/20 text-chart-5 border-chart-5/30">{t('plannedPage.due.inDays', { n: days })}</Badge>;
  }
  return <Badge variant="secondary">{formatDateStringWithAppSettings(toYmd(normalizedDue), dateFormat)}</Badge>;
}

type TableRow = PlannedPayment & { _idx: number };

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

export default function PlannedPaymentsPage() {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const formatDisplayCurrency = (amount: number, currency?: string) =>
    formatCurrency(amount, currency || appSettings.defaultCurrency, locale);
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);
  const { payments, addPayment, updatePayment, deletePayment, toggleActive, executePayment, loading, error } = usePlannedPayments(showAll);
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PlannedPayment | undefined>();
  const [actionLoading, setActionLoading] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [paymentToLink, setPaymentToLink] = useState<PlannedPayment | null>(null);
  const [txSearchQuery, setTxSearchQuery] = useState("");
  const [candidateTxs, setCandidateTxs] = useState<Transaction[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const [selectedTxId, setSelectedTxId] = useState<number | null>(null);
  const [executionDate, setExecutionDate] = useState<string>(() => format(new Date(), 'yyyy-MM-dd'));
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [executionHistory, setExecutionHistory] = useState<ExecutionHistoryItem[]>([]);

  // Filter payments based on showAll state (for client-side filtering after local updates)
  const filteredPayments = useMemo(() => {
    if (showAll) {
      return payments;
    }
    return payments.filter((p) => p.is_active);
  }, [payments, showAll]);

  const rows: TableRow[] = useMemo(() => filteredPayments.map((p, i) => ({ ...p, _idx: i })), [filteredPayments]);

  const totalMonthly = useMemo(() => {
    return payments
      .filter((p) => p.is_active && p.is_recurring)
      .reduce((sum, p) => {
        const mult =
          p.frequency === "daily" ? 30 :
            p.frequency === "weekly" ? 4.33 :
              p.frequency === "biweekly" ? 2.17 :
                p.frequency === "monthly" ? 1 :
                  p.frequency === "quarterly" ? 1 / 3 :
                    p.frequency === "yearly" ? 1 / 12 :
                      p.frequency === "custom" && p.custom_interval_days ? 30 / p.custom_interval_days : 1;
        return sum + Math.abs(p.amount) * mult;
      }, 0);
  }, [payments]);

  const upcoming = useMemo(() => {
    const today = new Date();
    const normalizedToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);

    return payments
      .filter((p) => p.is_active)
      .filter((p) => {
        if (!p.due_date || typeof p.due_date !== "string") {
          return false;
        }

        // Handle both YYYY-MM-DD and ISO datetime formats
        const datePart = p.due_date.includes('T') ? p.due_date.split('T')[0] : p.due_date;
        const [year, month, day] = datePart.split('-').map(Number);
        if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
          return false;
        }

        const normalizedDue = new Date(year, month - 1, day, 0, 0, 0, 0);

        const days = differenceInDays(normalizedDue, normalizedToday);
        return days >= 0 && days <= 7; // Due within the next 7 days (including today)
      }).length;
  }, [payments]);

  const executed = useMemo(() => {
    return payments.filter((p) => p.is_executed).length;
  }, [payments]);

  const pending = useMemo(() => {
    return payments.filter((p) => p.is_active && !p.is_executed).length;
  }, [payments]);

  const loadExecutionHistory = async () => {
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
        links.map(async (link) => {
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
        .filter((result): result is PromiseFulfilledResult<ExecutionHistoryItem | null> => result.status === 'fulfilled')
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
  };

  const columns = [
    {
      key: "is_executed",
      header: "",
      editable: false,
      className: "w-12",
      render: (row: TableRow) => (
        <Button
          variant="ghost"
          size="icon"
          className={`icon-touch-target ${row.is_executed ? "text-accent hover:text-accent" : "text-muted-foreground hover:text-foreground"}`}
            onClick={async (e) => {
              e.stopPropagation();

              if (!row.is_executed) {
              // Open dialog to select transaction
              setPaymentToLink(row);
              // reset dialog state
              setSelectedTxId(null);
              setTxSearchQuery("");
              setExecutionDate(format(new Date(), 'yyyy-MM-dd'));
              setCandidateTxs([]);
              setLinkDialogOpen(true);
            }
          }}
            disabled={actionLoading || !row.is_active || row.is_executed}
            title={row.is_executed ? t('plannedPage.execute.linked', { n: row.executed_transaction_id }) : t('plannedPage.execute.button')}
          >
          {row.is_executed ? <CheckCircle2 className="h-5 w-5" /> : <Circle className="h-5 w-5" />}
        </Button>
      ),
    },
    {
      key: "name",
      header: t('plannedPage.col.payment'),
      editable: false,
      defaultWidth: 180,
      render: (row: TableRow) => (
        <div className="flex flex-col gap-0.5">
          <span className={`font-medium ${!row.is_active ? "text-muted-foreground line-through" :
            row.is_executed ? "text-muted-foreground line-through" :
              "text-foreground"
            }`}>
            <div className="flex items-center gap-2">
              <span>{row.name}</span>
              {row.is_loan && (
                <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">{t('plannedPage.loanBadge')}</Badge>
              )}
              {row.url && (
                <a href={row.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={t('plannedPage.openLink')} className="text-muted-foreground hover:text-primary">
                  {/* small link icon */}
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 010 5.656l-1.414 1.414a4 4 0 01-5.656-5.656l1.414-1.414" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7h6v6" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 3l-6 6" />
                  </svg>
                </a>
              )}
            </div>
          </span>
          {row.recipient && (
            <span className="text-xs text-muted-foreground">→ {row.recipient}</span>
          )}
        </div>
      ),
    },
    {
      key: "amount",
      header: t('plannedPage.col.amount'),
      editable: false,
      defaultWidth: 120,
      render: (row: TableRow) => (
        <span className={`font-semibold tabular-nums ${row.amount < 0 ? "text-destructive" : "text-accent"}`}>
          {row.amount < 0 ? "−" : "+"}{formatDisplayCurrency(Math.abs(row.amount), row.currency)}
        </span>
      ),
    },
    {
      key: "due_date",
      header: t('plannedPage.col.dueDate'),
      editable: false,
      defaultWidth: 130,
      render: (row: TableRow) => dueBadge(t, appSettings.dateFormat, row.due_date),
    },
    {
      key: "is_recurring",
      header: t('plannedPage.col.recurrence'),
      editable: false,
      defaultWidth: 160,
      render: (row: TableRow) => {
        if (row.is_loan && row.loan_term_months) {
          return (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <Repeat className="h-3.5 w-3.5 text-primary" />
                <span className="text-sm">{`loan(${row.loan_term_months} months)`}</span>
              </div>
              {row.execution_count > 0 && (
                <span className="text-xs text-muted-foreground">{t('plannedPage.executedCount', { n: row.execution_count })}</span>
              )}
            </div>
          );
        }

        return row.is_recurring ? (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <Repeat className="h-3.5 w-3.5 text-primary" />
              <span className="text-sm">
                 {row.frequency === "custom" && row.custom_interval_days
                   ? t('plannedPage.everyNDays', { n: row.custom_interval_days })
                   : t(FREQ_LABEL_KEYS[row.frequency ?? "monthly"])}
              </span>
            </div>
            {row.execution_count > 0 && (
               <span className="text-xs text-muted-foreground">
                 {t('plannedPage.executedCount', { n: row.execution_count })}
               </span>
             )}
          </div>
        ) : (
            <span className="text-sm text-muted-foreground">{t('plannedPage.oneTime')}</span>
        );
      },
    },
    
    {
      key: "category",
      header: t('plannedPage.col.category'),
      editable: false,
      defaultWidth: 120,
      render: (row: TableRow) => {
        const categoryLabel = typeof row.category === "string"
          ? row.category
          : row.category != null
            ? String(row.category)
            : "";

        return categoryLabel ? (
          <Badge variant="outline" className="font-medium">{categoryLabel}</Badge>
        ) : (
          <span className="text-muted-foreground text-sm">—</span>
        );
      },
    },
    {
      key: "is_active",
      header: t('plannedPage.col.status'),
      editable: false,
      defaultWidth: 100,
      render: (row: TableRow) => (
        <Button
          variant="ghost"
          size="sm"
          className={`gap-1.5 ${row.is_active ? "text-accent hover:text-accent" : "text-muted-foreground hover:text-foreground"}`}
          onClick={async (e) => {
            e.stopPropagation();
            setActionLoading(true);
            try {
              await toggleActive(row.id);
            } catch (err) {
              logger.error("Failed to toggle status:", err);
            } finally {
              setActionLoading(false);
            }
          }}
          disabled={actionLoading}
        >
          {row.is_active ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
          {row.is_active ? t('plannedPage.statusActive') : t('plannedPage.statusPaused')}
        </Button>
      ),
    },
    {
      key: "actions",
      header: "",
      editable: false,
      className: "w-20",
      render: (row: TableRow) => (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="icon-touch-target text-muted-foreground hover:text-primary hover:bg-primary/10"
            onClick={(e) => { e.stopPropagation(); setEditing(row); setFormOpen(true); }}
            disabled={actionLoading}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="icon-touch-target text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            onClick={async (e) => {
              e.stopPropagation();
              const ok = await confirm({
                title: t('plannedPage.delete.title'),
                description: t('plannedPage.delete.desc'),
                confirmLabel: t('plannedPage.delete.confirm'),
                variant: "destructive",
              });
              if (ok) {
                setActionLoading(true);
                try {
                  await deletePayment(row.id);
                } catch (err) {
                  logger.error("Failed to delete payment:", err);
                } finally {
                  setActionLoading(false);
                }
              }
            }}
            disabled={actionLoading}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  const handleSubmit = async (data: Omit<PlannedPayment, "id" | "created_at">) => {
    try {
      setActionLoading(true);
      if (editing) {
        await updatePayment(editing.id, data);
        setEditing(undefined);
      } else {
        await addPayment(data);
      }
      setFormOpen(false);
    } catch (err) {
      logger.error("Failed to save payment:", err);
      alert(t('plannedPage.saveFailed'));
    } finally {
      setActionLoading(false);
    }
  };

  // Fetch transactions when dialog opens or filters/search change (debounced)
  useEffect(() => {
    let isMounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchTransactions = async () => {
      if (!linkDialogOpen || !paymentToLink) return;
      setTxLoading(true);
      try {
        const params: Record<string, string | number | boolean> = { limit: 50 };
        if (txFilters.start_date) params.start_date = txFilters.start_date;
        if (txFilters.end_date) params.end_date = txFilters.end_date;
        if (txFilters.bank_account) params.bank_account = txFilters.bank_account;
        // If recipient filter empty, but paymentToLink has recipient, default to that
        if (txFilters.recipient_name) params.recipient_name = txFilters.recipient_name;
        else if (paymentToLink.recipient) params.recipient_name = paymentToLink.recipient;
        if (txFilters.uncategorised) params.uncategorised = true;
        // active defaults to true unless explicitly set false
        params.active = txFilters.active;

        // Include bank_account if user filled it
        if (txFilters.bank_account) params.bank_account = txFilters.bank_account;
        const res = await apiClient.getTransactions(params);
        if (isMounted) {
          setCandidateTxs(res.items || []);
        }
      } catch (err) {
        logger.error("Failed to fetch transactions:", err);
        if (isMounted) setCandidateTxs([]);
      } finally {
        if (isMounted) setTxLoading(false);
      }
    };

    // Debounce requests when filters/search change
    if (linkDialogOpen && paymentToLink) {
      timer = setTimeout(fetchTransactions, 250);
    }

    return () => {
      isMounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [linkDialogOpen, paymentToLink, txFilters, txSearchQuery]);

  // Keep recipient_name filter synced to selected payment by default
  useEffect(() => {
    if (paymentToLink) {
      setTxFilters((prev) => ({
        ...prev,
        recipient_name: paymentToLink.recipient || prev.recipient_name,
        // default the start_date to the projected due date of the planned payment
        start_date: paymentToLink.due_date || prev.start_date,
        // default the visible bank_account input to the payment's bank account
        bank_account: paymentToLink.bank_account || prev.bank_account,
      }));
    }
  }, [paymentToLink]);

  if (loading) {
    return (
      <div className="space-y-8 animate-in">
        <PageHeader title={t('plannedPage.title')} subtitle={t('plannedPage.subtitle')} icon={CalendarClock} />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i} className="border-none shadow-md">
              <CardHeader className="pb-2"><Skeleton className="h-4 w-24" /></CardHeader>
              <CardContent><Skeleton className="h-8 w-20" /></CardContent>
            </Card>
          ))}
        </div>
        <Skeleton className="h-[300px] w-full rounded-xl" />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-8 animate-in">
        <div className="flex items-start justify-between">
            <PageHeader title={t('plannedPage.title')} subtitle={t('plannedPage.subtitle')} icon={CalendarClock} />
          <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  setHistoryOpen(true);
                  await loadExecutionHistory();
                }}
                className="gap-1.5"
              >
                <History className="h-4 w-4" />
                {t('plannedPage.history.button')}
              </Button>
              <Button
                variant={showAll ? "secondary" : "outline"}
                size="sm"
                onClick={() => setShowAll(!showAll)}
                className="gap-1.5"
              >
                {showAll ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                {showAll ? t('plannedPage.showingAll') : t('plannedPage.activeOnly')}
              </Button>
              <Button onClick={() => { setEditing(undefined); setFormOpen(true); }} className="gap-2">
                <Plus className="h-4 w-4" />
                {t('plannedPage.newPayment')}
              </Button>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
              <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t('plannedPage.pending')}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{pending}</p>
            </CardContent>
          </Card>
          <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
              <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-accent/20 to-accent/5 text-accent ring-1 ring-accent/15">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                </span>
                {t('plannedPage.executed')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-accent">{executed}</p>
            </CardContent>
          </Card>
          <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
              <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-primary/20 to-primary/5 text-primary ring-1 ring-primary/15">
                  <Repeat className="h-3.5 w-3.5" />
                </span>
                {t('plannedPage.estMonthly')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold tabular-nums">{formatDisplayCurrency(totalMonthly)}</p>
            </CardContent>
          </Card>
          <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
              <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-accent/20 to-accent/5 text-accent ring-1 ring-accent/15">
                  <CalendarClock className="h-3.5 w-3.5" />
                </span>
                {t('plannedPage.dueThisWeek')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{upcoming}</p>
            </CardContent>
          </Card>
        </div>

        {/* Recurring Pattern Detection */}
        <RecurringDetectionPanel />

        <DataTable
          title={t('plannedPage.tableTitle')}
          subtitle={t('plannedPage.tableSubtitle', { n: payments.length })}
          columns={columns}
          data={rows}
          emptyMessage={t('plannedPage.empty')}
        />

        <PlannedPaymentForm
          open={formOpen}
          onOpenChange={(open) => { setFormOpen(open); if (!open) setEditing(undefined); }}
          onSubmit={handleSubmit}
          initial={editing}
          key={editing?.id ?? "new"}
        />

        {/* Link Transaction Dialog: choose an existing transaction to link as execution */}
        <Dialog open={linkDialogOpen} onOpenChange={(open) => { setLinkDialogOpen(open); if (!open) setPaymentToLink(null); }}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t('plannedPage.link.title', { name: paymentToLink?.name })}</DialogTitle>
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
                  {/* Show the selected transaction's date for clarity when a tx is selected */}
                  {selectedTxId && (
                    <div className="text-xs text-muted-foreground">
                      {t('plannedPage.link.txDate')} {candidateTxs.find((x) => x.id === selectedTxId)?.transaction_date || '—'}
                    </div>
                  )}
                </div>
              </div>

              {/* Transaction filters (mirrors export filters) */}
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
                ) : (
                  (candidateTxs.length === 0) ? (
                    <div className="text-sm text-muted-foreground">{t('plannedPage.link.empty')}</div>
                  ) : (
                    candidateTxs
                      .filter(tx => {
                        if (txSearchQuery) {
                          const q = txSearchQuery.toLowerCase();
                          if (!((tx.memo || "").toLowerCase().includes(q) || (tx.recipient_name || "").toLowerCase().includes(q) || String(tx.amount).includes(q))) {
                            return false;
                          }
                        }
                        if (txFilters.matchAmount && paymentToLink && typeof paymentToLink.amount === 'number') {
                          const planned = Math.abs(paymentToLink.amount);
                          const txAmt = Math.abs(tx.amount);
                          const tol = Math.max(1, planned * (txFilters.amountTolerancePct / 100));
                          if (Math.abs(txAmt - planned) > tol) return false;
                        }
                        return true;
                      })
                      .map((tx) => (
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
                  )
                )}
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => { setLinkDialogOpen(false); setPaymentToLink(null); }}>{t('common.cancel')}</Button>
              <Button
                onClick={async () => {
                  if (!paymentToLink) return;
                  if (!selectedTxId) { alert(t('plannedPage.link.selectTx')); return; }
                  setActionLoading(true);
                  try {
                    await executePayment(paymentToLink.id, selectedTxId, executionDate || undefined);
                    setLinkDialogOpen(false);
                    setPaymentToLink(null);
                  } catch (err) {
                    logger.error('Failed to link/execute planned payment:', err);
                    alert(t('plannedPage.link.executeFailed'));
                  } finally {
                    setActionLoading(false);
                  }
                }}
                disabled={actionLoading || !selectedTxId}
              >
                {t('plannedPage.link.linkAndExecute')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
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
                    <div key={`${item.plannedPaymentId}-${item.transactionId}-${item.executionDate}`} className="grid grid-cols-12 gap-3 border-b px-3 py-2 text-sm last:border-b-0">
                      <div className="col-span-2 text-muted-foreground">{formatDateStringWithAppSettings(item.executionDate, appSettings.dateFormat) || '—'}</div>
                      <div className="col-span-3 font-medium">{item.plannedPaymentName}</div>
                      <div className="col-span-5 min-w-0">
                        <div className="truncate">{item.memo || t('plannedPage.link.txFallback', { id: item.transactionId })}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {[item.recipientName, item.categoryName, formatDateStringWithAppSettings(item.transactionDate, appSettings.dateFormat)].filter(Boolean).join(' • ')}
                        </div>
                      </div>
                      <div className="col-span-2 flex items-center justify-end gap-2">
                        <span className={`tabular-nums font-semibold ${item.amount < 0 ? 'text-destructive' : 'text-accent'}`}>
                          {item.amount < 0 ? '−' : '+'}{formatDisplayCurrency(Math.abs(item.amount), item.currency)}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="icon-touch-target"
                          title={t('plannedPage.history.openTransaction')}
                          onClick={() => {
                            setHistoryOpen(false);
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
              <Button variant="outline" onClick={() => setHistoryOpen(false)}>{t('common.close')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

      </div>
      <ConfirmDialog />
    </>
  );
}
