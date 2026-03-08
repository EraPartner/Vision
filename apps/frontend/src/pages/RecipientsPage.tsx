import { useState, useCallback, useRef, useEffect } from "react";
import { VirtualDataTable } from "@/components/shared/VirtualDataTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Eye, EyeOff, ToggleLeft, ToggleRight, Trash2, Link2, Unlink, Users } from "lucide-react";
import { useUpdateRecipient, useDeleteRecipient, useUnmergeRecipient } from "@/hooks/useRecipients";
import { AddRecipientDialog } from "@/components/forms/AddRecipientDialog";
import { CategoryCombobox } from "@/components/shared/CategoryCombobox";
import { MergeRecipientsDialog } from "@/components/recipients/MergeRecipientsDialog";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { apiClient } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

const PAGE_SIZE = 100;

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
    const [showAll, setShowAll] = useState(false);
    const [search, setSearch] = useState("");
    const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
    const [allItems, setAllItems] = useState<any[]>([]);
    const [totalItems, setTotalItems] = useState(0);
    const [isFetchingMore, setIsFetchingMore] = useState(false);
    const offsetRef = useRef(0);
    const hasMoreRef = useRef(true);
    const loadingRef = useRef(false);

    const updateMutation = useUpdateRecipient();
    const deleteMutation = useDeleteRecipient();
    const unmergeMutation = useUnmergeRecipient();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const { data: initialData, isLoading, error } = useQuery({
        queryKey: ['recipients-virtual', { active: !showAll, search: search || undefined }],
        queryFn: () => apiClient.getRecipients({ limit: PAGE_SIZE, offset: 0, active: !showAll, search: search || undefined }),
        staleTime: 30_000,
    });

    useEffect(() => {
        if (initialData) {
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
        try {
            const result = await apiClient.getRecipients({
                limit: PAGE_SIZE,
                offset: offsetRef.current,
                active: !showAll,
                search: search || undefined,
            });
            setAllItems(prev => {
                const existingIds = new Set(prev.map((r: any) => r.id));
                const newItems = result.items.filter((r: any) => !existingIds.has(r.id));
                return [...prev, ...newItems];
            });
            offsetRef.current += result.items.length;
            hasMoreRef.current = offsetRef.current < (result.total ?? result.items.length);
            setTotalItems(result.total ?? result.items.length);
        } catch (err) {
            console.error('Failed to load more recipients:', err);
        } finally {
            setIsFetchingMore(false);
            loadingRef.current = false;
        }
    }, [showAll, search]);

    const handleUpdate = (idx: number, updated: TableRecipient) => {
        const originalRecipient = allItems[idx];
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
            <div className="flex items-center justify-center h-96">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="space-y-8 animate-in">
                <div>
                    <h2 className="text-3xl font-bold text-foreground">Recipients</h2>
                    <p className="text-destructive mt-1">Error loading recipients: {error.message}</p>
                </div>
            </div>
        );
    }

    const recipients: TableRecipient[] = allItems.map((r: any) => ({
        id: r.id,
        name: r.name,
        primary_bank_account: r.primary_bank_account || 'N/A',
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
            header: "Recipient",
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
            header: "Primary Account",
            editable: false,
            render: (row: TableRecipient) => (
                <span className={`text-muted-foreground font-mono text-sm ${!row.is_active ? 'line-through' : ''}`}>{row.primary_bank_account}</span>
            ),
        },
        {
            key: "default_category_name",
            header: "Default Category",
            editable: false,
            render: (row: TableRecipient, isEditing: boolean) => {
                if (isEditing) {
                    return (
                        <CategoryCombobox
                            value={row.default_category_id ?? null}
                            onSelect={(catId) => {
                                updateMutation.mutate({
                                    id: row.id,
                                    data: { default_category_id: catId ?? undefined },
                                });
                            }}
                            className="w-full"
                        />
                    );
                }

                const formatCategoryName = (categoryName?: string): string => {
                    if (!categoryName) return 'None';
                    const parts = categoryName.split(':');
                    if (parts.length > 1) {
                        const detail = parts[1].trim();
                        return detail.charAt(0) + detail.slice(1).toLowerCase();
                    }
                    return categoryName.charAt(0) + categoryName.slice(1).toLowerCase();
                };

                const displayName = formatCategoryName(row.default_category_name);
                const isNone = displayName === 'None';

                return (
                    <Badge variant="outline" className={`font-medium ${isNone ? 'text-muted-foreground' : ''}`}>
                        {displayName}
                    </Badge>
                );
            },
        },
        {
            key: "notes",
            header: "Notes",
            editable: true,
            render: (row: TableRecipient) => (
                <span className={`text-sm text-muted-foreground ${!row.is_active ? 'line-through' : ''}`}>{row.notes || '-'}</span>
            ),
        },
        {
            key: "is_active",
            header: "Status",
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
                    {row.is_active ? 'Active' : 'Inactive'}
                </Button>
            ),
        },
        {
            key: "actions",
            header: "",
            className: "w-24",
            editable: false,
            render: (row: TableRecipient) => (
                <div className="flex items-center gap-1">
                    {row.primary_recipient_id && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-foreground"
                            title="Unmerge from primary"
                            onClick={(e) => { e.stopPropagation(); unmergeMutation.mutate(row.id); }}
                            disabled={unmergeMutation.isPending}
                        >
                            <Unlink className="h-4 w-4" />
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        onClick={async () => {
                            const ok = await confirm({
                                title: "Delete Recipient",
                                description: `Are you sure you want to delete recipient "${row.name}"? This action cannot be undone.`,
                                confirmLabel: "Delete",
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
                {showAll ? "Showing All" : "Active Only"}
            </Button>
            <Button
                variant="outline"
                size="sm"
                onClick={() => setMergeDialogOpen(true)}
                className="gap-1.5"
            >
                <Link2 className="h-4 w-4" />
                Merge Recipients
            </Button>
            <AddRecipientDialog />
        </div>
    );

    return (
        <>
            <div className="space-y-8 animate-in">
                <div>
                    <h2 className="text-3xl font-bold text-foreground">Recipients</h2>
                    <p className="text-muted-foreground mt-1">View and manage transaction recipients</p>
                </div>

                <VirtualDataTable
                    title="All Recipients"
                    subtitle={`${totalItems} recipients`}
                    columns={columns}
                    data={recipients}
                    onRowUpdate={handleUpdate}
                    emptyMessage="No recipients found."
                    totalItems={totalItems}
                    isFetchingMore={isFetchingMore}
                    onLoadMore={loadMore}
                    hasMore={hasMoreRef.current}
                    onSearchChange={setSearch}
                    actions={tableActions}
                    maxHeight={700}
                />

                <MergeRecipientsDialog
                    open={mergeDialogOpen}
                    onOpenChange={setMergeDialogOpen}
                    recipients={allItems}
                />
            </div>
            <ConfirmDialog />
        </>
    );
}
