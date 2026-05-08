import { useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { Receipt } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageError } from "@/components/shared/PageError";
import { useUpdateTransaction, useDeleteTransaction, useBulkTagTransactions } from "@/hooks/useTransactions";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useTransactionListData } from "@/features/transactions/hooks/useTransactionListData";
import { FilterBanner } from "@/features/transactions/components/FilterBanner";
import { TableActions } from "@/features/transactions/components/TableActions";
import { TransactionsTable } from "@/features/transactions/components/TransactionsTable";
import { TransactionInfoDialog } from "@/features/transactions/components/TransactionInfoDialog";
import type { TableTransaction, InfoEditableField } from "@/features/transactions/types";

export default function TransactionsPage() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const pageSize = appSettings.defaultPageSize;
    const loadMoreOffset = Math.min(50, Math.max(15, Math.floor(pageSize / 5)));
    const [searchParams, setSearchParams] = useSearchParams();
    const [showAll, setShowAll] = useState(false);
    const [search, setSearch] = useState("");
    const [infoTransaction, setInfoTransaction] = useState<TableTransaction | null>(null);

    const recipientIdFilter = searchParams.get('recipient_id') ? Number(searchParams.get('recipient_id')) : undefined;
    const categoryIdFilter = searchParams.get('category_id') ? Number(searchParams.get('category_id')) : undefined;
    const transactionIdFilter = searchParams.get('transaction_id') ? Number(searchParams.get('transaction_id')) : undefined;
    const filterLabel = searchParams.get('filter_label') || undefined;
    const startDateFilter = searchParams.get('start_date') || undefined;
    const endDateFilter = searchParams.get('end_date') || undefined;
    const transactionTypeRaw = searchParams.get('transaction_type');
    const transactionTypeFilter = (transactionTypeRaw === 'income' || transactionTypeRaw === 'expense') ? transactionTypeRaw : undefined;
    const categoryIdsRaw = searchParams.get('category_ids');
    const categoryIdsFilter = categoryIdsRaw
        ? categoryIdsRaw.split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0)
        : undefined;
    const tagsRaw = searchParams.get('tags');
    const tagsFilter = tagsRaw ? tagsRaw.split(',').filter(Boolean) : undefined;

    const {
        allItems,
        setAllItems,
        totalItems,
        isLoading,
        error,
        isFetchingMore,
        hasMoreRef,
        sortKey,
        sortDir,
        handleSortChange,
        loadMore,
        setEditing,
        cancelTableEditingRef,
    } = useTransactionListData({
        showAll,
        search,
        pageSize,
        transactionIdFilter,
        recipientIdFilter,
        categoryIdFilter,
        categoryIdsFilter,
        startDateFilter,
        endDateFilter,
        transactionTypeFilter,
        tagsFilter,
    });

    const updateMutation = useUpdateTransaction();
    const deleteMutation = useDeleteTransaction();
    const bulkTagMutation = useBulkTagTransactions();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const applyTransactionLocalPatch = useCallback((transactionId: number, patch: Record<string, unknown>) => {
        setAllItems(prev => prev.map((item) => {
            if (item.id !== transactionId) return item;
            return { ...item, ...patch };
        }));

        setInfoTransaction(prev => {
            if (!prev || prev.id !== transactionId) return prev;
            return {
                ...prev,
                ...(patch.amount !== undefined ? { amount: Number(patch.amount) } : {}),
                ...(patch.category_name !== undefined ? { category: String(patch.category_name ?? t('txPage.field.uncategorized')) } : {}),
                ...(patch.category_id !== undefined ? { categoryId: Number(patch.category_id) } : {}),
                ...(patch.recipient_name !== undefined ? { recipient: String(patch.recipient_name ?? t('txPage.field.unknown')) } : {}),
                ...(patch.recipient_id !== undefined ? { recipientId: Number(patch.recipient_id) } : {}),
            };
        });
    }, [setAllItems, t]);

    const applyInfoFieldLocally = useCallback((transactionId: number, field: InfoEditableField, value: string | number | undefined) => {
        setAllItems(prev => prev.map((item) => {
            if (item.id !== transactionId) return item;
            switch (field) {
                case 'date':
                    return { ...item, transaction_date: value, date: value };
                case 'memo':
                    return { ...item, memo: value };
                case 'amount':
                    return { ...item, amount: value };
                case 'currency':
                    return { ...item, currency: value };
                case 'bank':
                    return { ...item, bank_account: value };
                case 'balance':
                    return { ...item, balance: value };
                case 'comment':
                    return { ...item, comment: value };
                default:
                    return item;
            }
        }));

        setInfoTransaction(prev => {
            if (!prev || prev.id !== transactionId) return prev;
            switch (field) {
                case 'date':
                    return { ...prev, date: String(value ?? '') };
                case 'memo':
                    return { ...prev, memo: String(value ?? '') };
                case 'amount':
                    return { ...prev, amount: typeof value === 'number' ? value : prev.amount };
                case 'currency':
                    return { ...prev, currency: String(value ?? '') };
                case 'bank':
                    return { ...prev, bank: String(value ?? '') };
                case 'balance':
                    return { ...prev, balance: typeof value === 'number' ? value : undefined };
                case 'comment':
                    return { ...prev, comment: String(value ?? '') };
                default:
                    return prev;
            }
        });
    }, [setAllItems]);

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

    const handleUpdate = (sourceIndex: number, updated: TableTransaction) => {
        const originalTransaction = allItems[sourceIndex];
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
        }, {
            onSuccess: (serverUpdated) => {
                applyTransactionLocalPatch(originalTransaction.id, {
                    amount: serverUpdated.amount,
                    memo: serverUpdated.memo,
                    bank_account: serverUpdated.bank_account,
                    currency: serverUpdated.currency,
                    balance: serverUpdated.balance,
                    comment: serverUpdated.comment,
                    transaction_date: serverUpdated.transaction_date,
                    category_id: serverUpdated.category_id,
                    category_name: serverUpdated.category_name,
                    recipient_id: serverUpdated.recipient_id,
                    recipient_name: serverUpdated.recipient_name,
                });
            },
        });
    };

    const handleSelectCategory = (transactionId: number, catId: number | null, categoryName: string | null) => {
        applyTransactionLocalPatch(transactionId, {
            category_id: catId,
            category_name: categoryName ?? t('txPage.field.uncategorized'),
        });
        updateMutation.mutate({
            id: transactionId,
            data: { category_id: catId ?? undefined },
        }, {
            onSuccess: (updated) => {
                applyTransactionLocalPatch(transactionId, {
                    category_id: updated.category_id,
                    category_name: updated.category_name,
                });
            },
        });
    };

    const handleSelectRecipient = (transactionId: number, recipientId: number | null, recipientName: string | null) => {
        applyTransactionLocalPatch(transactionId, {
            recipient_id: recipientId,
            recipient_name: recipientName ?? t('txPage.field.unknown'),
        });
        updateMutation.mutate({
            id: transactionId,
            data: { recipient_id: recipientId ?? undefined },
        }, {
            onSuccess: (updated) => {
                applyTransactionLocalPatch(transactionId, {
                    recipient_id: updated.recipient_id,
                    recipient_name: updated.recipient_name,
                });
            },
        });
    };

    if (isLoading) {
        return (
            <div className="space-y-8 animate-in">
                <PageHeader title={t('txPage.title')} subtitle={t('txPage.subtitle')} icon={Receipt} />
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
                <PageHeader title={t('txPage.title')} icon={Receipt} />
                <Card>
                    <CardContent className="pt-0">
                        <PageError message={t('txPage.error', { msg: error.message })} />
                    </CardContent>
                </Card>
            </div>
        );
    }

    const transactions: TableTransaction[] = allItems.map((tx) => ({
        id: tx.id,
        date: (tx.transaction_date as string | undefined) || tx.date || '',
        memo: tx.memo || '',
        category: (tx.category_name as string | undefined) || t('txPage.field.uncategorized'),
        categoryId: tx.category_id ?? undefined,
        recipient: (tx.recipient_name as string | undefined) || t('txPage.field.unknown'),
        recipientId: tx.recipient_id ?? 0,
        bank: (tx.bank_account as string | undefined) || tx.bank || '',
        amount: tx.amount ?? 0,
        currency: tx.currency || appSettings.defaultCurrency,
        balance: tx.balance ?? undefined,
        comment: tx.comment || '',
        is_active: tx.is_active ?? true,
        tags: tx.tags ?? [],
    }));

    return (
        <>
            <div className="space-y-8 animate-in">
                <PageHeader
                    title={t('txPage.title')}
                    subtitle={t('txPage.subtitle')}
                    icon={Receipt}
                />

                <FilterBanner
                    transactionIdFilter={transactionIdFilter}
                    recipientIdFilter={recipientIdFilter}
                    categoryIdFilter={categoryIdFilter}
                    categoryIdsFilter={categoryIdsFilter}
                    startDateFilter={startDateFilter}
                    endDateFilter={endDateFilter}
                    transactionTypeFilter={transactionTypeFilter}
                    searchFilter={search || undefined}
                    filterLabel={filterLabel}
                    tagsFilter={tagsFilter}
                    onClear={() => setSearchParams({})}
                    onClearTags={() => {
                        setSearchParams((prev) => {
                            const next = new URLSearchParams(prev);
                            next.delete('tags');
                            return next;
                        });
                    }}
                />

                <TransactionsTable
                    transactions={transactions}
                    allItems={allItems}
                    totalItems={totalItems}
                    isFetchingMore={isFetchingMore}
                    hasMore={hasMoreRef.current}
                    loadMoreOffset={loadMoreOffset}
                    search={search}
                    onSearchChange={setSearch}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSortChange={handleSortChange}
                    onLoadMore={loadMore}
                    onRowUpdate={handleUpdate}
                    onOpenInfo={setInfoTransaction}
                    onToggleActive={toggleActive}
                    onDelete={handleDelete}
                    onSelectCategory={handleSelectCategory}
                    onSelectRecipient={handleSelectRecipient}
                    cancelEditingRef={cancelTableEditingRef}
                    onEditingChange={setEditing}
                    actions={<TableActions showAll={showAll} onToggleShowAll={() => setShowAll(!showAll)} />}
                    updatePending={updateMutation.isPending}
                    deletePending={deleteMutation.isPending}
                    onBulkTag={(ids, addSlugs, removeSlugs) => {
                        bulkTagMutation.mutate({ transaction_ids: ids, add_slugs: addSlugs, remove_slugs: removeSlugs });
                    }}
                />
            </div>
            <ConfirmDialog />
            <TransactionInfoDialog
                infoTransaction={infoTransaction}
                onClose={() => setInfoTransaction(null)}
                onApplyLocal={applyInfoFieldLocally}
            />
        </>
    );
}
