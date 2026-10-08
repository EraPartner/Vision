import { useCallback, useMemo } from "react";
import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuShortcut,
} from "@/components/ui/context-menu";
import {
    VirtualDataTable,
    type VirtualTableServerMode,
} from "@/components/shared/VirtualDataTable";
import { CategoryCombobox } from "@/components/shared/CategoryCombobox";
import { RecipientCombobox } from "@/components/shared/RecipientCombobox";
import { TagChip } from "@/components/shared/TagInput";
import { EmptyState } from "@/components/shared/EmptyState";
import {
    Copy,
    Eye,
    Filter,
    Import,
    Info,
    Pencil,
    ToggleLeft,
    ToggleRight,
    Trash2,
} from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { Money } from "@/components/shared/Money";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { getCategoryChartColor } from "@/utils/categoryColors";
import { cn } from "@/lib/utils";
import type { Column } from "@/types/dataTable";
import type { RawApiTransaction, TableTransaction } from "../types";
import { amountClass } from "../amountClass";

interface TransactionsTableProps {
    transactions: TableTransaction[];
    allItems: RawApiTransaction[];
    /** Server sort + search + pagination config, forwarded to VirtualDataTable. */
    serverMode: VirtualTableServerMode;
    onRowUpdate: (sourceIndex: number, updated: TableTransaction) => void;
    /** Selects the row the inspector shows (click, Enter, arrow keys). */
    onSelectRow: (row: TableTransaction | null) => void;
    selectedRowId: number | null;
    onQuickLook: (row: TableTransaction) => void;
    onDuplicate: (row: TableTransaction) => void;
    onFilterByRecipient: (row: TableTransaction) => void;
    onToggleActive: (id: number, currentActive: boolean) => void;
    onDelete: (id: number, description?: string) => void;
    onSelectCategory: (
        transactionId: number,
        catId: number | null,
        categoryName: string | null,
    ) => void;
    onSelectRecipient: (
        transactionId: number,
        recipientId: number | null,
        recipientName: string | null,
    ) => void;
    cancelEditingRef: React.MutableRefObject<(() => void) | null>;
    onEditingChange: (editing: boolean) => void;
    actions?: React.ReactNode;
    updatePending: boolean;
    deletePending: boolean;
    selectedIds: Set<number>;
    onSelectionChange: (next: Set<number>) => void;
    /** Optional columns the View menu turned on (ids from transactionColumns.ts). */
    isColumnVisible: (id: string) => boolean;
}

