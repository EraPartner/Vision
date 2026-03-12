import { useState, useCallback, useRef, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import logger from "@/lib/logger";
import { useLanguage } from "@/contexts/LanguageContext";
import { VirtualDataTable } from "@/components/shared/VirtualDataTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Import, Loader2, Trash2, Eye, EyeOff, ToggleLeft, ToggleRight, Info, X, Users } from "lucide-react";
import { useUpdateTransaction, useDeleteTransaction } from "@/hooks/useTransactions";
import { getCategoryColor } from "@/utils/categoryColors";
import { AddTransactionDialog } from "@/components/forms/AddTransactionDialog";
import { CategoryCombobox } from "@/components/shared/CategoryCombobox";
import { RecipientCombobox } from "@/components/shared/RecipientCombobox";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { apiClient } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { formatCurrency } from "@/utils/currency";
import { SplitTransactionDialog } from "@/components/splits/SplitTransactionDialog";

const PAGE_SIZE = 100;

type TableTransaction = {
    id: number;
    date: string;
    memo: string;
    category: string;
    categoryId?: number;
    recipient: string;
    recipientId?: number;
    bank: string;
    amount: number;
    currency: string;
    balance?: number;
    comment?: string;
    is_active: boolean;
};

export default function TransactionsPage() {
    const { t } = useLanguage();
    const [searchParams, setSearchParams] = useSearchParams();
    const [showAll, setShowAll] = useState(false);
    const [search, setSearch] = useState("");
    const [sortKey, setSortKey] = useState<string | null>(null);
    const [sortDir, setSortDir] = useState<"asc" | "desc" | null>(null);
    const [allItems, setAllItems] = useState<any[]>([]);
    const [totalItems, setTotalItems] = useState(0);
    const [isFetchingMore, setIsFetchingMore] = useState(false);
    const offsetRef = useRef(0);
    const hasMoreRef = useRef(true);
    const loadingRef = useRef(false);

    // URL-based filters
    const recipientIdFilter = searchParams.get('recipient_id') ? Number(searchParams.get('recipient_id')) : undefined;
    const categoryIdFilter = searchParams.get('category_id') ? Number(searchParams.get('category_id')) : undefined;
    const filterLabel = searchParams.get('filter_label') || undefined;

    const [infoTransaction, setInfoTransaction] = useState<TableTransaction | null>(null);
    const updateMutation = useUpdateTransaction();
    const deleteMutation = useDeleteTransaction();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    // Initial load
    const { data: initialData, isLoading, error } = useQuery({
        queryKey: ['transactions-virtual', { active: !showAll, search: search || undefined, recipientIdFilter, categoryIdFilter, sortKey, sortDir }],
        queryFn: () => apiClient.getTransactions({
            limit: PAGE_SIZE, offset: 0, active: !showAll, search: search || undefined,
            recipient_id: recipientIdFilter,
            category_id: categoryIdFilter,
            sort_by: sortKey || undefined,
            sort_dir: sortDir || undefined,
        }),
        staleTime: 30_000,
    });

    // Reset accumulated data when filters change
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
            const result = await apiClient.getTransactions({
                limit: PAGE_SIZE,
                offset: offsetRef.current,
                active: !showAll,
                search: search || undefined,
                recipient_id: recipientIdFilter,
                category_id: categoryIdFilter,
                sort_by: sortKey || undefined,
                sort_dir: sortDir || undefined,
            });
            setAllItems(prev => {
                const existingIds = new Set(prev.map((t: any) => t.id));
                const newItems = result.items.filter((t: any) => !existingIds.has(t.id));
                return [...prev, ...newItems];
            });
            offsetRef.current += result.items.length;
            hasMoreRef.current = offsetRef.current < (result.total ?? result.items.length);
            setTotalItems(result.total ?? result.items.length);
        } catch (err) {
            logger.error('Failed to load more transactions:', err);
        } finally {
            setIsFetchingMore(false);
            loadingRef.current = false;
        }
    }, [showAll, search, recipientIdFilter, categoryIdFilter, sortKey, sortDir]);

    const handleSortChange = useCallback((key: string | null, dir: "asc" | "desc" | null) => {
        setSortKey(key);
        setSortDir(dir);
        // Reset accumulated data so the next useQuery result starts fresh
        setAllItems([]);
        setTotalItems(0);
        offsetRef.current = 0;
        hasMoreRef.current = true;
    }, []);

    const handleDelete = async (id: number, description?: string) => {
        const ok = await confirm({
            title: t('txPage.delete.title'),
            description: t('txPage.delete.desc', { desc: description ?? '' }),
            confirmLabel: t('txPage.delete.confirm'),
            variant: "destructive",
        });
        if (ok) deleteMutation.mutate(id);
    };

    const toggleActive = (id: number, currentActive: boolean) => {
        updateMutation.mutate({ id, data: { is_active: !currentActive } });
    };

    const handleUpdate = (idx: number, updated: TableTransaction) => {
        const originalTransaction = allItems[idx];
        if (!originalTransaction) return;
        updateMutation.mutate({
            id: originalTransaction.id,
            data: {
                transaction_date: updated.date,
                memo: updated.memo,
                amount: updated.amount,
                bank_account: updated.bank,
                currency: updated.currency,
                balance: updated.balance,
                comment: updated.comment,
            },
        });
    };

    if (isLoading) {
        return (
            <div className="space-y-8 animate-in">
                <div>
                    <h2 className="text-3xl font-bold text-foreground">{t('txPage.title')}</h2>
                    <p className="text-muted-foreground mt-1">{t('txPage.subtitle')}</p>
                </div>
                <Card>
                    <CardHeader className="pb-3">
                        <Skeleton className="h-6 w-44" />
                        <Skeleton className="h-4 w-28 mt-1" />
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
                <div>
                    <h2 className="text-3xl font-bold text-foreground">{t('txPage.title')}</h2>
                    <p className="text-destructive mt-1">{t('txPage.error', { msg: error.message })}</p>
                </div>
            </div>
        );
    }

    const transactions: TableTransaction[] = allItems.map((t: any) => ({
        id: t.id,
        date: t.transaction_date || t.date || '',
        memo: t.memo || '',
        category: t.category_name || t('txPage.field.uncategorized'),
        categoryId: t.category_id,
        recipient: t.recipient_name || t('txPage.field.unknown'),
        recipientId: t.recipient_id || 0,
        bank: t.bank_account,
        amount: t.amount,
        currency: t.currency || 'EUR',
        balance: t.balance,
        comment: t.comment || '',
        is_active: t.is_active ?? true,
    }));

    const columns = [
        {
            key: "date",
            header: t('txPage.col.date'),
            editable: true,
            type: "date" as const,
            render: (row: TableTransaction) => (
                <span className={`whitespace-nowrap ${row.is_active ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                    {row.date ? row.date.split('T')[0] : '—'}
                </span>
            ),
        },
        {
            key: "category",
            header: t('txPage.col.category'),
            editable: false,
            render: (row: TableTransaction, isEditing: boolean) => {
                if (isEditing) {
                    const original = allItems.find((t: any) => t.id === row.id);
                    return (
                        <CategoryCombobox
                            value={row.categoryId ?? original?.category_id ?? null}
                            onSelect={(catId) => {
                                if (!original) return;
                                updateMutation.mutate({ id: original.id, data: { category_id: catId ?? undefined } });
                            }}
                            className="w-full"
                        />
                    );
                }
                return (
                    <Badge variant="outline" className={`font-medium ${getCategoryColor(row.category)} ${!row.is_active ? 'opacity-50 line-through' : ''}`}>
                        {row.category}
                    </Badge>
                );
            },
        },
        {
            key: "recipient",
            header: t('txPage.col.recipient'),
            editable: false,
            render: (row: TableTransaction, isEditing: boolean) => {
                if (isEditing) {
                    const original = allItems.find((t: any) => t.id === row.id);
                    return (
                        <RecipientCombobox
                            value={row.recipientId ?? original?.recipient_id ?? null}
                            onSelect={(recipientId) => {
                                if (!original) return;
                                updateMutation.mutate({ id: original.id, data: { recipient_id: recipientId ?? undefined } });
                            }}
                            className="w-full"
                        />
                    );
                }
                return (
                    <span className={row.is_active ? 'text-foreground' : 'text-muted-foreground line-through'}>{row.recipient}</span>
                );
            },
        },
        {
            key: "amount",
            header: t('txPage.col.amount'),
            editable: true,
            type: "number" as const,
            defaultWidth: 90,
            minWidth: 70,
            render: (row: TableTransaction) => (
                <span className={`font-mono font-medium whitespace-nowrap ${row.amount >= 0 ? 'text-accent' : 'text-destructive'
                    } ${!row.is_active ? 'opacity-50 line-through' : ''}`}>
                    {row.amount >= 0 ? '+' : '-'}{formatCurrency(Math.abs(row.amount), row.currency)}
                </span>
            ),
        },
        {
            key: "info",
            header: t('txPage.col.info'),
            editable: false,
            sortable: false,
            filterable: false,
            defaultWidth: 96,
            minWidth: 80,
            render: (row: TableTransaction) => (
                <div className="flex items-center">
                    <SplitTransactionDialog
                        transactionId={row.id}
                        transactionAmount={row.amount}
                        transactionCurrency={row.currency}
                    />
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        onClick={(e) => { e.stopPropagation(); setInfoTransaction(row); }}
                    >
                        <Info className="h-4 w-4" />
                    </Button>
                </div>
            ),
        },
        {
            key: "is_active",
            header: t('txPage.col.status'),
            editable: false,
            defaultWidth: 145,
            minWidth: 130,
            render: (row: TableTransaction) => (
                <Button
                    variant="ghost"
                    size="sm"
                    className={`gap-1.5 ${row.is_active ? 'text-accent hover:text-accent' : 'text-muted-foreground hover:text-muted-foreground opacity-50'}`}
                    onClick={(e) => { e.stopPropagation(); toggleActive(row.id, row.is_active); }}
                    disabled={updateMutation.isPending}
                >
                    {row.is_active ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
                    {row.is_active ? t('txPage.statusActive') : t('txPage.statusInactive')}
                </Button>
            ),
        },
        {
            key: "delete",
            header: "",
            className: "!px-1",
            defaultWidth: 40,
            minWidth: 36,
            editable: false,
            render: (row: TableTransaction) => (
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    onClick={() => handleDelete(row.id, row.memo || row.recipient)}
                    disabled={deleteMutation.isPending}
                >
                    <Trash2 className="h-4 w-4" />
                </Button>
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
                {showAll ? t('txPage.showingAll') : t('txPage.activeOnly')}
            </Button>
            <AddTransactionDialog />
        </div>
    );

    const clearFilters = () => {
        setSearchParams({});
    };

    return (
        <>
            <div className="space-y-8 animate-in">
                <div>
                    <h2 className="text-3xl font-bold text-foreground">{t('txPage.title')}</h2>
                    <p className="text-muted-foreground mt-1">{t('txPage.subtitle')}</p>
                </div>

                {(recipientIdFilter || categoryIdFilter) && (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-primary/10 border border-primary/20">
                        <span className="text-sm text-foreground">
                            {t('txPage.filteredBy', { label: filterLabel || (recipientIdFilter ? `recipient #${recipientIdFilter}` : `category #${categoryIdFilter}`) })}
                        </span>
                        <Button variant="ghost" size="icon" className="h-6 w-6 ml-auto" onClick={clearFilters}>
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                )}

                <VirtualDataTable
                    title={t('txPage.tableTitle')}
                    subtitle={t('txPage.tableSubtitle', { n: totalItems })}
                    columns={columns}
                    data={transactions}
                    onRowUpdate={handleUpdate}
                    emptyMessage={(
                        <div className="flex flex-col items-center justify-center py-12 text-center">
                            <Import className="h-10 w-10 text-muted-foreground/40 mb-3" />
                            <p className="text-sm font-medium text-foreground mb-1">{t('txPage.empty')}</p>
                            <p className="text-xs text-muted-foreground mb-4">
                                {search ? t('txPage.emptySearch') : t('transactions.noTransactions')}
                            </p>
                            {!search && (
                                <Button asChild size="sm" variant="outline">
                                    <Link to="/import">{t('txPage.importLink')}</Link>
                                </Button>
                            )}
                        </div>
                    )}
                    totalItems={totalItems}
                    isFetchingMore={isFetchingMore}
                    onLoadMore={loadMore}
                    hasMore={hasMoreRef.current}
                    onSearchChange={setSearch}
                    onSortChange={handleSortChange}
                    sortKeyProp={sortKey}
                    sortDirProp={sortDir}
                    actions={tableActions}
                    maxHeight={700}
                />
            </div>
            <ConfirmDialog />
            <Dialog open={!!infoTransaction} onOpenChange={(open) => { if (!open) setInfoTransaction(null); }}>
                    <DialogContent className="max-w-md">
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                                <Info className="h-4 w-4 text-muted-foreground" />
                                {t('txPage.detailsTitle')}
                            </DialogTitle>
                        </DialogHeader>
                        {infoTransaction && (() => {
                            const txn = infoTransaction;
                            const fields = [
                                { label: t('txPage.field.id'), value: String(txn.id) },
                                { label: t('txPage.field.date'), value: txn.date ? txn.date.split('T')[0] : '—' },
                                { label: t('txPage.field.description'), value: txn.memo || undefined },
                                { label: t('txPage.field.recipient'), value: txn.recipient !== t('txPage.field.unknown') ? txn.recipient : undefined },
                                { label: t('txPage.field.category'), value: txn.category !== t('txPage.field.uncategorized') ? txn.category : undefined },
                                { label: t('txPage.field.amount'), value: `${txn.amount >= 0 ? '+' : '-'}${formatCurrency(Math.abs(txn.amount), txn.currency)}` },
                                { label: t('txPage.field.currency'), value: txn.currency },
                                { label: t('txPage.field.bankAccount'), value: txn.bank },
                                { label: t('txPage.field.balance'), value: txn.balance != null ? formatCurrency(txn.balance, txn.currency) : undefined },
                                { label: t('txPage.field.comment'), value: txn.comment || undefined },
                                { label: t('txPage.field.status'), value: txn.is_active ? t('txPage.statusActive') : t('txPage.statusInactive') },
                            ];
                            return (
                                <div className="divide-y divide-border">
                                    {fields.map(({ label, value }) => (
                                        value ? (
                                            <div key={String(label)} className="flex justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
                                                <span className="text-sm text-muted-foreground shrink-0">{label}</span>
                                                <span className="text-sm font-medium text-right break-all">{value}</span>
                                            </div>
                                        ) : null
                                    ))}
                                </div>
                            );
                        })()}
                    </DialogContent>
            </Dialog>
        </>
    );
}
