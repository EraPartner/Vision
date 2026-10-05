import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
            className="rounded-lg border p-4"
            onToggle={(event) => setOpen(event.currentTarget.open)}
        >
            <summary className="cursor-pointer text-sm font-medium">
                {t("portfolioImport.session.history.title")}
            </summary>
            {open && (
                <div className="mt-3 space-y-3">
                    {error && <p role="alert">{apiErrorToMessage(error, t)}</p>}
                    {isFetching && <p role="status">{t("common.loading")}</p>}
                    {data?.items.map((batch) => (
                        <div
                            key={batch.id}
                            className="flex items-center justify-between gap-3 text-sm"
                        >
                            <span className="min-w-0 break-words">
                                {batch.source_filename ?? batch.adapter_name} ·{" "}
                                {t("portfolioImport.session.batch", {
                                    id: batch.id,
                                })}
                            </span>
                            {["complete", "complete_with_errors"].includes(
                                batch.status,
                            ) && (
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
                        </div>
                    ))}
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
