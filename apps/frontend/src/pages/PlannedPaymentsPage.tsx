import { useState, useMemo, useCallback } from "react";
import { safeHref } from "@/utils/safeHref";
import { useQueryClient } from "@tanstack/react-query";
import { Money } from "@/components/shared/Money";
import logger from "@/lib/logger";
import { Plus, CalendarClock, Repeat, Trash2, Pencil, ToggleLeft, ToggleRight, AlertCircle, CheckCircle2, Circle, Eye, EyeOff, History } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import { RecurringDetectionPanel } from "@/features/planned/RecurringDetectionPanel";
import { NextSevenDaysStrip } from "@/features/planned/NextSevenDaysStrip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { VirtualDataTable } from "@/components/shared/VirtualDataTable";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import PlannedPaymentForm from "@/features/planned/PlannedPaymentForm";
import { LinkTransactionDialog } from "@/features/planned/LinkTransactionDialog";
import { MatchSuggestionsBanner } from "@/features/planned/MatchSuggestionsBanner";
import { plannedKeys } from "@/lib/queryKeys";
import { ExecutionHistoryDialog } from "@/features/planned/ExecutionHistoryDialog";
import { differenceInDays, formatDateStringWithAppSettings, toYmd } from "@/components/shared/dateUtils";
import { usePlannedPayments, type PlannedPayment } from "@/hooks/usePlannedPayments";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from '@/contexts/LanguageContext';
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { cn } from "@/lib/utils";

const FREQ_LABEL_KEYS: Record<string, string> = {
  daily: 'plannedPage.freq.daily',
  weekly: 'plannedPage.freq.weekly',
  biweekly: 'plannedPage.freq.biweekly',
  monthly: 'plannedPage.freq.monthly',
  quarterly: 'plannedPage.freq.quarterly',
  yearly: 'plannedPage.freq.yearly',
  custom: 'plannedPage.freq.custom',
};


type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

function dueBadge(t: TranslateFn, dateFormat: string, dateStr?: string | null) {
  if (!dateStr || typeof dateStr !== "string") {
    return <Badge variant="secondary">{t('plannedPage.due.noDate')}</Badge>;
  }

  const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
  const [year, month, day] = datePart.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return <Badge variant="secondary">{t('plannedPage.due.invalid')}</Badge>;
  }

  const today = new Date();
  const normalizedToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
  const normalizedDue = new Date(year, month - 1, day, 0, 0, 0, 0);
  const days = differenceInDays(normalizedDue, normalizedToday);

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

type TableRow = PlannedPayment & { _idx: number } & Record<string, unknown>;