export function TransactionsTable({
    transactions,
    allItems,
    serverMode,
    onRowUpdate,
    onSelectRow,
    selectedRowId,
    onQuickLook,
    onDuplicate,
    onFilterByRecipient,
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
    isColumnVisible,
}: TransactionsTableProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const fmt = useCurrencyFormatter();
    const uncategorisedLabel = t("txPage.field.uncategorized");
    const getRowLabel = useCallback(
        (row: TableTransaction) =>
            [
                formatDateStringWithAppSettings(
                    row.date,
                    appSettings.dateFormat,
                ),
                row.recipient,
                fmt(row.amount, { currency: row.currency }),
            ]
                .filter(Boolean)
                .join(", "),
        [appSettings.dateFormat, fmt],
    );

    const search = serverMode.search?.value ?? "";

    const toggleSelect = useCallback(
        (id: number) => {
            const next = new Set(selectedIds);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            onSelectionChange(next);
        },
        [selectedIds, onSelectionChange],
    );

    const toggleSelectAll = useCallback(() => {
        if (selectedIds.size === transactions.length) {
            onSelectionChange(new Set());
        } else {
            onSelectionChange(new Set(transactions.map((t) => t.id)));
        }
    }, [selectedIds, transactions, onSelectionChange]);

    const allSelected =
        transactions.length > 0 && selectedIds.size === transactions.length;
    const someSelected = selectedIds.size > 0 && !allSelected;

    const showTags = isColumnVisible("tags");
    const showCurrency = isColumnVisible("currency");
    const showRunningBalance = isColumnVisible("runningBalance");
    const showStatus = isColumnVisible("is_active");

    const columns = useMemo<Column<TableTransaction>[]>(() => {
        const inactive = (row: TableTransaction) => !row.is_active;
        const core: Column<TableTransaction>[] = [
            {
                key: "select",
                header: (
                    <Checkbox
                        checked={
                            allSelected
                                ? true
                                : someSelected
                                  ? "indeterminate"
                                  : false
                        }
                        onCheckedChange={toggleSelectAll}
                        aria-label={t("aria.selectAll")}
                    />
                ),
                editable: false,
                sortable: false,
                filterable: false,
                defaultWidth: 40,
                minWidth: 36,
                className: "px-2 text-clip",
                render: (row) => (
                    <Checkbox
                        checked={selectedIds.has(row.id)}
                        onCheckedChange={() => toggleSelect(row.id)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`${t("aria.selectTransaction")}: ${getRowLabel(row)}`}
                    />
                ),
            },
            {
                key: "date",
                header: t("txPage.col.date"),
                editable: true,
                type: "date",
                defaultWidth: 128,
                minWidth: 104,
                render: (row) => (
                    <span
                        className={cn(
                            "whitespace-nowrap tabular-nums",
                            inactive(row)
                                ? "text-label-tertiary line-through"
                                : "text-label-secondary",
                        )}
                    >
                        {row.date
                            ? formatDateStringWithAppSettings(
                                  row.date,
                                  appSettings.dateFormat,
                              )
                            : "—"}
                    </span>
                ),
            },
            {
                key: "recipient",
                header: t("txPage.col.recipient"),
                editable: false,
                render: (row, isEditing) => {
                    if (isEditing) {
                        const original = allItems.find((t) => t.id === row.id);
                        return (
                            <RecipientCombobox
                                value={
                                    row.recipientId ??
                                    original?.recipient_id ??
                                    null
                                }
                                onSelect={(recipientId, recipientName) => {
                                    if (!original) return;
                                    onSelectRecipient(
                                        original.id,
                                        recipientId,
                                        recipientName ?? null,
                                    );
                                    cancelEditingRef.current?.();
                                }}
                                className="w-full"
                            />
                        );
                    }
                    return (
                        <span className="flex min-w-0 flex-col leading-tight">
                            <span
                                className={cn(
                                    "truncate font-medium",
                                    inactive(row)
                                        ? "text-label-tertiary line-through"
                                        : "text-foreground",
                                )}
                            >
                                {row.recipient}
                            </span>
                            {row.memo && (
                                <span className="truncate type-footnote text-label-secondary">
                                    {row.memo}
                                </span>
                            )}
                        </span>
                    );
                },
            },
            {
                key: "category",
                header: t("txPage.col.category"),
                editable: false,
                defaultWidth: 180,
                minWidth: 120,
                render: (row, isEditing) => {
                    if (isEditing) {
                        const original = allItems.find((t) => t.id === row.id);
                        return (
                            <CategoryCombobox
                                value={
                                    row.categoryId ??
                                    original?.category_id ??
                                    null
                                }
                                onSelect={(catId, categoryName) => {
                                    if (!original) return;
                                    onSelectCategory(
                                        original.id,
                                        catId,
                                        categoryName ?? null,
                                    );
                                    cancelEditingRef.current?.();
                                }}
                                className="w-full"
                            />
                        );
                    }
                    const uncategorised =
                        !row.categoryId || row.category === uncategorisedLabel;
                    return (
                        <span
                            className={cn(
                                "flex min-w-0 items-center gap-2",
                                inactive(row) && "opacity-50",
                            )}
                        >
                            <span
                                aria-hidden="true"
                                className={cn(
                                    "h-2 w-2 shrink-0 rounded-full",
                                    uncategorised &&
                                        "border border-dashed border-label-tertiary",
                                )}
                                style={
                                    uncategorised
                                        ? undefined
                                        : {
                                              backgroundColor:
                                                  getCategoryChartColor(
                                                      row.category,
                                                  ),
                                          }
                                }
                            />
                            <span
                                className={cn(
                                    "truncate",
                                    uncategorised
                                        ? "text-label-tertiary"
                                        : "text-foreground",
                                )}
                            >
                                {uncategorised
                                    ? t("txPage.needsCategory")
                                    : row.category}
                            </span>
                        </span>
                    );
                },
            },
            {
                key: "bank",
                header: t("txPage.col.account"),
                editable: false,
                defaultWidth: 150,
                minWidth: 100,
                render: (row) => (
                    <span
                        className={cn(
                            "truncate",
                            inactive(row)
                                ? "text-label-tertiary"
                                : "text-label-secondary",
                        )}
                    >
                        {row.bank}
                    </span>
                ),
            },
        ];
        const optional: Column<TableTransaction>[] = [];
        if (showTags)
            optional.push({
                key: "tags",
                header: t("txPage.col.tags"),
                editable: false,
                sortable: false,
                filterable: false,
                defaultWidth: 160,
                minWidth: 120,
                render: (row) => {
                    const tags = row.tags ?? [];
                    if (tags.length === 0) return null;
                    return (
                        <div className="flex flex-wrap gap-1">
                            {tags.slice(0, 3).map((tag) => (
                                <TagChip key={tag.slug} tag={tag} />
                            ))}
                            {tags.length > 3 && (
                                <Badge
                                    variant="outline"
                                    size="sm"
                                    className="text-label-secondary"
                                >
                                    +{tags.length - 3}
                                </Badge>
                            )}
                        </div>
                    );
                },
            });
        if (showCurrency)
            optional.push({
                key: "currency",
                header: t("txPage.col.currency"),
                editable: false,
                defaultWidth: 76,
                minWidth: 68,
                render: (row) => (
                    <span className="eyebrow text-label-secondary">
                        {row.currency}
                    </span>
                ),
            });
        const amount: Column<TableTransaction> = {
            key: "amount",
            header: t("txPage.col.amount"),
            editable: true,
            type: "number",
            defaultWidth: 120,
            minWidth: 90,
            className: "text-right",
            render: (row) => (
                <span
                    className={cn(
                        "whitespace-nowrap font-medium tabular-nums",
                        amountClass(row.amount),
                        inactive(row) && "opacity-50 line-through",
                    )}
                >
                    <Money signed amount={row.amount} currency={row.currency} />
                </span>
            ),
        };
        const trailing: Column<TableTransaction>[] = [];
        if (showRunningBalance)
            trailing.push({
                key: "runningBalance",
                header: t("txPage.col.runningBalance"),
                editable: false,
                sortable: false,
                filterable: false,
                defaultWidth: 130,
                minWidth: 100,
                className: "text-right",
                render: (row) => (
                    <span className="whitespace-nowrap tabular-nums text-label-secondary">
                        {row.runningBalance == null ? (
                            "—"
                        ) : (
                            <Money
                                amount={row.runningBalance}
                                currency={row.currency}
                            />
                        )}
                    </span>
                ),
            });
        if (showStatus)
            trailing.push({
                key: "is_active",
                header: t("txPage.col.status"),
                editable: false,
                defaultWidth: 145,
                minWidth: 130,
                render: (row) => (
                    <Button
                        variant="ghost"
                        size="sm"
                        className={cn(
                            "gap-1.5",
                            row.is_active
                                ? "text-accent hover:text-accent"
                                : "text-label-secondary opacity-60",
                        )}
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggleActive(row.id, row.is_active);
                        }}
                        disabled={updatePending}
                        aria-pressed={row.is_active}
                        aria-label={`${t("txPage.statusActive")}: ${getRowLabel(row)}`}
                    >
                        {row.is_active ? (
                            <ToggleRight className="h-4 w-4" />
                        ) : (
                            <ToggleLeft className="h-4 w-4" />
                        )}
                        {row.is_active
                            ? t("txPage.statusActive")
                            : t("txPage.statusInactive")}
                    </Button>
                ),
            });
        return [...core, ...optional, amount, ...trailing];
    }, [
        t,
        appSettings.dateFormat,
        getRowLabel,
        allSelected,
        someSelected,
        selectedIds,
        toggleSelect,
        toggleSelectAll,
        allItems,
        onSelectCategory,
        onSelectRecipient,
        onToggleActive,
        cancelEditingRef,
        updatePending,
        uncategorisedLabel,
        showTags,
        showCurrency,
        showRunningBalance,
        showStatus,
    ]);

    const rowContextMenu = useCallback(
        (
            row: TableTransaction,
            _sourceIndex: number,
            helpers: { startEditing: () => void },
        ) => {
            const hasRecipient = !!row.recipientId;
            // Mirrors the create contract (recipient_id + date + bank_account
            // required) — same gate the delete-undo restore uses.
            const canDuplicate = hasRecipient && !!row.date && !!row.bank;
            return (
                <ContextMenuContent className="w-60">
                    <ContextMenuItem onSelect={() => onSelectRow(row)}>
                        <Info className="mr-2 h-4 w-4 text-label-secondary" />
                        {t("contextMenu.info")}
                        <ContextMenuShortcut>↵</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => onQuickLook(row)}>
                        <Eye className="mr-2 h-4 w-4 text-label-secondary" />
                        {t("contextMenu.quickLook")}
                        <ContextMenuShortcut>␣</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={helpers.startEditing}>
                        <Pencil className="mr-2 h-4 w-4 text-label-secondary" />
                        {t("contextMenu.editInline")}
                    </ContextMenuItem>
                    {(canDuplicate || hasRecipient) && <ContextMenuSeparator />}
                    {canDuplicate && (
                        <ContextMenuItem onSelect={() => onDuplicate(row)}>
                            <Copy className="mr-2 h-4 w-4 text-label-secondary" />
                            {t("contextMenu.duplicate")}
                        </ContextMenuItem>
                    )}
                    {hasRecipient && (
                        <ContextMenuItem
                            onSelect={() => onFilterByRecipient(row)}
                        >
                            <Filter className="mr-2 h-4 w-4 text-label-secondary" />
                            {t("contextMenu.showAllFromRecipient", {
                                name: row.recipient,
                            })}
                        </ContextMenuItem>
                    )}
                    <ContextMenuSeparator />
                    <ContextMenuItem
                        onSelect={() => onToggleActive(row.id, row.is_active)}
                        disabled={updatePending}
                    >
                        {row.is_active ? (
                            <ToggleLeft className="mr-2 h-4 w-4 text-label-secondary" />
                        ) : (
                            <ToggleRight className="mr-2 h-4 w-4 text-label-secondary" />
                        )}
                        {row.is_active
                            ? t("contextMenu.markInactive")
                            : t("contextMenu.markActive")}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                        onSelect={() =>
                            onDelete(row.id, row.memo || row.recipient)
                        }
                        disabled={deletePending}
                        variant="destructive"
                    >
                        <Trash2 className="mr-2 h-4 w-4" />
                        {t("contextMenu.delete")}
                    </ContextMenuItem>
                </ContextMenuContent>
            );
        },
        [
            t,
            onSelectRow,
            onQuickLook,
            onDuplicate,
            onFilterByRecipient,
            onToggleActive,
            onDelete,
            updatePending,
            deletePending,
        ],
    );

    const selectRow = useCallback(
        (row: TableTransaction) => onSelectRow(row),
        [onSelectRow],
    );

    return (
        <VirtualDataTable
            columns={columns}
            data={transactions}
            getRowLabel={getRowLabel}
            onRowUpdate={onRowUpdate}
            onRowOpen={selectRow}
            onRowSelect={selectRow}
            selectedRowKey={selectedRowId}
            onRowQuickLook={onQuickLook}
            rowContextMenu={rowContextMenu}
            rowHeight={52}
            emptyMessage={
                <EmptyState
                    headingLevel={3}
                    icon={Import}
                    title={t("txPage.empty")}
                    description={
                        search
                            ? t("txPage.emptySearch")
                            : t("transactions.noTransactions")
                    }
                    action={
                        !search ? (
                            <Button asChild size="sm" variant="outline">
                                <Link to="/import">
                                    {t("txPage.importLink")}
                                </Link>
                            </Button>
                        ) : undefined
                    }
                />
            }
            serverMode={serverMode}
            actions={actions}
            maxHeight={720}
            cancelEditingRef={cancelEditingRef}
            onEditingChange={onEditingChange}
            scrollRestorationKey="transactions"
        />
    );
}
