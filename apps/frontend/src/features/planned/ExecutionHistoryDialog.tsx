import { useState, useCallback, useEffect, useRef } from "react";
import { Money } from "@/components/shared/Money";
import logger from "@/lib/logger";
import { ExternalLink } from "lucide-react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { apiClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Link } from "react-router";
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

export function ExecutionHistoryDialog({
    open,
    onOpenChange,
    payments,
}: ExecutionHistoryDialogProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();

    const requestVersion = useRef(0);
    const returnFocus = useRef<HTMLElement | null>(null);
    const [historyFailed, setHistoryFailed] = useState(false);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [executionHistory, setExecutionHistory] = useState<
        ExecutionHistoryItem[]
    >([]);

    const loadExecutionHistory = useCallback(async () => {
        const version = ++requestVersion.current;
        setHistoryFailed(false);
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
                return [
                    {
                        plannedPaymentId: payment.id,
                        plannedPaymentName: payment.name,
                        executionDate:
                            payment.last_executed_date || payment.due_date,
                        transactionId: payment.executed_transaction_id,
                    },
                ];
            }

            return [];
        });

        if (links.length === 0) {
            setExecutionHistory([]);
            setHistoryLoading(false);
            return;
        }

        setHistoryLoading(true);
        try {
            const results = await Promise.allSettled(
                links.map(
                    async (link): Promise<ExecutionHistoryItem | null> => {
                        const txResponse = await apiClient.getTransactions({
                            transaction_id: link.transactionId,
                            limit: 1,
                        });
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
                            memo: transaction.memo ?? undefined,
                        } satisfies ExecutionHistoryItem;
                    },
                ),
            );

            const resolved = results
                .filter(
                    (
                        result,
                    ): result is Extract<
                        typeof result,
                        { status: "fulfilled" }
                    > => result.status === "fulfilled",
                )
                .map((result) => result.value)
                .filter((item): item is ExecutionHistoryItem => item != null)
                .sort((a, b) =>
                    (b.executionDate || "").localeCompare(
                        a.executionDate || "",
                    ),
                );

            if (version !== requestVersion.current) return;
            setHistoryFailed(
                results.some((result) => result.status === "rejected"),
            );
            setExecutionHistory(resolved);
        } catch (err) {
            if (version !== requestVersion.current) return;
            setHistoryFailed(true);
            logger.error("Failed to load planned execution history", err);
            setExecutionHistory([]);
        } finally {
            if (version === requestVersion.current) setHistoryLoading(false);
        }
    }, [payments]);

    useEffect(() => {
        if (open) void loadExecutionHistory();
        return () => {
            requestVersion.current += 1;
        };
    }, [open, loadExecutionHistory]);

    const handleOpenChange = (isOpen: boolean) => {
        onOpenChange(isOpen);
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent
                className="sm:max-w-4xl max-h-[85vh] overflow-y-auto"
                onOpenAutoFocus={() => {
                    returnFocus.current =
                        document.activeElement instanceof HTMLElement
                            ? document.activeElement
                            : null;
                }}
                onCloseAutoFocus={(event) => {
                    if (returnFocus.current?.isConnected) {
                        event.preventDefault();
                        returnFocus.current.focus();
                    }
                }}
            >
                <DialogHeader>
                    <DialogTitle>{t("plannedPage.history.title")}</DialogTitle>
                </DialogHeader>

                {historyFailed && !historyLoading && (
                    <div
                        role="alert"
                        className="flex flex-wrap items-center justify-between gap-3 rounded-card corner-continuous border border-warning/30 bg-warning/5 p-3 type-body"
                    >
                        <p>{t("plannedPage.history.loadFailed")}</p>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void loadExecutionHistory()}
                        >
                            {t("common.retry")}
                        </Button>
                    </div>
                )}

                {historyLoading ? (
                    <div
                        role="status"
                        className="py-10 text-center type-body text-label-secondary"
                    >
                        {t("plannedPage.history.loading")}
                    </div>
                ) : executionHistory.length === 0 ? (
                    historyFailed ? null : (
                        <div className="py-10 text-center type-body text-label-secondary">
                            {t("plannedPage.history.empty")}
                        </div>
                    )
                ) : (
                    <div
                        role="region"
                        aria-label={t("plannedPage.history.title")}
                        tabIndex={0}
                        className="overflow-x-auto rounded-card corner-continuous border border-border/60 focus-ring"
                    >
                        <div className="min-w-[36rem]">
                            <div className="grid grid-cols-[7rem_10rem_minmax(12rem,1fr)_max-content] gap-3 border-b border-border/50 bg-foreground/[0.04] px-3 py-2 eyebrow text-label-secondary">
                                <div>
                                    {t("plannedPage.history.colExecutedOn")}
                                </div>
                                <div>
                                    {t("plannedPage.history.colPlanned")}
                                </div>
                                <div>
                                    {t("plannedPage.history.colTransaction")}
                                </div>
                                <div className="text-right">
                                    {t("plannedPage.col.amount")}
                                </div>
                            </div>
                            <div className="max-h-[55vh] overflow-y-auto">
                                {executionHistory.map((item) => (
                                    <div
                                        key={`${item.plannedPaymentId}-${item.transactionId}-${item.executionDate}`}
                                        className="grid grid-cols-[7rem_10rem_minmax(12rem,1fr)_max-content] gap-3 border-b border-border/50 px-3 py-2 type-body last:border-b-0"
                                    >
                                        <div className="text-label-secondary">
                                            {formatDateStringWithAppSettings(
                                                item.executionDate,
                                                appSettings.dateFormat,
                                            ) || "—"}
                                        </div>
                                        <div className="truncate font-medium text-foreground">
                                            {item.plannedPaymentName}
                                        </div>
                                        <div className="min-w-0">
                                            <div className="truncate">
                                                {item.memo ||
                                                    item.recipientName ||
                                                    t(
                                                        "plannedPage.link.txFallback",
                                                        {
                                                            id: item.transactionId,
                                                        },
                                                    )}
                                            </div>
                                            <div className="truncate type-footnote text-label-secondary">
                                                {[
                                                    item.recipientName,
                                                    item.categoryName,
                                                    formatDateStringWithAppSettings(
                                                        item.transactionDate,
                                                        appSettings.dateFormat,
                                                    ),
                                                ]
                                                    .filter(Boolean)
                                                    .join(" · ")}
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-end gap-2">
                                            <span
                                                className={cn(
                                                    "tabular-nums font-semibold",
                                                    item.amount < 0
                                                        ? "text-foreground"
                                                        : "text-gain",
                                                )}
                                            >
                                                <Money
                                                    amount={item.amount}
                                                    currency={item.currency}
                                                    signed
                                                />
                                            </span>
                                            <Button
                                                asChild
                                                variant="ghost"
                                                size="icon"
                                                className="icon-touch-target"
                                            >
                                                <Link
                                                    to={`/transactions?transaction_id=${item.transactionId}`}
                                                    aria-label={t(
                                                        "plannedPage.history.openTransaction",
                                                    )}
                                                    onClick={(event) => {
                                                        if (
                                                            event.button ===
                                                                0 &&
                                                            !event.metaKey &&
                                                            !event.ctrlKey &&
                                                            !event.shiftKey &&
                                                            !event.altKey
                                                        ) {
                                                            onOpenChange(false);
                                                        }
                                                    }}
                                                >
                                                    <ExternalLink
                                                        className="h-4 w-4"
                                                        aria-hidden
                                                    />
                                                </Link>
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        {t("common.close")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
