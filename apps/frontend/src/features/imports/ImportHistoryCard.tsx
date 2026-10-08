/**
 * ImportHistoryCard — paginated list of import batches with rollback support.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { importKeys } from "@/lib/queryKeys";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { toast } from "sonner";
import { formatDate, parseISO } from "@/lib/dateUtils";
import { SectionLoader } from "@/components/shared/SectionLoader";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { List, ListRow } from "@/components/ui/list";
import { EmptyState } from "@/components/shared/EmptyState";
import { FileSearch, Loader2, RefreshCw, Undo2, History } from "lucide-react";
import type { ImportBatch } from "@/types/apiClient";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useImportBatches } from "./useImportHistoryData";

const PAGE_SIZE = 10;

const STATUS_VARIANT: Record<
    ImportBatch["status"],
    "default" | "secondary" | "destructive" | "outline"
> = {
    pending: "outline",
    staging: "secondary",
    validating: "secondary",
    matching: "secondary",
    awaiting_review: "secondary",
    committing: "secondary",
    complete: "default",
    failed: "destructive",
    aborted: "outline",
};

const STATUS_LABEL_KEY: Record<ImportBatch["status"], string> = {
    pending: "importHistory.status.pending",
    staging: "importHistory.status.staging",
    validating: "importHistory.status.validating",
    matching: "importHistory.status.matching",
    awaiting_review: "importHistory.status.awaiting_review",
    committing: "importHistory.status.committing",
    complete: "importHistory.status.complete",
    failed: "importHistory.status.failed",
    aborted: "importHistory.status.aborted",
};

function BatchStatusBadge({ status }: { status: ImportBatch["status"] }) {
    const { t } = useLanguage();
    return (
        <Badge variant={STATUS_VARIANT[status]} size="sm">
            {t(STATUS_LABEL_KEY[status])}
        </Badge>
    );
}

function RollbackButton({
    batch,
    onRolledBack,
}: {
    batch: ImportBatch;
    onRolledBack: () => void;
}) {
    const { t } = useLanguage();
    const [rolling, setRolling] = useState(false);
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const canRollback =
        batch.status === "complete" && batch.transactions_remaining > 0;

    if (!canRollback) return null;

    const handleRollback = async () => {
        const accepted = await confirm({
            title: t("importHistory.rollbackTitle"),
            description: t("importHistory.rollbackDesc", {
                n: batch.transactions_remaining,
                file:
                    batch.source_filename ??
                    t("importHistory.batchFallback", { id: batch.id }),
            }),
            confirmLabel: t("importHistory.rollbackConfirm"),
            cancelLabel: t("common.cancel"),
            variant: "destructive",
        });
        if (!accepted) return;

        setRolling(true);
        try {
            const { deleted } = await apiClient.rollbackImportBatch(batch.id);
            toast.success(t("importHistory.rollbackSuccess", { n: deleted }));
            onRolledBack();
        } catch (err) {
            toast.error(t("importHistory.rollbackFailed"), {
                description: apiErrorToMessage(err, t),
            });
        } finally {
            setRolling(false);
        }
    };

    return (
        <>
            <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={rolling}
                onClick={() => void handleRollback()}
            >
                {rolling ? <Loader2 className="animate-spin" /> : <Undo2 />}
                {t("importHistory.rollback")}
            </Button>
            <ConfirmDialog />
        </>
    );
}

function BatchRow({
    batch,
    onRolledBack,
}: {
    batch: ImportBatch;
    onRolledBack: () => void;
}) {
    const { t } = useLanguage();
    const started = formatDate(parseISO(batch.started_at), "yyyy-MM-dd HH:mm");
    return (
        <ListRow
            className="[&>div]:items-start [&>div]:py-3"
            title={
                <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">
                        {batch.source_filename ??
                            t("importHistory.batchFallback", { id: batch.id })}
                    </span>
                    <BatchStatusBadge status={batch.status} />
                </span>
            }
            subtitle={
                <span className="block whitespace-normal">
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                        <span>{batch.adapter_name}</span>
                        <span>{started}</span>
                        {batch.rows_imported != null && (
                            <>
                                <span className="text-success">
                                    {t("importPage.imported", {
                                        n: batch.rows_imported,
                                    })}
                                </span>
                                {(batch.rows_duplicate ?? 0) > 0 && (
                                    <span className="text-warning">
                                        {t("importPage.duplicates", {
                                            n: batch.rows_duplicate,
                                        })}
                                    </span>
                                )}
                                {(batch.rows_error ?? 0) > 0 && (
                                    <span className="text-destructive">
                                        {t("importPage.errors", {
                                            n: batch.rows_error,
                                        })}
                                    </span>
                                )}
                            </>
                        )}
                        {batch.transactions_remaining > 0 && (
                            <span>
                                {t("importHistory.remaining", {
                                    n: batch.transactions_remaining,
                                })}
                            </span>
                        )}
                    </span>
                    {batch.error_summary && (
                        <span className="block max-w-xs truncate text-destructive">
                            {batch.error_summary}
                        </span>
                    )}
                </span>
            }
            trailing={
                <>
                    {batch.status === "awaiting_review" && (
                        <Button variant="ghost" size="sm" asChild>
                            <Link to={`/import/${batch.id}/review`}>
                                <FileSearch />
                                {t("importHistory.resumeReview")}
                            </Link>
                        </Button>
                    )}
                    <RollbackButton batch={batch} onRolledBack={onRolledBack} />
                </>
            }
        />
    );
}

export function ImportHistoryCard({ refreshKey }: { refreshKey?: number }) {
    const { t } = useLanguage();
    const queryClient = useQueryClient();
    const [offset, setOffset] = useState(0);

    const { data, isLoading, isFetching, isError, error } =
        useImportBatches(offset);

    const batches = data?.items ?? [];
    const total = data?.total ?? 0;

    // Preserve the old catch-block behavior: surface a toast whenever a load
    // fails. A fresh error object per failed fetch re-triggers this effect, so
    // repeated failures still notify.
    useEffect(() => {
        if (!isError) return;
        toast.error(t("importHistory.loadFailed"), {
            description: apiErrorToMessage(error, t),
        });
    }, [isError, error, t]);

    const invalidate = useCallback(
        () =>
            queryClient.invalidateQueries({ queryKey: importKeys.batchesAll }),
        [queryClient],
    );

    // External refresh trigger: the parent bumps refreshKey after an import.
    // Skip the initial mount (the query already fetches then) so we only refetch
    // on an actual change, matching the old effect's behavior.
    const lastRefreshKey = useRef(refreshKey);
    useEffect(() => {
        if (refreshKey === lastRefreshKey.current) return;
        lastRefreshKey.current = refreshKey;
        invalidate();
    }, [refreshKey, invalidate]);

    const handleRolledBack = useCallback(() => {
        invalidate();
    }, [invalidate]);

    const totalPages = Math.ceil(total / PAGE_SIZE);
    const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between">
                    <div>
                        <CardTitle>{t("importHistory.title")}</CardTitle>
                        <CardDescription>
                            {t("importHistory.desc")}
                        </CardDescription>
                    </div>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => invalidate()}
                        disabled={isFetching}
                        aria-label={t("common.refresh")}
                    >
                        <RefreshCw
                            className={cn(
                                "h-4 w-4",
                                isFetching && "animate-spin",
                            )}
                        />
                    </Button>
                </div>
            </CardHeader>
            <CardContent>
                {isLoading ? (
                    <SectionLoader />
                ) : batches.length === 0 ? (
                    <EmptyState
                        icon={History}
                        size="compact"
                        headingLevel={3}
                        title={t("importHistory.empty")}
                    />
                ) : (
                    <>
                        <List>
                            {batches.map((b) => (
                                <BatchRow
                                    key={b.id}
                                    batch={b}
                                    onRolledBack={handleRolledBack}
                                />
                            ))}
                        </List>

                        {totalPages > 1 && (
                            <div className="flex items-center justify-between mt-4 pt-2">
                                <p className="type-footnote text-label-secondary">
                                    {t("importHistory.page", {
                                        page: currentPage,
                                        total: totalPages,
                                    })}
                                </p>
                                <div className="flex gap-2">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() =>
                                            setOffset(
                                                Math.max(0, offset - PAGE_SIZE),
                                            )
                                        }
                                        disabled={offset === 0 || isFetching}
                                    >
                                        {t("common.previous")}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() =>
                                            setOffset(offset + PAGE_SIZE)
                                        }
                                        disabled={
                                            offset + PAGE_SIZE >= total ||
                                            isFetching
                                        }
                                    >
                                        {t("common.next")}
                                    </Button>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}
