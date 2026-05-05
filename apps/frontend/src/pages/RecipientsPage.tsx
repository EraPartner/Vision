import { useState, useCallback, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useLanguage } from "@/contexts/LanguageContext";
import logger from "@/lib/logger";
import { VirtualDataTable } from "@/components/shared/VirtualDataTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Eye, EyeOff, ToggleLeft, ToggleRight, Trash2, Link2, Unlink, Users, Regex } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { useUpdateRecipient, useDeleteRecipient, useUnmergeRecipient } from "@/hooks/useRecipients";
import { AddRecipientDialog } from "@/features/recipients/AddRecipientDialog";
import { CategoryCombobox } from "@/components/shared/CategoryCombobox";
import { MergeRecipientsDialog } from "@/features/recipients/MergeRecipientsDialog";
import { RecipientPatternsDialog } from "@/features/recipients/RecipientPatternsDialog";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { apiClient } from "@/lib/api";
import type { Recipient } from "@/lib/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageError } from "@/components/shared/PageError";

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
    const navigate = useNavigate();
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const pageSize = appSettings.defaultPageSize;
    const [showAll, setShowAll] = useState(false);
    const [showUncategorized, setShowUncategorized] = useState(false);
    const [search, setSearch] = useState("");
    const [sortKey, setSortKey] = useState<string | null>(null);
    const [sortDir, setSortDir] = useState<"asc" | "desc" | null>(null);
    const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
    const [patternsDialogRecipient, setPatternsDialogRecipient] = useState<{ id: number; name: string } | null>(null);
    const [allItems, setAllItems] = useState<Recipient[]>([]);
    const [totalItems, setTotalItems] = useState(0);
    const [isFetchingMore, setIsFetchingMore] = useState(false);
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

    const { data: initialData, isLoading, error } = useQuery({
        queryKey: ['recipients', 'virtual', { active: !showAll, search: search || undefined, uncategorized: showUncategorized, sortKey, sortDir, pageSize }],
        queryFn: () => apiClient.getRecipients({ limit: pageSize, offset: 0, active: !showAll, search: search || undefined, uncategorized: showUncategorized, sort_by: sortKey || undefined, sort_dir: sortDir || undefined }),
        staleTime: 30_000,
    });

    useEffect(() => {
        if (initialData) {
            generationRef.current += 1;
            setAllItems(initialData.items);
            setTotalItems(initialData.total ?? initialData.items.length);
            offsetRef.current = initialData.items.length;
            hasMoreRef.current = initialData.items.length < (initialData.total ?? initialData.items.length);
        }
    }, [initialData]);

    const loadMore = useCallback(async () => {
        if (loadingRef.current || !hasMoreRef.current) return;
        loadingRef.current = true;
        setIsFetchingMore(true);
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
            setAllItems(prev => {
                const existingIds = new Set(prev.map((r) => r.id));
                const newItems = result.items.filter((r) => !existingIds.has(r.id));
                return [...prev, ...newItems];
            });
            offsetRef.current += result.items.length;
            hasMoreRef.current = offsetRef.current < (result.total ?? result.items.length);
            setTotalItems(result.total ?? result.items.length);
        } catch (err) {
            logger.error('Failed to load more recipients:', err);
        } finally {
            setIsFetchingMore(false);
            loadingRef.current = false;
        }
    }, [showAll, search, showUncategorized, sortKey, sortDir, pageSize]);

    const handleSortChange = useCallback((key: string | null, dir: "asc" | "desc" | null) => {
        setSortKey(key);
        setSortDir(dir);
        setAllItems([]);
        setTotalItems(0);
        offsetRef.current = 0;
        hasMoreRef.current = true;
    }, []);

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

    const toggleActive = (id: number, currentActive: boolean) => {
        updateMutation.mutate({ id, data: { is_active: !currentActive } });
    };

    if (isLoading) {
        return (
            <div className="space-y-8 animate-in">
                <PageHeader title={t('recipientsPage.tableTitle')} icon={Users} />
                <Card>
                    <CardHeader className="pb-3">
                        <Skeleton className="h-6 w-44" />
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {[...Array(8)].map((_, i) => (
                            <Skeleton key={i} className="h-12 w-full" />
                        ))}
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (error) {
        return (
            <div className="space-y-8 animate-in">
                <PageHeader title={t('recipientsPage.tableTitle')} icon={Users} />
                <Card>
                    <CardContent className="pt-0">
                        <PageError message={t('recipientsPage.error', { msg: error.message })} />
                    </CardContent>
                </Card>
            </div>
        );
    }

    const recipients: TableRecipient[] = allItems.map((r) => ({
        id: r.id,
        name: r.name,
        primary_bank_account: r.primary_bank_account || t('recipientsPage.none'),
        default_category_name: r.default_category_name,
        default_category_id: r.default_category_id,
        primary_recipient_id: r.primary_recipient_id,
        primary_recipient_name: r.primary_recipient_name,
        alias_count: r.alias_count,
        is_active: r.is_active,
        notes: r.notes || '',
    }));

    const columns = [
        {
            key: "name",
            header: t('recipientsPage.col.recipient'),
            editable: true,
            render: (row: TableRecipient) => (
                <div className="flex items-center gap-2">
                    <span className={`font-medium ${row.is_active ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                        {row.name}
                    </span>
                    {(row.alias_count ?? 0) > 0 && (
                        <Badge variant="secondary" className="text-xs gap-1">
                            <Users className="h-3 w-3" />
                            {row.alias_count}
                        </Badge>
                    )}
                    {row.primary_recipient_id && (
                        <Badge variant="outline" className="text-xs gap-1 text-muted-foreground">
                            <Link2 className="h-3 w-3" />
                            → {row.primary_recipient_name}
                        </Badge>
                    )}
                </div>
            ),
        },
        {
            key: "primary_bank_account",
            header: t('recipientsPage.col.account'),
            editable: false,
            render: (row: TableRecipient) => (
                <span className={`text-muted-foreground font-mono text-sm ${!row.is_active ? 'line-through' : ''}`}>{row.primary_bank_account}</span>
            ),
        },
        {
            key: "default_category_name",
            header: t('recipientsPage.col.category'),
            editable: false,
            render: (row: TableRecipient, isEditing: boolean) => {
                if (isEditing) {
                    return (
                        <CategoryCombobox
                            value={row.default_category_id ?? null}
                            onSelect={(catId) => {
                                // Cancel any ongoing queries to prevent refetch removing this row
                                // before the edit mode is properly cancelled
                                queryClient.cancelQueries({ queryKey: ['recipients'] });
                                // Cancel edit mode first to avoid stale state
                                cancelEditingRef.current?.();
                                // Small delay to let the UI update before mutation
                                setTimeout(() => {
                                    updateMutation.mutate({
                                        id: row.id,
                                        data: { default_category_id: catId },
                                    });
                                }, 0);
                            }}
                            className="w-full"
                        />
                    );
                }

                const formatCategoryName = (categoryName?: string): string => {
                    if (!categoryName) return t('recipientsPage.none');
                    const parts = categoryName.split(':');
                    if (parts.length > 1) {
                        const detail = parts[1].trim();
                        return detail.charAt(0) + detail.slice(1).toLowerCase();
                    }
                    return categoryName.charAt(0) + categoryName.slice(1).toLowerCase();
                };

                const displayName = formatCategoryName(row.default_category_name);
                const isNone = !row.default_category_name;

                return (
                    <Badge variant="outline" className={`font-medium ${isNone ? 'text-muted-foreground' : ''}`}>
                        {displayName}
                    </Badge>
                );
            },
        },
        {
            key: "notes",
            header: t('recipientsPage.col.notes'),
            editable: true,
            render: (row: TableRecipient) => (
                <span className={`text-sm text-muted-foreground ${!row.is_active ? 'line-through' : ''}`}>{row.notes || '-'}</span>
            ),
        },
        {
            key: "is_active",
            header: t('recipientsPage.col.status'),
            editable: false,
            render: (row: TableRecipient) => (
                <Button
                    variant="ghost"
                    size="sm"
                    className={`gap-1.5 ${row.is_active ? 'text-accent hover:text-accent' : 'text-muted-foreground hover:text-muted-foreground opacity-50'}`}
                    onClick={(e) => { e.stopPropagation(); toggleActive(row.id, row.is_active); }}
                    disabled={updateMutation.isPending}
                >
                    {row.is_active ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
                    {row.is_active ? t('recipientsPage.statusActive') : t('recipientsPage.statusInactive')}
                </Button>
            ),
        },
        {
            key: "actions",
            header: "",
            className: "w-32",
            editable: false,
            render: (row: TableRecipient) => (
                <div className="flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="icon"
                        className="icon-touch-target text-muted-foreground hover:text-foreground"
                        title={t('recipientPatterns.openBtn')}
                        onClick={(e) => {
                            e.stopPropagation();
                            setPatternsDialogRecipient({ id: row.id, name: row.name });
                        }}
                    >
                        <Regex className="h-4 w-4" />
                    </Button>
                    {row.primary_recipient_id && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="icon-touch-target text-muted-foreground hover:text-foreground"
                            title={t('recipientsPage.unmergeTitle')}
                            onClick={(e) => { e.stopPropagation(); unmergeMutation.mutate(row.id); }}
                            disabled={unmergeMutation.isPending}
                        >
                            <Unlink className="h-4 w-4" />
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        size="icon"
                        className="icon-touch-target text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        aria-label="Delete recipient"
                        onClick={async () => {
                            const ok = await confirm({
                                title: t('recipientsPage.delete.title'),
                                description: t('recipientsPage.delete.desc', { name: row.name }),
                                confirmLabel: t('recipientsPage.delete.confirm'),
                                variant: "destructive",
                            });
                            if (ok) deleteMutation.mutate(row.id);
                        }}
                        disabled={deleteMutation.isPending}
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                </div>
            ),
        },
    ];

    const tableActions = (
        <div className="flex gap-2">
            <Button
                variant={showAll ? "secondary" : "outline"}
                size="sm"
                onClick={() => setShowAll(!showAll)}
                className="gap-1.5"
            >
                {showAll ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                {showAll ? t('recipientsPage.showingAll') : t('recipientsPage.activeOnly')}
            </Button>
            <Button
                variant={showUncategorized ? "secondary" : "outline"}
                size="sm"
                onClick={() => setShowUncategorized(!showUncategorized)}
                className="gap-1.5"
            >
                <Badge variant={showUncategorized ? "default" : "outline"} className="h-4 w-4 p-0 flex items-center justify-center">?</Badge>
                {showUncategorized ? t('recipientsPage.uncategorized') : t('recipientsPage.allCategories')}
            </Button>
            <Button
                variant="outline"
                size="sm"
                onClick={() => setMergeDialogOpen(true)}
                className="gap-1.5"
            >
                <Link2 className="h-4 w-4" />
                {t('merge.title')}
            </Button>
            <AddRecipientDialog />
        </div>
    );

    return (
        <>
            <div className="space-y-8 animate-in">
                <PageHeader
                    title={t('recipientsPage.tableTitle')}
                    subtitle={t('recipientsPage.tableSubtitle', { n: totalItems })}
                    icon={Users}
                />

                <VirtualDataTable
                    title={t('recipientsPage.tableTitle')}
                    subtitle={`${totalItems} ${t('recipients.title').toLowerCase()}`}
                    columns={columns}
                    data={recipients}
                    onRowUpdate={handleUpdate}
                    onRowDoubleClick={(row) => {
                        navigate(`/transactions?recipient_id=${row.id}&filter_label=${encodeURIComponent(row.name)}`);
                    }}
                    emptyMessage={(
                        <EmptyState
                            icon={Users}
                            title={t('recipientsPage.empty')}
                            description={t('recipientsPage.tableSubtitle', { n: 0 })}
                        />
                    )}
                    totalItems={totalItems}
                    isFetchingMore={isFetchingMore}
                    onLoadMore={loadMore}
                    hasMore={hasMoreRef.current}
                    onSearchChange={setSearch}
                    searchValue={search}
                    onSortChange={handleSortChange}
                    sortKeyProp={sortKey}
                    sortDirProp={sortDir}
                    actions={tableActions}
                    maxHeight={700}
                    cancelEditingRef={cancelEditingRef}
                />

                <MergeRecipientsDialog
                    open={mergeDialogOpen}
                    onOpenChange={setMergeDialogOpen}
                />

                {patternsDialogRecipient && (
                    <RecipientPatternsDialog
                        open={patternsDialogRecipient != null}
                        onOpenChange={(o) => { if (!o) setPatternsDialogRecipient(null); }}
                        recipientId={patternsDialogRecipient.id}
                        recipientName={patternsDialogRecipient.name}
                    />
                )}
            </div>
            <ConfirmDialog />
        </>
    );
}
