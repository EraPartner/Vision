import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Eye, EyeOff, History, Plus } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { ExecutionHistoryDialog } from "@/features/planned/ExecutionHistoryDialog";
import { LinkTransactionDialog } from "@/features/planned/LinkTransactionDialog";
import { MatchSuggestionsBanner } from "@/features/planned/MatchSuggestionsBanner";
import { NextSevenDaysStrip } from "@/features/planned/NextSevenDaysStrip";
import PlannedPaymentForm from "@/features/planned/PlannedPaymentForm";
import { PlannedPaymentsTable } from "@/features/planned/PlannedPaymentsTable";
import { RecurringDetectionPanel } from "@/features/planned/RecurringDetectionPanel";
import { sumConvertedMonthlyAmounts } from "@/features/planned/plannedCurrencyTotals";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { usePlannedPayments, type PlannedPayment } from "@/hooks/usePlannedPayments";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import logger from "@/lib/logger";
import { plannedKeys } from "@/lib/queryKeys";

export default function PlannedPaymentsPage() {
  const { t } = useLanguage();
  const loadingSurfaceProps = useLoadingSurfaceProps();
  const { appSettings } = useAppSettings();
  const {
    convertToTargetIfAvailable,
    isLoading: currencyRatesLoading,
  } = useCurrencyConverter(appSettings.defaultCurrency || "EUR");

  const [showAll, setShowAll] = useState(false);
  const {
    payments,
    addPayment,
    updatePayment,
    deletePayment,
    toggleActive,
    executePayment,
    loading,
    error,
    refetch,
  } = usePlannedPayments(showAll);
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PlannedPayment | undefined>();
  // Bumped on every "New" open so the create form's key changes and it
  // remounts blank instead of retaining the previous create form's state.
  const [createFormKey, setCreateFormKey] = useState(0);
  const [actionLoading, setActionLoading] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [paymentToLink, setPaymentToLink] = useState<PlannedPayment | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const queryClient = useQueryClient();

  const handleReviewSuggestion = useCallback((plannedId: number) => {
    const payment = payments.find((candidate) => candidate.id === plannedId);
    if (!payment) return;
    setPaymentToLink(payment);
    setLinkDialogOpen(true);
  }, [payments]);

  const handleExecute = useCallback(async (
    id: number,
    transactionId: number,
    executionDate?: string,
  ) => {
    await executePayment(id, transactionId, executionDate);
    await queryClient.invalidateQueries({ queryKey: plannedKeys.matchSuggestions });
  }, [executePayment, queryClient]);

  const filteredPayments = useMemo(
    () => showAll ? payments : payments.filter((payment) => payment.is_active),
    [payments, showAll],
  );

  const monthlyTotal = useMemo(() => {
    // Net monthly impact of active recurring rows: incoming and outgoing both
    // keep their sign, while rows without an available FX rate are excluded.
    return sumConvertedMonthlyAmounts(payments, convertToTargetIfAvailable);
  }, [payments, convertToTargetIfAvailable]);

  const handleRequestExecution = useCallback((payment: PlannedPayment) => {
    setPaymentToLink(payment);
    setLinkDialogOpen(true);
  }, []);

  const handleEdit = useCallback((payment: PlannedPayment) => {
    setEditing(payment);
    setFormOpen(true);
  }, []);

  const handleToggleActive = useCallback(async (payment: PlannedPayment) => {
    setActionLoading(true);
    try {
      await toggleActive(payment.id);
    } catch (error) {
      logger.error("Failed to toggle status:", error);
      toast.error(t("plannedPage.toggleFailed"));
    } finally {
      setActionLoading(false);
    }
  }, [t, toggleActive]);

  const handleDelete = useCallback(async (payment: PlannedPayment) => {
    const shouldDelete = await confirm({
      title: t("plannedPage.delete.title"),
      description: t("plannedPage.delete.desc"),
      confirmLabel: t("plannedPage.delete.confirm"),
      variant: "destructive",
    });
    if (!shouldDelete) return;

    setActionLoading(true);
    try {
      await deletePayment(payment.id);
    } catch (error) {
      logger.error("Failed to delete payment:", error);
      toast.error(t("plannedPage.deleteFailed"));
    } finally {
      setActionLoading(false);
    }
  }, [confirm, deletePayment, t]);

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
    } catch (error) {
      logger.error("Failed to save payment:", error);
      toast.error(t("plannedPage.saveFailed", { msg: apiErrorToMessage(error, t) }));
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div {...loadingSurfaceProps} className="space-y-8">
        <PageHeader title={t("plannedPage.title")} subtitle={t("plannedPage.subtitle")} icon={CalendarClock} />
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
              {[...Array(8)].map((_, index) => (
                <Skeleton key={index} className="h-[6.5rem] w-full rounded-[0.625rem]" />
              ))}
            </div>
          </CardContent>
        </Card>
        <Skeleton className="h-[300px] w-full rounded-xl" />
      </div>
    );
  }

  if (error) {
    return <PageError message={error} onRetry={() => void refetch()} />;
  }

  return (
    <>
      <div className="space-y-8">
        <div className="flex items-start justify-between">
          <PageHeader title={t("plannedPage.title")} subtitle={t("plannedPage.subtitle")} icon={CalendarClock} />
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)} className="gap-1.5">
              <History className="h-4 w-4" />
              {t("plannedPage.history.button")}
            </Button>
            <Button
              variant={showAll ? "secondary" : "outline"}
              size="sm"
              onClick={() => setShowAll(!showAll)}
              className="gap-1.5"
            >
              {showAll ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              {showAll ? t("plannedPage.showingAll") : t("plannedPage.activeOnly")}
            </Button>
            <Button
              onClick={() => {
                setEditing(undefined);
                setCreateFormKey((key) => key + 1);
                setFormOpen(true);
              }}
              className="gap-2"
            >
              <Plus className="h-4 w-4" />
              {t("plannedPage.newPayment")}
            </Button>
          </div>
        </div>

        <NextSevenDaysStrip
          payments={payments}
          estimatedMonthly={monthlyTotal.total}
          estimatedMonthlyUnavailableCount={monthlyTotal.unavailableCount}
          currencyRatesLoading={currencyRatesLoading}
          convertAmount={convertToTargetIfAvailable}
          onSelect={handleEdit}
        />

        <MatchSuggestionsBanner onReview={handleReviewSuggestion} />
        <RecurringDetectionPanel />

        <PlannedPaymentsTable
          payments={filteredPayments}
          totalCount={payments.length}
          dateFormat={appSettings.dateFormat}
          actionLoading={actionLoading}
          onRequestExecution={handleRequestExecution}
          onEdit={handleEdit}
          onToggleActive={handleToggleActive}
          onDelete={handleDelete}
        />

        <PlannedPaymentForm
          open={formOpen}
          onOpenChange={(open) => {
            setFormOpen(open);
            if (!open) setEditing(undefined);
          }}
          onSubmit={handleSubmit}
          initial={editing}
          loading={actionLoading}
          key={editing?.id ?? `new-${createFormKey}`}
        />

        <LinkTransactionDialog
          open={linkDialogOpen}
          onOpenChange={(open) => {
            setLinkDialogOpen(open);
            if (!open) setPaymentToLink(null);
          }}
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
