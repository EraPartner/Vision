import { useState, useCallback, useRef, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import logger from "@/lib/logger";
import { useLanguage } from "@/contexts/LanguageContext";
import { VirtualDataTable } from "@/components/shared/VirtualDataTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Import, Trash2, Eye, EyeOff, ToggleLeft, ToggleRight, Info, X, Pencil, Check, Receipt } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { useUpdateTransaction, useDeleteTransaction } from "@/hooks/useTransactions";
import { getCategoryColor } from "@/utils/categoryColors";
import { AddTransactionDialog } from "@/components/forms/AddTransactionDialog";
import { CategoryCombobox } from "@/components/shared/CategoryCombobox";
import { RecipientCombobox } from "@/components/shared/RecipientCombobox";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { apiClient } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { SplitTransactionDialog } from "@/components/splits/SplitTransactionDialog";
import type { TransactionUpdate } from "@/types/api";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatDateStringWithAppSettings } from "@/components/shared/dateUtils";

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

type InfoEditableField = 'date' | 'memo' | 'amount' | 'currency' | 'bank' | 'balance' | 'comment';

export default function TransactionsPage() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const pageSize = appSettings.defaultPageSize;
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
    const cancelTableEditingRef = useRef<(() => void) | null>(null);

    // URL-based filters
    const recipientIdFilter = searchParams.get('recipient_id') ? Number(searchParams.get('recipient_id')) : undefined;
    const categoryIdFilter = searchParams.get('category_id') ? Number(searchParams.get('category_id')) : undefined;
    const transactionIdFilter = searchParams.get('transaction_id') ? Number(searchParams.get('transaction_id')) : undefined;
    const filterLabel = searchParams.get('filter_label') || undefined;

    const [infoTransaction, setInfoTransaction] = useState<TableTransaction | null>(null);
    const [editingInfoField, setEditingInfoField] = useState<InfoEditableField | null>(null);
    const [editingInfoValue, setEditingInfoValue] = useState("");
    const updateMutation = useUpdateTransaction();
    const deleteMutation = useDeleteTransaction();
    const { confirm, ConfirmDialog } = useConfirmDialog();
    
    // Track editing state to prevent auto-refresh during edits
    const isEditingRef = useRef(false);
    const setEditing = (editing: boolean) => { isEditingRef.current = editing; };

    // Initial load
    const { data: initialData, isLoading, error } = useQuery({
        queryKey: ['transactions-virtual', { active: !showAll, search: search || undefined, transactionIdFilter, recipientIdFilter, categoryIdFilter, sortKey, sortDir, pageSize }],
        queryFn: () => apiClient.getTransactions({
            limit: pageSize, offset: 0, active: !showAll, search: search || undefined,
            transaction_id: transactionIdFilter,
            recipient_id: recipientIdFilter,
            category_id: categoryIdFilter,
            sort_by: sortKey || undefined,
            sort_dir: sortDir || undefined,
        }),
        staleTime: 30_000,
    });

    // Reset accumulated data when filters change (but not during editing)
    useEffect(() => {
        if (initialData && !isEditingRef.current) {
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
                limit: pageSize,
                offset: offsetRef.current,
                active: !showAll,
                search: search || undefined,
                transaction_id: transactionIdFilter,
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
    }, [showAll, search, transactionIdFilter, recipientIdFilter, categoryIdFilter, sortKey, sortDir, pageSize]);

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

    const applyTransactionLocalPatch = (transactionId: number, patch: Record<string, unknown>) => {
        setAllItems(prev => prev.map((item: any) => {
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

    const startInfoFieldEdit = (field: InfoEditableField, currentValue: string) => {
        setEditingInfoField(field);
        setEditingInfoValue(currentValue);
    };

    const applyInfoFieldLocally = (transactionId: number, field: InfoEditableField, value: string | number | undefined) => {
        setAllItems(prev => prev.map((item: any) => {
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
    };

    const saveInfoFieldEdit = async () => {
        if (!infoTransaction || !editingInfoField) return;
        const trimmed = editingInfoValue.trim();
        const payload: TransactionUpdate = {};
        let localValue: string | number | undefined = trimmed;

        if (editingInfoField === 'amount') {
            const parsed = Number(trimmed);
            if (Number.isNaN(parsed)) return;
            payload.amount = parsed;
            localValue = parsed;
        } else if (editingInfoField === 'balance') {
            if (trimmed.length === 0) {
                payload.balance = undefined;
                localValue = undefined;
            } else {
                const parsed = Number(trimmed);
                if (Number.isNaN(parsed)) return;
                payload.balance = parsed;
                localValue = parsed;
            }
        } else if (editingInfoField === 'date') {
            if (!trimmed) return;
            payload.transaction_date = trimmed;
        } else if (editingInfoField === 'memo') {
            payload.memo = trimmed || undefined;
            localValue = trimmed || '';
        } else if (editingInfoField === 'currency') {
            payload.currency = trimmed || undefined;
        } else if (editingInfoField === 'bank') {
            payload.bank_account = trimmed || undefined;
        } else if (editingInfoField === 'comment') {
            payload.comment = trimmed || undefined;
            localValue = trimmed || '';
        }

        await updateMutation.mutateAsync({ id: infoTransaction.id, data: payload });
        applyInfoFieldLocally(infoTransaction.id, editingInfoField, localValue);
        setEditingInfoField(null);
        setEditingInfoValue("");
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
                <Card><CardContent className="pt-6"><p className="text-destructive">{t('txPage.error', { msg: error.message })}</p></CardContent></Card>
            </div>
        );
    }

    const transactions: TableTransaction[] = allItems.map((tx: any) => ({
        id: tx.id,
        date: tx.transaction_date || tx.date || '',
        memo: tx.memo || '',
        category: tx.category_name || t('txPage.field.uncategorized'),
        categoryId: tx.category_id,
        recipient: tx.recipient_name || t('txPage.field.unknown'),
        recipientId: tx.recipient_id || 0,
        bank: tx.bank_account,
        amount: tx.amount,
        currency: tx.currency || appSettings.defaultCurrency,
        balance: tx.balance,
        comment: tx.comment || '',
        is_active: tx.is_active ?? true,
    }));

    const columns = [
        {
            key: "date",
            header: t('txPage.col.date'),
            editable: true,
            type: "date" as const,
            render: (row: TableTransaction) => (
                <span className={`whitespace-nowrap ${row.is_active ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                    {row.date ? formatDateStringWithAppSettings(row.date, appSettings.dateFormat) : '—'}
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
                            onSelect={(catId, categoryName) => {
                                if (!original) return;
                                applyTransactionLocalPatch(original.id, {
                                    category_id: catId,
                                    category_name: categoryName ?? t('txPage.field.uncategorized'),
                                });
                                updateMutation.mutate({
                                    id: original.id,
                                    data: { category_id: catId ?? undefined },
                                }, {
                                    onSuccess: (updated) => {
                                        applyTransactionLocalPatch(original.id, {
                                            category_id: updated.category_id,
                                            category_name: updated.category_name,
                                        });
                                    },
                                });
                                cancelTableEditingRef.current?.();
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
                            onSelect={(recipientId, recipientName) => {
                                if (!original) return;
                                applyTransactionLocalPatch(original.id, {
                                    recipient_id: recipientId,
                                    recipient_name: recipientName ?? t('txPage.field.unknown'),
                                });
                                updateMutation.mutate({
                                    id: original.id,
                                    data: { recipient_id: recipientId ?? undefined },
                                }, {
                                    onSuccess: (updated) => {
                                        applyTransactionLocalPatch(original.id, {
                                            recipient_id: updated.recipient_id,
                                            recipient_name: updated.recipient_name,
                                        });
                                    },
                                });
                                cancelTableEditingRef.current?.();
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
                    {row.amount >= 0 ? '+' : '-'}{formatCurrency(Math.abs(row.amount), row.currency, locale)}
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

                {(transactionIdFilter || recipientIdFilter || categoryIdFilter) && (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-primary/10 border border-primary/20">
                        <span className="text-sm text-foreground">
                            {t('txPage.filteredBy', {
                                label: filterLabel || (transactionIdFilter
                                    ? `transaction #${transactionIdFilter}`
                                    : recipientIdFilter
                                        ? `recipient #${recipientIdFilter}`
                                        : `category #${categoryIdFilter}`),
                            })}
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
                    searchValue={search}
                    onSortChange={handleSortChange}
                    sortKeyProp={sortKey}
                    sortDirProp={sortDir}
                    actions={tableActions}
                    maxHeight={700}
                    cancelEditingRef={cancelTableEditingRef}
                    onEditingChange={setEditing}
                />
            </div>
            <ConfirmDialog />
            <Dialog
                open={!!infoTransaction}
                onOpenChange={(open) => {
                    if (!open) {
                        setInfoTransaction(null);
                        setEditingInfoField(null);
                        setEditingInfoValue("");
                    }
                }}
            >
                    <DialogContent className="max-w-md">
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                                <Info className="h-4 w-4 text-muted-foreground" />
                                {t('txPage.detailsTitle')}
                            </DialogTitle>
                        </DialogHeader>
                        {infoTransaction && (() => {
                            const txn = infoTransaction;
                            const fields: Array<{
                                key: string;
                                label: string;
                                value?: string;
                                editable?: boolean;
                                editField?: InfoEditableField;
                                editValue?: string;
                                editType?: 'text' | 'number' | 'date';
                            }> = [
                                { key: 'id', label: t('txPage.field.id'), value: String(txn.id) },
                                {
                                    key: 'date',
                                    label: t('txPage.field.date'),
                                    value: txn.date ? formatDateStringWithAppSettings(txn.date, appSettings.dateFormat) : '—',
                                    editable: true,
                                    editField: 'date',
                                    editValue: txn.date ? txn.date.split('T')[0] : '',
                                    editType: 'date',
                                },
                                {
                                    key: 'description',
                                    label: t('txPage.field.description'),
                                    value: txn.memo || undefined,
                                    editable: true,
                                    editField: 'memo',
                                    editValue: txn.memo || '',
                                    editType: 'text',
                                },
                                { key: 'recipient', label: t('txPage.field.recipient'), value: txn.recipient !== t('txPage.field.unknown') ? txn.recipient : undefined },
                                { key: 'category', label: t('txPage.field.category'), value: txn.category !== t('txPage.field.uncategorized') ? txn.category : undefined },
                                {
                                    key: 'amount',
                                    label: t('txPage.field.amount'),
                                    value: `${txn.amount >= 0 ? '+' : '-'}${formatCurrency(Math.abs(txn.amount), txn.currency, locale)}`,
                                    editable: true,
                                    editField: 'amount',
                                    editValue: String(txn.amount),
                                    editType: 'number',
                                },
                                {
                                    key: 'currency',
                                    label: t('txPage.field.currency'),
                                    value: txn.currency,
                                    editable: true,
                                    editField: 'currency',
                                    editValue: txn.currency || '',
                                    editType: 'text',
                                },
                                {
                                    key: 'bankAccount',
                                    label: t('txPage.field.bankAccount'),
                                    value: txn.bank,
                                    editable: true,
                                    editField: 'bank',
                                    editValue: txn.bank || '',
                                    editType: 'text',
                                },
                                {
                                    key: 'balance',
                                    label: t('txPage.field.balance'),
                                    value: txn.balance != null ? formatCurrency(txn.balance, txn.currency, locale) : undefined,
                                    editable: true,
                                    editField: 'balance',
                                    editValue: txn.balance != null ? String(txn.balance) : '',
                                    editType: 'number',
                                },
                                {
                                    key: 'comment',
                                    label: t('txPage.field.comment'),
                                    value: txn.comment || undefined,
                                    editable: true,
                                    editField: 'comment',
                                    editValue: txn.comment || '',
                                    editType: 'text',
                                },
                                { key: 'status', label: t('txPage.field.status'), value: txn.is_active ? t('txPage.statusActive') : t('txPage.statusInactive') },
                            ];
                            return (
                                <div className="divide-y divide-border">
                                    {fields.map(({ key, label, value, editable, editField, editValue, editType }) => (
                                        value ? (
                                            <div key={key} className="flex justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
                                                <span className="text-sm text-muted-foreground shrink-0">{label}</span>
                                                {editable && editField && editingInfoField === editField ? (
                                                    <div className="flex items-center gap-1.5 min-w-0">
                                                        <Input
                                                            type={editType ?? 'text'}
                                                            value={editingInfoValue}
                                                            onChange={(e) => setEditingInfoValue(e.target.value)}
                                                            className="h-8 w-40"
                                                        />
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className="h-7 w-7"
                                                            onClick={() => { void saveInfoFieldEdit(); }}
                                                            disabled={updateMutation.isPending}
                                                            title={t('common.save')}
                                                        >
                                                            <Check className="h-3.5 w-3.5" />
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className="h-7 w-7"
                                                            onClick={() => { setEditingInfoField(null); setEditingInfoValue(""); }}
                                                            disabled={updateMutation.isPending}
                                                            title={t('common.cancel')}
                                                        >
                                                            <X className="h-3.5 w-3.5" />
                                                        </Button>
                                                    </div>
                                                ) : (
                                                    <div className="flex items-center gap-1">
                                                        <span className="text-sm font-medium text-right break-all">{value}</span>
                                                        {editable && editField ? (
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                                                onClick={() => startInfoFieldEdit(editField, editValue ?? '')}
                                                                title={t('common.edit')}
                                                            >
                                                                <Pencil className="h-3.5 w-3.5" />
                                                            </Button>
                                                        ) : null}
                                                    </div>
                                                )}
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