export default function PlannedPaymentsPage() {
  const { t } = useLanguage();
  const loadingSurfaceProps = useLoadingSurfaceProps();
  const { appSettings } = useAppSettings();
  const { convertToTarget } = useCurrencyConverter(appSettings.defaultCurrency || "EUR");

  const [showAll, setShowAll] = useState(false);
  const { payments, addPayment, updatePayment, deletePayment, toggleActive, executePayment, loading, error } = usePlannedPayments(showAll);
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PlannedPayment | undefined>();
  // Bumped on every "New" open so the create form's key changes and it
  // remounts blank — a constant "new" key kept all useState initializers
  // (name, amount, the direction toggle, …) from the previous create.
  const [createFormKey, setCreateFormKey] = useState(0);
  const [actionLoading, setActionLoading] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [paymentToLink, setPaymentToLink] = useState<PlannedPayment | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const queryClient = useQueryClient();

  // Open the link dialog for a suggested planned payment so the user can
  // confirm which transaction clears it.
  const handleReviewSuggestion = useCallback((plannedId: number) => {
    const payment = payments.find((p) => p.id === plannedId);
    if (!payment) return;
    setPaymentToLink(payment);
    setLinkDialogOpen(true);
  }, [payments]);

  // After a manual/confirmed execute, refresh both the payments list and the
  // match suggestions (the cleared pair must drop off the suggestions banner).
  const handleExecute = useCallback(async (id: number, transactionId: number, executionDate?: string) => {
    await executePayment(id, transactionId, executionDate);
    await queryClient.invalidateQueries({ queryKey: plannedKeys.matchSuggestions });
  }, [executePayment, queryClient]);

  const filteredPayments = useMemo(() => {
    if (showAll) return payments;
    return payments.filter((p) => p.is_active);
  }, [payments, showAll]);

  const rows: TableRow[] = useMemo(() => filteredPayments.map((p, i) => ({ ...p, _idx: i })), [filteredPayments]);

  const totalMonthly = useMemo(() => {
    return payments
      // "Est. monthly" = net monthly impact of recurring rows: incoming
      // (amount > 0) and outgoing (amount < 0) both counted, signed, so e.g.
      // +70 income and -100 expense net to -30.
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
        // Convert each row's amount to the display currency before summing —
        // raw summation counted a 500 USD subscription as 500 in the default currency.
        return sum + convertToTarget(p.amount, p.currency) * mult;
      }, 0);
  }, [payments, convertToTarget]);

  // The "due in the next 7 days" window now lives in NextSevenDaysStrip
  // (bucketNextSevenDays), which carries the same is_active filter, the same
  // local-midnight Y-M-D parse and the same 0…7-day span the old "Due this
  // week" tile used.

  const columns = [
    {
      key: "is_executed",
      header: "",
      editable: false,
      defaultWidth: 52,
      render: (row: TableRow) => (
        <Button
          variant="ghost"
          size="icon"
          className={cn("icon-touch-target", row.is_executed ? "text-accent hover:text-accent" : "text-muted-foreground hover:text-foreground")}
          onClick={(e) => {
            e.stopPropagation();
            if (!row.is_executed) {
              setPaymentToLink(row);
              setLinkDialogOpen(true);
            }
          }}
          disabled={actionLoading || !row.is_active || row.is_executed}
          title={row.is_executed ? t('plannedPage.execute.linked', { n: row.executed_transaction_id ?? 0 }) : t('plannedPage.execute.button')}
        >
          {row.is_executed ? <CheckCircle2 className="h-5 w-5" /> : <Circle className="h-5 w-5" />}
        </Button>
      ),
    },
    {
      key: "name",
      // Flexible like the category column: name + category share the leftover
      // width so neither is cramped while the rest stay sized to their content.
      header: t('plannedPage.col.payment'),
      editable: false,
      minWidth: 180,
      render: (row: TableRow) => {
        // Gate on the resolved href, not on `row.url`: a URL safeHref rejects
        // used to still render this icon with its "Open related link" tooltip
        // and hover colour, pointing at nothing.
        const rowHref = safeHref(row.url);
        return (
        <div className="flex flex-col gap-0.5">
          <div className={cn("font-medium flex items-center gap-2", !row.is_active ? "text-muted-foreground line-through" :
            row.is_executed ? "text-muted-foreground line-through" :
              "text-foreground")}>
              <span>{row.name}</span>
              {row.is_loan && (
                <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">{t('plannedPage.loanBadge')}</Badge>
              )}
              {rowHref && (
                <a href={rowHref} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={t('plannedPage.openLink')} className="text-muted-foreground hover:text-primary">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 010 5.656l-1.414 1.414a4 4 0 01-5.656-5.656l1.414-1.414" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7h6v6" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 3l-6 6" />
                  </svg>
                </a>
              )}
          </div>
          {row.recipient && (
            <span className="text-xs text-muted-foreground">→ {row.recipient}</span>
          )}
        </div>
        );
      },
    },
    {
      key: "amount",
      header: t('plannedPage.col.amount'),
      editable: false,
      defaultWidth: 120,
      render: (row: TableRow) => (
        <span className={cn("font-semibold tabular-nums", row.amount < 0 ? "text-loss" : "text-gain")}>
          {row.amount < 0 ? "−" : "+"}<Money amount={Math.abs(row.amount)} currency={row.currency} />
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
              {(row.execution_count ?? 0) > 0 && (
                <span className="text-xs text-muted-foreground">{t('plannedPage.executedCount', { n: row.execution_count ?? 0 })}</span>
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
            {(row.execution_count ?? 0) > 0 && (
              <span className="text-xs text-muted-foreground">
                {t('plannedPage.executedCount', { n: row.execution_count ?? 0 })}
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
      // No defaultWidth: this is the flexible column, so it absorbs the
      // remaining table width (auto-fit) — category labels are the longest cell
      // and were overflowing the old fixed 120px.
      header: t('plannedPage.col.category'),
      editable: false,
      minWidth: 140,
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
      defaultWidth: 130,
      render: (row: TableRow) => (
        <Button
          variant="ghost"
          size="sm"
          className={cn("gap-1.5", row.is_active ? "text-accent hover:text-accent" : "text-muted-foreground hover:text-foreground")}
          onClick={async (e) => {
            e.stopPropagation();
            setActionLoading(true);
            try {
              await toggleActive(row.id);
            } catch (err) {
              logger.error("Failed to toggle status:", err);
              toast.error(t('plannedPage.toggleFailed'));
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
      defaultWidth: 96,
      render: (row: TableRow) => (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="icon-touch-target text-muted-foreground hover:text-primary hover:bg-primary/10"
            onClick={(e) => { e.stopPropagation(); setEditing(row); setFormOpen(true); }}
            disabled={actionLoading}
            aria-label={t('aria.editPlannedPayment')}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="icon-touch-target text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            aria-label={t('aria.deletePlannedPayment')}
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
                  toast.error(t('plannedPage.deleteFailed'));
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
      toast.error(t('plannedPage.saveFailed', { msg: apiErrorToMessage(err, t) }));
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div {...loadingSurfaceProps} className="space-y-8">
        <PageHeader title={t('plannedPage.title')} subtitle={t('plannedPage.subtitle')} icon={CalendarClock} />
        {/* Mirrors NextSevenDaysStrip: caption row + est-monthly side figure,
            then the eight day columns — the shape the page actually settles
            into, not a four-tile row it no longer has. */}
        <Card className="glass-elevated">
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-4 w-56" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-3 w-20 ml-auto" />
                <Skeleton className="h-7 w-24 ml-auto" />
              </div>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
              {[...Array(8)].map((_, i) => (
                <Skeleton key={i} className="h-[6.5rem] w-full rounded-[0.625rem]" />
              ))}
            </div>
          </CardContent>
        </Card>
        <Skeleton className="h-[300px] w-full rounded-xl" />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-8">
        <div className="flex items-start justify-between">
          <PageHeader title={t('plannedPage.title')} subtitle={t('plannedPage.subtitle')} icon={CalendarClock} />
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setHistoryOpen(true)}
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
            <Button onClick={() => { setEditing(undefined); setCreateFormKey((k) => k + 1); setFormOpen(true); }} className="gap-2">
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

        <NextSevenDaysStrip
          payments={payments}
          estimatedMonthly={totalMonthly}
          convertAmount={convertToTarget}
          onSelect={(payment) => { setEditing(payment); setFormOpen(true); }}
        />

        <MatchSuggestionsBanner onReview={handleReviewSuggestion} />

        <RecurringDetectionPanel />

        <VirtualDataTable
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
          loading={actionLoading}
          key={editing?.id ?? `new-${createFormKey}`}
        />

        <LinkTransactionDialog
          open={linkDialogOpen}
          onOpenChange={(open) => { setLinkDialogOpen(open); if (!open) setPaymentToLink(null); }}
          payment={paymentToLink}
          onExecute={handleExecute}
        />

        <ExecutionHistoryDialog
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          payments={payments}
        />
      </div>
      <ConfirmDialog />
    </>
  );
}
