import { PAGE_ICONS } from "@/lib/pageIcons";
import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarClock, History, Plus, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RowMenu } from "@/components/shared/RowMenu";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
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
import {
    usePlannedPayments,
    type PlannedPayment,
} from "@/hooks/usePlannedPayments";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import logger from "@/lib/logger";
import { plannedKeys } from "@/lib/queryKeys";
import { undoToast } from "@/lib/undoToast";
import { PageShell } from "@/components/shared/PageShell";
import {
    booleanSearchParamCodec,
    useSearchParamState,
} from "@/hooks/useSearchParamState";

/**
 * Planned (ADR-183): the next seven days, likely matches and detected
 * patterns above the list of planned payments. Add payment opens a right-hand
 * sheet; Pause and Resume act at once and offer Undo; Delete keeps its
 * confirmation because there is no restore endpoint; Mark as paid opens the
 * link dialog, since the execute route needs the transaction that paid it.
 */
export default function PlannedPaymentsPage() {
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const { convertToTargetIfAvailable, isLoading: currencyRatesLoading } =
        useCurrencyConverter(appSettings.defaultCurrency || "EUR");

    const [showAll, setShowAll] = useSearchParamState(
        "show_all",
        booleanSearchParamCodec,
    );
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
    // Bumped on every "Add" open so the create form's key changes and it
    // remounts blank instead of retaining the previous create form's state.
    const [createFormKey, setCreateFormKey] = useState(0);
    const [actionLoading, setActionLoading] = useState(false);
    const [linkDialogOpen, setLinkDialogOpen] = useState(false);
    const [paymentToLink, setPaymentToLink] = useState<PlannedPayment | null>(
        null,
    );
    const [historyOpen, setHistoryOpen] = useState(false);
    const queryClient = useQueryClient();

    const openCreate = useCallback(() => {
        setEditing(undefined);
        setCreateFormKey((key) => key + 1);
        setFormOpen(true);
    }, []);

    const handleReviewSuggestion = useCallback(
        (plannedId: number) => {
            const payment = payments.find(
                (candidate) => candidate.id === plannedId,
            );
            if (!payment) return;
            setPaymentToLink(payment);
            setLinkDialogOpen(true);
        },
        [payments],
    );

    const handleExecute = useCallback(
        async (id: number, transactionId: number, executionDate?: string) => {
            await executePayment(id, transactionId, executionDate);
            await queryClient.invalidateQueries({
                queryKey: plannedKeys.matchSuggestions,
            });
        },
        [executePayment, queryClient],
    );

    const filteredPayments = useMemo(
        () =>
            showAll
                ? payments
                : payments.filter((payment) => payment.is_active),
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

    // Pause and Resume are reversible, so they act at once and offer Undo
    // (ADR-179 "forgive, don't warn"); Undo flips the same row back.
    const handleToggleActive = useCallback(
        async (payment: PlannedPayment) => {
            setActionLoading(true);
            try {
                await toggleActive(payment.id);
                undoToast({
                    message: t(
                        payment.is_active
                            ? "plannedPage.toast.paused"
                            : "plannedPage.toast.resumed",
                    ),
                    description: payment.name,
                    undoLabel: t("common.undo"),
                    undo: async () => {
                        try {
                            await toggleActive(payment.id);
                        } catch (error) {
                            logger.error(
                                "Failed to undo status change:",
                                error,
                            );
                            toast.error(t("plannedPage.toggleFailed"));
                        }
                    },
                });
            } catch (error) {
                logger.error("Failed to toggle status:", error);
                toast.error(t("plannedPage.toggleFailed"));
            } finally {
                setActionLoading(false);
            }
        },
        [t, toggleActive],
    );

    const handleDelete = useCallback(
        async (payment: PlannedPayment) => {
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
                toast.success(
                    t("plannedPage.toast.deleted", { name: payment.name }),
                );
            } catch (error) {
                logger.error("Failed to delete payment:", error);
                toast.error(t("plannedPage.deleteFailed"));
            } finally {
                setActionLoading(false);
            }
        },
        [confirm, deletePayment, t],
    );

    const handleSubmit = async (
        data: Omit<PlannedPayment, "id" | "created_at">,
    ) => {
        try {
            setActionLoading(true);
            if (editing) {
                await updatePayment(editing.id, data);
                setEditing(undefined);
                toast.success(
                    t("plannedPage.toast.updated", { name: data.name }),
                );
            } else {
                await addPayment(data);
                toast.success(
                    t("plannedPage.toast.created", { name: data.name }),
                );
            }
            setFormOpen(false);
        } catch (error) {
            logger.error("Failed to save payment:", error);
            toast.error(
                t("plannedPage.saveFailed", {
                    msg: apiErrorToMessage(error, t),
                }),
            );
        } finally {
            setActionLoading(false);
        }
    };

    if (loading) {
        return (
            <PageShell {...loadingSurfaceProps} className="">
                <PageHeader
                    title={t("plannedPage.title")}
                    subtitle={t("plannedPage.subtitle")}
                    icon={PAGE_ICONS["/planned"]}
                />
                <Card>
                    <CardContent variant="headerless">
                        <div className="flex items-start justify-between gap-4">
                            <div className="space-y-2">
                                <Skeleton className="h-3 w-28" />
                                <Skeleton className="h-4 w-56" />
                            </div>
                            <div className="space-y-2">
                                <Skeleton className="ml-auto h-3 w-20" />
                                <Skeleton className="ml-auto h-7 w-24" />
                            </div>
                        </div>
                        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
                            {[...Array(8)].map((_, index) => (
                                <Skeleton
                                    key={index}
                                    className="h-[6.5rem] w-full rounded-card"
                                />
                            ))}
                        </div>
                    </CardContent>
                </Card>
                <Skeleton className="h-[300px] w-full rounded-card" />
            </PageShell>
        );
    }

    if (error) {
        return <PageError message={error} onRetry={() => void refetch()} />;
    }

    const addButton = (
        <Button onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden />
            {t("plannedPage.newPayment")}
        </Button>
    );

    const emptyState =
        payments.length === 0 ? (
            <EmptyState
                headingLevel={3}
                size="compact"
                icon={CalendarClock}
                title={t("plannedPage.empty")}
                description={t("plannedPage.emptyDesc")}
                action={addButton}
            />
        ) : (
            <EmptyState
                headingLevel={3}
                size="compact"
                icon={CalendarClock}
                title={t("plannedPage.emptyFiltered")}
                description={t("plannedPage.emptyFilteredDesc")}
                action={
                    <Button variant="outline" onClick={() => setShowAll(true)}>
                        {t("plannedPage.includePaused")}
                    </Button>
                }
            />
        );

    return (
        <>
            <PageShell className="">
                <PageHeader
                    title={t("plannedPage.title")}
                    subtitle={t("plannedPage.subtitle")}
                    icon={PAGE_ICONS["/planned"]}
                    actions={
                        <>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="outline"
                                        aria-label={t("txPage.view.menu")}
                                    >
                                        <SlidersHorizontal
                                            className="h-4 w-4"
                                            aria-hidden
                                        />
                                        {t("txPage.view.menu")}
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                    align="end"
                                    className="w-56"
                                >
                                    <DropdownMenuCheckboxItem
                                        checked={showAll}
                                        onCheckedChange={(checked) =>
                                            setShowAll(checked === true)
                                        }
                                    >
                                        {t("plannedPage.includePaused")}
                                    </DropdownMenuCheckboxItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                            <RowMenu
                                variant="outline"
                                size="icon"
                                label={t("plannedPage.menu")}
                            >
                                <DropdownMenuItem
                                    onSelect={() => setHistoryOpen(true)}
                                >
                                    <History
                                        className="mr-2 h-4 w-4 text-label-secondary"
                                        aria-hidden
                                    />
                                    {t("plannedPage.history.title")}
                                </DropdownMenuItem>
                            </RowMenu>
                            {addButton}
                        </>
                    }
                />

                <NextSevenDaysStrip
                    payments={payments}
                    estimatedMonthly={monthlyTotal.total}
                    estimatedMonthlyUnavailableCount={
                        monthlyTotal.unavailableCount
                    }
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
                    emptyState={emptyState}
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
            </PageShell>
            <ConfirmDialog />
        </>
    );
}
