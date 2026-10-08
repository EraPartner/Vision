import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import {
    rollbackPortfolioImportBatch,
    type PortfolioImportBatchPage,
} from "@/lib/api/portfolioImports";
import {
    invalidateAccountDerived,
    invalidateInvestmentData,
    invalidateTransactionData,
} from "@/lib/queryKeys";

import {
    usePortfolioImportHistory,
    portfolioImportHistoryKey as HISTORY_KEY,
    portfolioImportHistoryPageSize as PAGE_SIZE,
} from "@/features/portfolio/usePortfolioQueries";

interface Props {
    disabled: boolean;
    onBusyChange: (busy: boolean) => void;
    onRolledBack: (batchId: number) => void;
}

export function PortfolioImportHistory({
    disabled,
    onBusyChange,
    onRolledBack,
}: Props) {
    const { t } = useLanguage();
    const queryClient = useQueryClient();
    const { confirm, ConfirmDialog } = useConfirmDialog();
    const [open, setOpen] = useState(false);
    const [offset, setOffset] = useState(0);
    const [busy, setBusy] = useState(false);
    const { data, error, isFetching } = usePortfolioImportHistory(offset, open);
    const rollback = async (
        batch: PortfolioImportBatchPage["items"][number],
    ) => {
        if (disabled || busy) return;
        setBusy(true);
        onBusyChange(true);
        try {
            const accepted = await confirm({
                title: t("portfolioImport.session.history.rollbackTitle"),
                description: t(
                    "portfolioImport.session.history.rollbackDescription",
                    {
                        file: batch.source_filename ?? batch.adapter_name,
                    },
                ),
                confirmLabel: t("portfolioImport.session.history.rollback"),
                variant: "destructive",
            });
            if (!accepted) return;
            await rollbackPortfolioImportBatch(batch.id);
            onRolledBack(batch.id);
            invalidateInvestmentData(queryClient);
            invalidateAccountDerived(queryClient);
            invalidateTransactionData(queryClient);
            await queryClient.invalidateQueries({ queryKey: HISTORY_KEY });
            await queryClient.invalidateQueries({
                queryKey: ["portfolio-import-preview"],
            });
            toast.success(t("portfolioImport.session.history.rollbackSuccess"));
        } catch (err) {
            toast.error(t("portfolioImport.session.history.rollbackFailed"), {
                description: apiErrorToMessage(err, t),
            });
        } finally {
            setBusy(false);
            onBusyChange(false);
        }
    };
    return (
        <details
            className="rounded-card corner-continuous border border-border/60 bg-card/70 p-4"
            onToggle={(event) => setOpen(event.currentTarget.open)}
        >
            <summary className="cursor-pointer rounded-control type-body font-medium focus-ring">
                {t("portfolioImport.session.history.title")}
            </summary>
            {open && (
                <div className="mt-3 space-y-3">
                    {error && (
                        <Alert variant="destructive">
                            <AlertDescription>
                                {apiErrorToMessage(error, t)}
                            </AlertDescription>
                        </Alert>
                    )}
                    {isFetching && (
                        <p
                            role="status"
                            className="type-footnote text-label-secondary"
                        >
                            {t("common.loading")}
                        </p>
                    )}
                    {data && data.items.length > 0 && (
                        <ul className="m-0 list-none divide-y divide-border/50 p-0">
                            {data.items.map((batch) => (
                                <li
                                    key={batch.id}
                                    className="flex items-center justify-between gap-3 py-2"
                                >
                                    <span className="flex min-w-0 flex-col">
                                        <span className="truncate type-body">
                                            {batch.source_filename ??
                                                batch.adapter_name}
                                        </span>
                                        <span className="type-footnote text-label-secondary">
                                            {t(
                                                "portfolioImport.session.batch",
                                                {
                                                    id: batch.id,
                                                },
                                            )}
                                        </span>
                                    </span>
                                    {[
                                        "complete",
                                        "complete_with_errors",
                                    ].includes(batch.status) && (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={disabled || busy}
                                            onClick={() => void rollback(batch)}
                                        >
                                            {t(
                                                "portfolioImport.session.history.rollback",
                                            )}
                                        </Button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                    {data && data.total > PAGE_SIZE && (
                        <div className="flex gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={busy || offset === 0}
                                onClick={() => setOffset(offset - PAGE_SIZE)}
                            >
                                {t("common.previous")}
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={
                                    busy || offset + PAGE_SIZE >= data.total
                                }
                                onClick={() => setOffset(offset + PAGE_SIZE)}
                            >
                                {t("common.next")}
                            </Button>
                        </div>
                    )}
                </div>
            )}
            <ConfirmDialog />
        </details>
    );
}
