import { PAGE_ICONS } from "@/lib/pageIcons";
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import logger from "@/lib/logger";
import { VirtualDataTable } from "@/components/shared/VirtualDataTable";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useLoadingSurfaceProps } from "@/lib/loadingSurface";
import {
    Eye,
    EyeOff,
    Link2,
    MoreHorizontal,
    Regex,
    SlidersHorizontal,
    Trash2,
    Unlink,
    Users,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/PageHeader";
import { RowMenu } from "@/components/shared/RowMenu";
import {
    useUpdateRecipient,
    useDeleteRecipient,
    useUnmergeRecipient,
    useVirtualRecipients,
} from "@/hooks/useRecipients";
import { AddRecipientDialog } from "@/features/recipients/AddRecipientDialog";
import { CategoryCombobox } from "@/components/shared/CategoryCombobox";
import { MergeRecipientsDialog } from "@/features/recipients/MergeRecipientsDialog";
import { RecipientPatternsDialog } from "@/features/recipients/RecipientPatternsDialog";
import { apiClient } from "@/lib/api";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { recipientKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import type { Recipient } from "@/lib/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { undoToast } from "@/lib/undoToast";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { parseCategoryName } from "@vision/shared-utils";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageError } from "@/components/shared/PageError";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { PageShell } from "@/components/shared/PageShell";
import { TextLink } from "@/components/shared/TextLink";
import { TouchDisclosure } from "@/components/shared/TouchDisclosure";
import { useSearchParams } from "react-router";
import {
    booleanSearchParamCodec,
    useSearchParamState,
} from "@/hooks/useSearchParamState";

const RECIPIENT_SORT_KEYS = new Set([
    "name",
    "primary_bank_account",
    "default_category_name",
    "notes",
    "is_active",
]);

type TableRecipient = {
    id: number;
    name: string;
    primary_bank_account: string;
    default_category_name?: string;
    default_category_id?: number | null;
    primary_recipient_id?: number | null;
    primary_recipient_name?: string | null;
    alias_count?: number;
    is_active: boolean;
    notes?: string;
};

export default function RecipientsPage() {
    const { t } = useLanguage();
    const loadingSurfaceProps = useLoadingSurfaceProps();
    const { appSettings } = useAppSettings();
    const pageSize = appSettings.defaultPageSize;
    const [showAll, setShowAll] = useSearchParamState(
        "show_all",
        booleanSearchParamCodec,
    );
    const [showUncategorized, setShowUncategorized] = useSearchParamState(
        "uncategorized",
        booleanSearchParamCodec,
    );
    const [searchParams, setSearchParams] = useSearchParams();
    const search = searchParams.get("search") ?? "";
    const rawSortKey = searchParams.get("sort_key");
    const rawSortDir = searchParams.get("sort_dir");
    const validSort =
        rawSortKey !== null &&
        RECIPIENT_SORT_KEYS.has(rawSortKey) &&
        (rawSortDir === "asc" || rawSortDir === "desc");
    const sortKey = validSort ? rawSortKey : null;
    const sortDir = validSort ? rawSortDir : null;
    const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
    const [patternsDialogRecipient, setPatternsDialogRecipient] = useState<{
        id: number;
        name: string;
    } | null>(null);
    const [allItems, setAllItems] = useState<Recipient[]>([]);
    const [hasInitialItems, setHasInitialItems] = useState(false);
    const [totalItems, setTotalItems] = useState(0);
    const [isFetchingMore, setIsFetchingMore] = useState(false);
    const [loadMoreFailed, setLoadMoreFailed] = useState(false);
    const offsetRef = useRef(0);
    const hasMoreRef = useRef(true);
    const loadingRef = useRef(false);
    const generationRef = useRef(0);
    const cancelEditingRef = useRef<(() => void) | null>(null);

    const queryClient = useQueryClient();
    const updateMutation = useUpdateRecipient();
    const deleteMutation = useDeleteRecipient();
    const unmergeMutation = useUnmergeRecipient();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const {
        data: initialData,
        isLoading,
        error,
        refetch,
    } = useVirtualRecipients({
        active: !showAll,
        search: search || undefined,
        uncategorized: showUncategorized,
        sortKey,
        sortDir,
        pageSize,
    });

    useEffect(() => {
        if (initialData) {
            generationRef.current += 1;
            setLoadMoreFailed(false);
            setAllItems(initialData.items);
            setHasInitialItems(true);
            setTotalItems(initialData.total ?? initialData.items.length);
            offsetRef.current = initialData.items.length;
            hasMoreRef.current =
                initialData.items.length <
                (initialData.total ?? initialData.items.length);
        }
    }, [initialData]);

    const loadMore = useCallback(async () => {
        if (loadingRef.current || !hasMoreRef.current) return;
        loadingRef.current = true;
        setIsFetchingMore(true);
        setLoadMoreFailed(false);
        const gen = generationRef.current;
        try {
            const result = await apiClient.getRecipients({
                limit: pageSize,
                offset: offsetRef.current,
                active: !showAll,
                search: search || undefined,
                uncategorized: showUncategorized,
                sort_by: sortKey || undefined,
                sort_dir: sortDir || undefined,
            });
            if (generationRef.current !== gen) return;
            setAllItems((prev) => {
                const existingIds = new Set(prev.map((r) => r.id));
                const newItems = result.items.filter(
                    (r) => !existingIds.has(r.id),
                );
                return [...prev, ...newItems];
            });
            offsetRef.current += result.items.length;
            hasMoreRef.current =
                offsetRef.current < (result.total ?? result.items.length);
            setTotalItems(result.total ?? result.items.length);
        } catch (err) {
            if (generationRef.current === gen) setLoadMoreFailed(true);
            logger.error("Failed to load more recipients:", err);
        } finally {
            setIsFetchingMore(false);
            loadingRef.current = false;
        }
    }, [showAll, search, showUncategorized, sortKey, sortDir, pageSize]);

    const handleSortChange = useCallback(
        (key: string | null, dir: "asc" | "desc" | null) => {
            setSearchParams(
                (previous) => {
                    const next = new URLSearchParams(previous);
                    if (
                        key &&
                        RECIPIENT_SORT_KEYS.has(key) &&
                        (dir === "asc" || dir === "desc")
                    ) {
                        next.set("sort_key", key);
                        next.set("sort_dir", dir);
                    } else {
                        next.delete("sort_key");
                        next.delete("sort_dir");
                    }
                    return next;
                },
                { replace: true },
            );
            offsetRef.current = 0;
            hasMoreRef.current = true;
        },
        [setSearchParams],
    );

    const setSearch = useCallback(
        (value: string) => {
            setSearchParams(
                (previous) => {
                    const next = new URLSearchParams(previous);
                    if (value) next.set("search", value);
                    else next.delete("search");
                    return next;
                },
                { replace: true },
            );
        },
        [setSearchParams],
    );

    const handleUpdate = (sourceIndex: number, updated: TableRecipient) => {
        const originalRecipient = allItems[sourceIndex];
        if (!originalRecipient) return;
        updateMutation.mutate({
            id: originalRecipient.id,
            data: {
                name: updated.name,
                notes: updated.notes,
                is_active: updated.is_active,
            },
        });
    };

    const statusMutation = useMutation({
        mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) =>
            apiClient.updateRecipient(id, { is_active }),
        onSuccess: () =>
            queryClient.invalidateQueries({ queryKey: recipientKeys.all }),
    });
    const { mutateAsync: setStatus } = statusMutation;

    const toggleActive = useCallback(
        async (row: TableRecipient) => {
            const nextActive = !row.is_active;
            try {
                await setStatus({ id: row.id, is_active: nextActive });
                undoToast({
                    message: t(
                        nextActive
                            ? "recipientsPage.toast.active"
                            : "recipientsPage.toast.inactive",
                        { name: row.name },
                    ),
                    undoLabel: t("common.undo"),
                    undo: async () => {
                        try {
                            await setStatus({
                                id: row.id,
                                is_active: !nextActive,
                            });
                        } catch {
                            toast.error(t("recipientsPage.toggleFailed"));
                        }
                    },
                });
            } catch {
                toast.error(t("recipientsPage.toggleFailed"));
            }
        },
        [setStatus, t],
    );

    const recipients: TableRecipient[] = useMemo(
        () =>
            allItems.map((r) => ({
                id: r.id,
                name: r.name,
                primary_bank_account:
                    r.primary_bank_account || t("recipientsPage.none"),
                default_category_name: r.default_category_name,
                default_category_id: r.default_category_id,
                primary_recipient_id: r.primary_recipient_id,
                primary_recipient_name: r.primary_recipient_name,
                alias_count: r.alias_count,
                is_active: r.is_active,
                notes: r.notes || "",
            })),
        [allItems, t],
    );

    const columns = useMemo(
        () => [
            {
                key: "name",
                header: t("recipientsPage.col.recipient"),
                editable: true,
                render: (row: TableRecipient) => (
                    <div className="flex min-w-0 items-center gap-2">
                        <TextLink
                            to={`/transactions?recipient_id=${row.id}&filter_label=${encodeURIComponent(row.name)}`}
                            className={cn(
                                "min-w-0 truncate font-medium",
                                row.is_active
                                    ? "text-foreground"
                                    : "text-muted-foreground line-through",
                            )}
                        >
                            {row.name}
                        </TextLink>
                        <TouchDisclosure
                            label={row.name}
                            content={row.name}
                            className="shrink-0 px-1 type-footnote text-label-secondary"
                        >
                            …
                        </TouchDisclosure>
                        {(row.alias_count ?? 0) > 0 && (
                            <Badge
                                variant="secondary"
                                size="sm"
                                className="shrink-0 gap-1"
                            >
                                <Users className="h-3 w-3" aria-hidden />
                                {row.alias_count}
                            </Badge>
                        )}
                        {row.primary_recipient_id && (
                            <Badge
                                variant="outline"
                                size="sm"
                                className="min-w-0 gap-1 text-label-secondary"
                                title={row.primary_recipient_name ?? undefined}
                            >
                                <Link2
                                    className="h-3 w-3 shrink-0"
                                    aria-hidden
                                />
                                <span className="truncate">
                                    → {row.primary_recipient_name}
                                </span>
                            </Badge>
                        )}
                    </div>
                ),
            },
            {
                key: "primary_bank_account",
                header: t("recipientsPage.col.account"),
                editable: false,
                render: (row: TableRecipient) => (
                    <span
                        className={cn(
                            "font-mono type-callout text-label-secondary",
                            !row.is_active && "line-through",
                        )}
                    >
                        {row.primary_bank_account}
                    </span>
                ),
            },
            {
                key: "default_category_name",
                header: t("recipientsPage.col.category"),
                editable: false,
                render: (row: TableRecipient, isEditing: boolean) => {
                    if (isEditing) {
                        return (
                            <CategoryCombobox
                                aria-label={`${t("recipientsPage.col.category")}: ${row.name}`}
                                value={row.default_category_id ?? null}
                                onSelect={(catId) => {
                                    // Cancel any ongoing queries to prevent refetch removing this row
                                    // before the edit mode is properly cancelled
                                    queryClient.cancelQueries({
                                        queryKey: recipientKeys.all,
                                    });
                                    // Cancel edit mode first to avoid stale state
                                    cancelEditingRef.current?.();
                                    // Small delay to let the UI update before mutation
                                    setTimeout(() => {
                                        updateMutation.mutate({
                                            id: row.id,
                                            data: {
                                                default_category_id: catId,
                                            },
                                        });
                                    }, 0);
                                }}
                                className="w-full"
                            />
                        );
                    }

                    const formatCategoryName = (
                        categoryName?: string,
                    ): string => {
                        if (!categoryName) return t("recipientsPage.none");
                        // Shared GENERAL:DETAIL split (first ':' only, detail may
                        // contain colons); sentence-case the detail for display.
                        const { general, detail } =
                            parseCategoryName(categoryName);
                        const label = detail || general;
                        return label.charAt(0) + label.slice(1).toLowerCase();
                    };

                    const displayName = formatCategoryName(
                        row.default_category_name,
                    );
                    const isNone = !row.default_category_name;

                    return (
                        <Badge
                            variant="outline"
                            className={cn(
                                "font-medium",
                                isNone && "text-muted-foreground",
                            )}
                        >
                            {displayName}
                        </Badge>
                    );
                },
            },
            {
                key: "notes",
                header: t("recipientsPage.col.notes"),
                editable: true,
                render: (row: TableRecipient) => (
                    <span
                        className={cn(
                            "type-callout text-label-secondary",
                            !row.is_active && "line-through",
                        )}
                    >
                        {row.notes || "-"}
                    </span>
                ),
            },
            {
                key: "is_active",
                header: t("recipientsPage.col.status"),
                editable: false,
                render: (row: TableRecipient) => (
                    <Badge
                        variant={row.is_active ? "success" : "muted"}
                        size="sm"
                    >
                        {row.is_active
                            ? t("recipientsPage.statusActive")
                            : t("recipientsPage.statusInactive")}
                    </Badge>
                ),
            },
            {
                key: "actions",
                header: "",
                className: "w-12",
                editable: false,
                render: (row: TableRecipient) => (
                    <div className="flex justify-end">
                        <RowMenu
                            label={t("recipientsPage.rowMenu", {
                                name: row.name,
                            })}
                        >
                            <DropdownMenuItem
                                onSelect={() =>
                                    setPatternsDialogRecipient({
                                        id: row.id,
                                        name: row.name,
                                    })
                                }
                            >
                                <Regex
                                    className="mr-2 h-4 w-4 text-label-secondary"
                                    aria-hidden
                                />
                                {t("recipientPatterns.title")}
                            </DropdownMenuItem>
                            {row.primary_recipient_id && (
                                <DropdownMenuItem
                                    disabled={unmergeMutation.isPending}
                                    onSelect={() =>
                                        unmergeMutation.mutate(row.id)
                                    }
                                >
                                    <Unlink
                                        className="mr-2 h-4 w-4 text-label-secondary"
                                        aria-hidden
                                    />
                                    {t("recipientsPage.unmerge")}
                                </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                                disabled={statusMutation.isPending}
                                onSelect={() => void toggleActive(row)}
                            >
                                {row.is_active ? (
                                    <EyeOff
                                        className="mr-2 h-4 w-4 text-label-secondary"
                                        aria-hidden
                                    />
                                ) : (
                                    <Eye
                                        className="mr-2 h-4 w-4 text-label-secondary"
                                        aria-hidden
                                    />
                                )}
                                {row.is_active
                                    ? t("recipientsPage.markInactive")
                                    : t("recipientsPage.markActive")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                variant="destructive"
                                disabled={deleteMutation.isPending}
                                onSelect={async () => {
                                    const ok = await confirm({
                                        title: t("recipientsPage.delete.title"),
                                        description: t(
                                            "recipientsPage.delete.desc",
                                            { name: row.name },
                                        ),
                                        confirmLabel: t(
                                            "recipientsPage.delete.confirm",
                                        ),
                                        variant: "destructive",
                                    });
                                    if (ok) deleteMutation.mutate(row.id);
                                }}
                            >
                                <Trash2 className="mr-2 h-4 w-4" aria-hidden />
                                {t("common.delete")}
                            </DropdownMenuItem>
                        </RowMenu>
                    </div>
                ),
            },
        ],
        [
            t,
            toggleActive,
            statusMutation.isPending,
            queryClient,
            cancelEditingRef,
            updateMutation,
            unmergeMutation,
            deleteMutation,
            confirm,
        ],
    );

    if (isLoading || (initialData && !hasInitialItems)) {
        return (
            <PageShell className="">
                <PageHeader
                    title={t("recipientsPage.tableTitle")}
                    icon={PAGE_ICONS["/recipients"]}
                />
                <Card {...loadingSurfaceProps}>
                    <CardHeader className="pb-3">
                        <Skeleton className="h-6 w-44" />
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {[...Array(8)].map((_, i) => (
                            <Skeleton key={i} className="h-12 w-full" />
                        ))}
                    </CardContent>
                </Card>
            </PageShell>
        );
    }

    if (error) {
        return (
            <PageShell className="">
                <PageHeader
                    title={t("recipientsPage.tableTitle")}
                    icon={PAGE_ICONS["/recipients"]}
                />
                <PageError
                    onRetry={() => void refetch()}
                    message={t("recipientsPage.error", {
                        msg: apiErrorToMessage(error, t),
                    })}
                />
            </PageShell>
        );
    }

    const headerActions = (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="outline"
                        aria-label={t("txPage.view.menu")}
                    >
                        <SlidersHorizontal className="h-4 w-4" aria-hidden />
                        {t("txPage.view.menu")}
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuCheckboxItem
                        checked={showAll}
                        onCheckedChange={(checked) =>
                            setShowAll(checked === true)
                        }
                    >
                        {t("common.includeInactive")}
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                        checked={showUncategorized}
                        onCheckedChange={(checked) =>
                            setShowUncategorized(checked === true)
                        }
                    >
                        {t("recipients.uncategorizedOnly")}
                    </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="outline"
                        size="icon"
                        aria-label={t("recipientsPage.menu")}
                    >
                        <MoreHorizontal className="h-4 w-4" aria-hidden />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setMergeDialogOpen(true)}>
                        <Link2
                            className="mr-2 h-4 w-4 text-label-secondary"
                            aria-hidden
                        />
                        {t("merge.title")}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <AddRecipientDialog />
        </>
    );

    return (
        <>
            <PageShell className="">
                <PageHeader
                    title={t("recipientsPage.tableTitle")}
                    subtitle={t("recipientsPage.tableSubtitle", {
                        n: totalItems,
                    })}
                    icon={PAGE_ICONS["/recipients"]}
                    actions={headerActions}
                />

                <VirtualDataTable
                    columns={columns}
                    data={recipients}
                    getRowLabel={(row) => row.name}
                    onRowUpdate={handleUpdate}
                    emptyMessage={
                        <EmptyState
                            icon={PAGE_ICONS["/recipients"]}
                            title={t("recipientsPage.empty")}
                            description={t("recipientsPage.tableSubtitle", {
                                n: 0,
                            })}
                        />
                    }
                    serverMode={{
                        sort: {
                            onChange: handleSortChange,
                            key: sortKey,
                            dir: sortDir,
                        },
                        search: { onChange: setSearch, value: search },
                        pagination: {
                            totalItems,
                            isFetchingMore,
                            onLoadMore: loadMore,
                            hasMore: hasMoreRef.current,
                        },
                    }}
                    maxHeight={700}
                    cancelEditingRef={cancelEditingRef}
                />

                {loadMoreFailed && (
                    <Alert variant="destructive">
                        <AlertDescription className="flex flex-wrap items-center gap-3">
                            <span>{t("recipientsPage.loadMoreFailed")}</span>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={isFetchingMore}
                                onClick={() => void loadMore()}
                            >
                                {t("common.retry")}
                            </Button>
                        </AlertDescription>
                    </Alert>
                )}

                <MergeRecipientsDialog
                    open={mergeDialogOpen}
                    onOpenChange={setMergeDialogOpen}
                />

                {patternsDialogRecipient && (
                    <RecipientPatternsDialog
                        open={patternsDialogRecipient != null}
                        onOpenChange={(o) => {
                            if (!o) setPatternsDialogRecipient(null);
                        }}
                        recipientId={patternsDialogRecipient.id}
                        recipientName={patternsDialogRecipient.name}
                    />
                )}
            </PageShell>
            <ConfirmDialog />
        </>
    );
}
