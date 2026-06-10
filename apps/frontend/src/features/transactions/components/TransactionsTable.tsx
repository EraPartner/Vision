import { useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { VirtualDataTable } from "@/components/shared/VirtualDataTable";
import { CategoryCombobox } from "@/components/shared/CategoryCombobox";
import { RecipientCombobox } from "@/components/shared/RecipientCombobox";
import { SplitTransactionDialog } from "@/components/splits/SplitTransactionDialog";
import { TagChip } from "@/components/shared/TagInput";
import { EmptyState } from "@/components/shared/EmptyState";
import { Import, Info, ToggleLeft, ToggleRight, Trash2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { Money } from "@/components/shared/Money";
import { formatDateStringWithAppSettings } from "@/components/shared/dateUtils";
import { getCategoryColor } from "@/utils/categoryColors";
import type { RawApiTransaction, TableTransaction } from "../types";

interface TransactionsTableProps {
    transactions: TableTransaction[];
    allItems: RawApiTransaction[];
    totalItems: number;
    isFetchingMore: boolean;
    hasMore: boolean;
    loadMoreOffset: number;
    search: string;
    onSearchChange: (value: string) => void;
    sortKey: string | null;
    sortDir: "asc" | "desc" | null;
    onSortChange: (key: string | null, dir: "asc" | "desc" | null) => void;
    onLoadMore: () => void | Promise<void>;
    onRowUpdate: (sourceIndex: number, updated: TableTransaction) => void;
    onOpenInfo: (row: TableTransaction) => void;
    onToggleActive: (id: number, currentActive: boolean) => void;
    onDelete: (id: number, description?: string) => void;
    onSelectCategory: (transactionId: number, catId: number | null, categoryName: string | null) => void;
    onSelectRecipient: (transactionId: number, recipientId: number | null, recipientName: string | null) => void;
    cancelEditingRef: React.MutableRefObject<(() => void) | null>;
    onEditingChange: (editing: boolean) => void;
    actions: React.ReactNode;
    updatePending: boolean;
    deletePending: boolean;
    selectedIds: Set<number>;
    onSelectionChange: (next: Set<number>) => void;
}

export function TransactionsTable({
    transactions,
    allItems,
    totalItems,
    isFetchingMore,
    hasMore,
    loadMoreOffset,
    search,
    onSearchChange,
    sortKey,
    sortDir,
    onSortChange,
    onLoadMore,
    onRowUpdate,
    onOpenInfo,
    onToggleActive,
    onDelete,
    onSelectCategory,
    onSelectRecipient,
    cancelEditingRef,
    onEditingChange,
    actions,
    updatePending,
    deletePending,
    selectedIds,
    onSelectionChange,
}: TransactionsTableProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();

    const toggleSelect = useCallback((id: number) => {
        const next = new Set(selectedIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        onSelectionChange(next);
    }, [selectedIds, onSelectionChange]);

    const toggleSelectAll = useCallback(() => {
        if (selectedIds.size === transactions.length) {
            onSelectionChange(new Set());
        } else {
            onSelectionChange(new Set(transactions.map((t) => t.id)));
        }
    }, [selectedIds, transactions, onSelectionChange]);

    const allSelected = transactions.length > 0 && selectedIds.size === transactions.length;
    const someSelected = selectedIds.size > 0 && !allSelected;

    const columns = useMemo(() => [
        {
            key: "select",
            header: (
                <Checkbox
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={toggleSelectAll}
                    aria-label={t('aria.selectAll')}
                />
            ),
            editable: false,
            sortable: false,
            filterable: false,
            defaultWidth: 40,
            minWidth: 36,
            render: (row: TableTransaction) => (
                <Checkbox
                    checked={selectedIds.has(row.id)}
                    onCheckedChange={() => toggleSelect(row.id)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Select transaction ${row.id}`}
                />
            ),
        },
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
                    const original = allItems.find((t) => t.id === row.id);
                    return (
                        <CategoryCombobox
                            value={row.categoryId ?? original?.category_id ?? null}
                            onSelect={(catId, categoryName) => {
                                if (!original) return;
                                onSelectCategory(original.id, catId, categoryName ?? null);
                                cancelEditingRef.current?.();
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
                    const original = allItems.find((t) => t.id === row.id);
                    return (
                        <RecipientCombobox
                            value={row.recipientId ?? original?.recipient_id ?? null}
                            onSelect={(recipientId, recipientName) => {
                                if (!original) return;
                                onSelectRecipient(original.id, recipientId, recipientName ?? null);
                                cancelEditingRef.current?.();
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
            key: "tags",
            header: t('txPage.col.tags'),
            editable: false,
            sortable: false,
            filterable: false,
            defaultWidth: 160,
            minWidth: 120,
            render: (row: TableTransaction) => {
                const tags = row.tags ?? [];
                if (tags.length === 0) return null;
                return (
                    <div className="flex flex-wrap gap-1">
                        {tags.slice(0, 3).map((tag) => (
                            <TagChip key={tag.slug} tag={tag} />
                        ))}
                        {tags.length > 3 && (
                            <Badge variant="outline" className="text-xs py-0 px-1.5 h-5 text-muted-foreground">
                                +{tags.length - 3}
                            </Badge>
                        )}
                    </div>
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
                    {row.amount >= 0 ? '+' : '-'}<Money amount={Math.abs(row.amount)} currency={row.currency} />
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
                        className="icon-touch-target text-muted-foreground hover:text-foreground"
                        onClick={(e) => { e.stopPropagation(); onOpenInfo(row); }}
                        aria-label={t('aria.transactionInfo')}
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
                    onClick={(e) => { e.stopPropagation(); onToggleActive(row.id, row.is_active); }}
                    disabled={updatePending}
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
                    className="icon-touch-target text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    onClick={() => onDelete(row.id, row.memo || row.recipient)}
                    disabled={deletePending}
                    aria-label={t('aria.deleteTransaction')}
                >
                    <Trash2 className="h-4 w-4" />
                </Button>
            ),
        },
    ], [
        t,
        appSettings.dateFormat,
        allSelected,
        someSelected,
        selectedIds,
        toggleSelect,
        toggleSelectAll,
        allItems,
        onSelectCategory,
        onSelectRecipient,
        onOpenInfo,
        onToggleActive,
        onDelete,
        cancelEditingRef,
        updatePending,
        deletePending,
    ]);

    return (
        <VirtualDataTable
            title={t('txPage.tableTitle')}
            subtitle={t('txPage.tableSubtitle', { n: totalItems })}
            columns={columns}
            data={transactions}
            onRowUpdate={onRowUpdate}
            emptyMessage={(
                <EmptyState
                    icon={Import}
                    title={t('txPage.empty')}
                    description={search ? t('txPage.emptySearch') : t('transactions.noTransactions')}
                    action={!search ? (
                        <Button asChild size="sm" variant="outline">
                            <Link to="/import">{t('txPage.importLink')}</Link>
                        </Button>
                    ) : undefined}
                />
            )}
            totalItems={totalItems}
            isFetchingMore={isFetchingMore}
            onLoadMore={onLoadMore}
            hasMore={hasMore}
            loadMoreOffset={loadMoreOffset}
            onSearchChange={onSearchChange}
            searchValue={search}
            onSortChange={onSortChange}
            sortKeyProp={sortKey}
            sortDirProp={sortDir}
            actions={actions}
            maxHeight={700}
            cancelEditingRef={cancelEditingRef}
            onEditingChange={onEditingChange}
        />
    );
}
