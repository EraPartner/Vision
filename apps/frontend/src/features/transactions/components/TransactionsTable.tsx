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
import { SplitTransactionDialog } from "@/features/splits/SplitTransactionDialog";
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
import { Money } from "@/components/shared/Money";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { getCategoryColor } from "@/utils/categoryColors";
import { cn } from "@/lib/utils";
import type { RawApiTransaction, TableTransaction } from "../types";

interface TransactionsTableProps {
    transactions: TableTransaction[];
    allItems: RawApiTransaction[];
    /** Server sort + search + pagination config, forwarded to VirtualDataTable. */
    serverMode: VirtualTableServerMode;
    onRowUpdate: (sourceIndex: number, updated: TableTransaction) => void;
    onOpenInfo: (row: TableTransaction) => void;
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
    actions: React.ReactNode;
    updatePending: boolean;
    deletePending: boolean;
    selectedIds: Set<number>;
    onSelectionChange: (next: Set<number>) => void;
}

export function TransactionsTable({
    transactions,
    allItems,
    serverMode,
    onRowUpdate,
    onOpenInfo,
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
}: TransactionsTableProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();

    // Display values sourced from the same server-mode config the table runs on
    // (always provided by TransactionsPage; fallbacks only satisfy the types).
    const totalItems = serverMode.pagination?.totalItems ?? 0;
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

    const columns = useMemo(
        () => [
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
                header: t("txPage.col.date"),
                editable: true,
                type: "date" as const,
                render: (row: TableTransaction) => (
                    <span
                        className={cn(
                            "whitespace-nowrap",
                            row.is_active
                                ? "text-foreground"
                                : "text-muted-foreground line-through",
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
                key: "category",
                header: t("txPage.col.category"),
                editable: false,
                render: (row: TableTransaction, isEditing: boolean) => {
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
                    return (
                        <Badge
                            variant="outline"
                            className={cn(
                                "font-medium",
                                getCategoryColor(row.category),
                                !row.is_active && "opacity-50 line-through",
                            )}
                        >
                            {row.category}
                        </Badge>
                    );
                },
            },
            {
                key: "recipient",
                header: t("txPage.col.recipient"),
                editable: false,
                render: (row: TableTransaction, isEditing: boolean) => {
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
                        <span
                            className={
                                row.is_active
                                    ? "text-foreground"
                                    : "text-muted-foreground line-through"
                            }
                        >
                            {row.recipient}
                        </span>
                    );
                },
            },
            {
                key: "tags",
                header: t("txPage.col.tags"),
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
                                <Badge
                                    variant="outline"
                                    className="text-xs py-0 px-1.5 h-5 text-muted-foreground"
                                >
                                    +{tags.length - 3}
                                </Badge>
                            )}
                        </div>
                    );
                },
            },
            {
                key: "currency",
                header: t("txPage.col.currency"),
                editable: false,
                defaultWidth: 76,
                minWidth: 68,
                render: (row: TableTransaction) => (
                    <span className="eyebrow text-muted-foreground">
                        {row.currency}
                    </span>
                ),
            },
            {
                key: "amount",
                header: t("txPage.col.amount"),
                editable: true,
                type: "number" as const,
                defaultWidth: 90,
                minWidth: 70,
                className: "text-right",
                render: (row: TableTransaction) => (
                    <span
                        className={cn(
                            "font-medium whitespace-nowrap",
                            row.amount >= 0 ? "text-gain" : "text-loss",
                            !row.is_active && "opacity-50 line-through",
                        )}
                    >
                        <Money
                            signed
                            amount={row.amount}
                            currency={row.currency}
                        />
                    </span>
                ),
            },
            {
                key: "runningBalance",
                header: t("txPage.col.runningBalance"),
                editable: false,
                sortable: false,
                filterable: false,
                defaultWidth: 120,
                minWidth: 100,
                className: "text-right",
                render: (row: TableTransaction) => (
                    <span className="whitespace-nowrap tabular-nums">
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
            },
            {
                key: "info",
                header: t("txPage.col.info"),
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
                            onClick={(e) => {
                                e.stopPropagation();
                                onOpenInfo(row);
                            }}
                            aria-label={t("aria.transactionInfo")}
                        >
                            <Info className="h-4 w-4" />
                        </Button>
                    </div>
                ),
            },
            {
                key: "is_active",
                header: t("txPage.col.status"),
                editable: false,
                defaultWidth: 145,
                minWidth: 130,
                render: (row: TableTransaction) => (
                    <Button
                        variant="ghost"
                        size="sm"
                        className={cn(
                            "gap-1.5",
                            row.is_active
                                ? "text-accent hover:text-accent"
                                : "text-muted-foreground hover:text-muted-foreground opacity-50",
                        )}
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggleActive(row.id, row.is_active);
                        }}
                        disabled={updatePending}
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
                        onClick={() =>
                            onDelete(row.id, row.memo || row.recipient)
                        }
                        disabled={deletePending}
                        aria-label={t("aria.deleteTransaction")}
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                ),
            },
        ],
        [
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
        ],
    );

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
                    <ContextMenuItem onSelect={() => onOpenInfo(row)}>
                        <Info className="mr-2 h-4 w-4 text-muted-foreground" />
                        {t("contextMenu.info")}
                        <ContextMenuShortcut>↵</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => onQuickLook(row)}>
                        <Eye className="mr-2 h-4 w-4 text-muted-foreground" />
                        {t("contextMenu.quickLook")}
                        <ContextMenuShortcut>␣</ContextMenuShortcut>
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={helpers.startEditing}>
                        <Pencil className="mr-2 h-4 w-4 text-muted-foreground" />
                        {t("contextMenu.editInline")}
                    </ContextMenuItem>
                    {(canDuplicate || hasRecipient) && <ContextMenuSeparator />}
                    {canDuplicate && (
                        <ContextMenuItem onSelect={() => onDuplicate(row)}>
                            <Copy className="mr-2 h-4 w-4 text-muted-foreground" />
                            {t("contextMenu.duplicate")}
                        </ContextMenuItem>
                    )}
                    {hasRecipient && (
                        <ContextMenuItem
                            onSelect={() => onFilterByRecipient(row)}
                        >
                            <Filter className="mr-2 h-4 w-4 text-muted-foreground" />
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
                            <ToggleLeft className="mr-2 h-4 w-4 text-muted-foreground" />
                        ) : (
                            <ToggleRight className="mr-2 h-4 w-4 text-muted-foreground" />
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
                        className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                    >
                        <Trash2 className="mr-2 h-4 w-4" />
                        {t("contextMenu.delete")}
                    </ContextMenuItem>
                </ContextMenuContent>
            );
        },
        [
            t,
            onOpenInfo,
            onQuickLook,
            onDuplicate,
            onFilterByRecipient,
            onToggleActive,
            onDelete,
            updatePending,
            deletePending,
        ],
    );

    return (
        <VirtualDataTable
            title={t("txPage.tableTitle")}
            subtitle={t("txPage.tableSubtitle", { n: totalItems })}
            columns={columns}
            data={transactions}
            onRowUpdate={onRowUpdate}
            onRowOpen={onOpenInfo}
            onRowQuickLook={onQuickLook}
            rowContextMenu={rowContextMenu}
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
            maxHeight={700}
            cancelEditingRef={cancelEditingRef}
            onEditingChange={onEditingChange}
        />
    );
}
