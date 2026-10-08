import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    ChevronDown,
    ArrowLeftRight,
    Download,
    FolderTree,
    Split,
    Tag,
    ToggleLeft,
    ToggleRight,
    Trash2,
    UserCog,
} from "lucide-react";
import type {
    BulkExportRequest,
    BulkSelectionRequest,
    BulkTagRequest,
    BulkTransactionFilter,
    BulkUpdateRequest,
} from "@/types/api";
import {
    useBulkDeleteTransactions,
    useBulkExportTransactions,
    useBulkTagTransactions,
    useBulkUpdateTransactions,
} from "@/hooks/useTransactions";
import { useBulkSplitTransactions } from "@/hooks/useSplits";
import type { BulkSplitMode } from "@/lib/api/splits";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { toast } from "sonner";
import {
    eligibleExistingTransferPair,
    useMarkTransfer,
    type ExistingTransferLeg,
} from "@/features/transactions/hooks/useMarkTransfer";
import { BulkRecategorizeDialog } from "./BulkRecategorizeDialog";
import { BulkRecipientDialog } from "./BulkRecipientDialog";
import { BulkTagDialog } from "./BulkTagDialog";
import { BulkExportDialog } from "./BulkExportDialog";
import { BulkSplitDialog } from "./BulkSplitDialog";

export type BulkSelectionMode = "ids" | "filter";

interface BulkActionsBarProps {
    selectedIds: Set<number>;
    selectionMode: BulkSelectionMode;
    totalMatching: number;
    visibleItemCount: number;
    filter: BulkTransactionFilter;
    onClearSelection: () => void;
    onPromoteToFilterMode: () => void;
    selectedTransactions?: readonly ExistingTransferLeg[];
}

export function BulkActionsBar({
    selectedIds,
    selectionMode,
    totalMatching,
    visibleItemCount,
    filter,
    onClearSelection,
    onPromoteToFilterMode,
    selectedTransactions = [],
}: BulkActionsBarProps) {
    const { t, tc } = useLanguage();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const bulkDelete = useBulkDeleteTransactions();
    const bulkUpdate = useBulkUpdateTransactions();
    const bulkExport = useBulkExportTransactions();
    const bulkTag = useBulkTagTransactions();
    const bulkSplit = useBulkSplitTransactions();
    const markTransfer = useMarkTransfer();

    const [tagOpen, setTagOpen] = useState(false);
    const [categoryOpen, setCategoryOpen] = useState(false);
    const [recipientOpen, setRecipientOpen] = useState(false);
    const [exportOpen, setExportOpen] = useState(false);
    const [splitOpen, setSplitOpen] = useState(false);

    const idCount = selectedIds.size;
    const effectiveCount = selectionMode === "filter" ? totalMatching : idCount;
    const transferLegs = selectedTransactions.filter((row) =>
        selectedIds.has(row.id),
    );
    const canMarkTransfer =
        selectionMode === "ids" &&
        idCount === 2 &&
        eligibleExistingTransferPair(transferLegs);
    const transferSelectionKey = JSON.stringify({
        selectionMode,
        ids: [...selectedIds].sort((a, b) => a - b),
        legs: transferLegs,
    });
    const latestTransferSelectionKey = useRef(transferSelectionKey);
    latestTransferSelectionKey.current = transferSelectionKey;

    if (idCount === 0) return null;

    const showSelectAllMatching =
        selectionMode === "ids" &&
        idCount === visibleItemCount &&
        totalMatching > visibleItemCount;

    function buildSelector(): BulkSelectionRequest {
        if (selectionMode === "filter") {
            return { filter, expected_count: totalMatching };
        }
        return { ids: Array.from(selectedIds) };
    }

    async function handleDelete() {
        const ok = await confirm({
            title: tc("txPage.bulk.confirmDeleteTitle", effectiveCount),
            description: tc("txPage.bulk.confirmDeleteBody", effectiveCount),
            confirmLabel: t("txPage.bulk.delete"),
            variant: "destructive",
        });
        if (!ok) return;
        bulkDelete.mutate(buildSelector(), {
            onSuccess: () => onClearSelection(),
        });
    }

    async function handleMarkTransfer() {
        if (!canMarkTransfer || !eligibleExistingTransferPair(transferLegs))
            return;
        const [first, second] = transferLegs;
        const confirmed = await confirm({
            title: t("txPage.bulk.confirmTransferTitle"),
            description: t("txPage.bulk.confirmTransferBody", {
                firstId: first.id,
                firstAccount: first.bank || String(first.accountId),
                firstDate: first.date,
                firstAmount: first.amount,
                firstCurrency: first.currency,
                secondId: second.id,
                secondAccount: second.bank || String(second.accountId),
                secondDate: second.date,
                secondAmount: second.amount,
                secondCurrency: second.currency,
            }),
            confirmLabel: t("txPage.bulk.markTransfer"),
        });
        if (!confirmed) return;
        if (latestTransferSelectionKey.current !== transferSelectionKey) {
            toast.error(t("txPage.bulk.failed"), {
                description: t("txPage.bulk.transferSelectionChanged"),
            });
            return;
        }
        markTransfer.mutate(transferLegs, {
            onSuccess: () => onClearSelection(),
        });
    }

    async function handleSetActive(active: boolean) {
        if (!active) {
            const ok = await confirm({
                title: t("txPage.bulk.confirmDeactivateTitle", {
                    n: effectiveCount,
                }),
                description: t("txPage.bulk.confirmDeactivateBody"),
                confirmLabel: t("txPage.bulk.deactivate"),
            });
            if (!ok) return;
        }
        const request: BulkUpdateRequest = {
            ...buildSelector(),
            fields: { is_active: active },
        };
        bulkUpdate.mutate(request, { onSuccess: () => onClearSelection() });
    }

    function handleRecategorize(categoryId: number | null) {
        const request: BulkUpdateRequest = {
            ...buildSelector(),
            fields: { category_id: categoryId },
        };
        bulkUpdate.mutate(request, {
            onSuccess: () => {
                setCategoryOpen(false);
                onClearSelection();
            },
        });
    }

    function handleReassignRecipient(recipientId: number) {
        const request: BulkUpdateRequest = {
            ...buildSelector(),
            fields: { recipient_id: recipientId },
        };
        bulkUpdate.mutate(request, {
            onSuccess: () => {
                setRecipientOpen(false);
                onClearSelection();
            },
        });
    }

    function handleExport(format: "csv" | "json") {
        const request: BulkExportRequest = { ...buildSelector(), format };
        bulkExport.mutate(request, {
            onSuccess: () => setExportOpen(false),
        });
    }

    function handleTagApply(addSlugs: string[], removeSlugs: string[]) {
        // Bulk tag uses the legacy id-only contract. For filter-mode, fall back to
        // the resolved selection: backend ids endpoint expects an array.
        const ids = selectionMode === "filter" ? null : Array.from(selectedIds);
        if (ids === null) {
            // Filter-mode tagging is intentionally unsupported until the bulk-tag
            // route accepts a filter selector — keep selection-mode-aware UX honest.
            return;
        }
        const request: BulkTagRequest = {
            transaction_ids: ids,
            add_slugs: addSlugs,
            remove_slugs: removeSlugs,
        };
        bulkTag.mutate(request, {
            onSuccess: () => {
                setTagOpen(false);
                onClearSelection();
            },
        });
    }

    function handleSplitApply(recipientId: number, mode: BulkSplitMode) {
        // Ids only, like bulk tag: a preset share is computed per row on the
        // server, and the bulk-split route takes an explicit id list.
        if (selectionMode === "filter") return;
        bulkSplit.mutate(
            {
                transaction_ids: Array.from(selectedIds),
                recipient_id: recipientId,
                mode,
            },
            {
                onSuccess: () => {
                    setSplitOpen(false);
                    onClearSelection();
                },
            },
        );
    }

    const updateBusy = bulkUpdate.isPending;
    const deleteBusy = bulkDelete.isPending;
    const exportBusy = bulkExport.isPending;
    const tagBusy = bulkTag.isPending;
    const splitBusy = bulkSplit.isPending;
    const anyBusy =
        updateBusy ||
        deleteBusy ||
        exportBusy ||
        tagBusy ||
        splitBusy ||
        markTransfer.isPending;

    return (
        <>
            <div className="flex items-center gap-2 flex-wrap">
                <span className="type-body font-medium text-foreground">
                    {t("txPage.bulk.nSelected", { n: effectiveCount })}
                </span>

                {showSelectAllMatching && (
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={onPromoteToFilterMode}
                        disabled={anyBusy}
                    >
                        {t("txPage.bulk.selectAllMatching", {
                            n: totalMatching,
                        })}
                    </Button>
                )}

                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button size="sm" disabled={anyBusy}>
                            {t("txPage.bulk.actions")}
                            <ChevronDown />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                        <DropdownMenuLabel>
                            {t("txPage.bulk.menuLabel")}
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {canMarkTransfer && (
                            <DropdownMenuItem
                                onClick={() => void handleMarkTransfer()}
                            >
                                <ArrowLeftRight className="h-4 w-4 mr-2" />
                                {t("txPage.bulk.markTransfer")}
                            </DropdownMenuItem>
                        )}
                        {selectionMode === "filter" && (
                            <p className="max-w-64 px-2 py-1.5 type-footnote text-label-secondary">
                                {t("txPage.bulk.tagSelectionHint")}
                            </p>
                        )}
                        <DropdownMenuItem
                            onClick={() => setTagOpen(true)}
                            disabled={selectionMode === "filter"}
                        >
                            <Tag className="h-4 w-4 mr-2" />
                            {t("txPage.bulk.tag")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            onClick={() => setSplitOpen(true)}
                            disabled={selectionMode === "filter"}
                        >
                            <Split className="h-4 w-4 mr-2" />
                            {t("txPage.bulk.split")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setCategoryOpen(true)}>
                            <FolderTree className="h-4 w-4 mr-2" />
                            {t("txPage.bulk.recategorize")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            onClick={() => setRecipientOpen(true)}
                        >
                            <UserCog className="h-4 w-4 mr-2" />
                            {t("txPage.bulk.reassignRecipient")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleSetActive(true)}>
                            <ToggleRight className="h-4 w-4 mr-2" />
                            {t("txPage.bulk.activate")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            onClick={() => handleSetActive(false)}
                        >
                            <ToggleLeft className="h-4 w-4 mr-2" />
                            {t("txPage.bulk.deactivate")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setExportOpen(true)}>
                            <Download className="h-4 w-4 mr-2" />
                            {t("txPage.bulk.export")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            onClick={handleDelete}
                            variant="destructive"
                        >
                            <Trash2 className="h-4 w-4 mr-2" />
                            {t("txPage.bulk.delete")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>

                <Button
                    size="sm"
                    variant="ghost"
                    onClick={onClearSelection}
                    disabled={anyBusy}
                >
                    {t("common.clearSelection")}
                </Button>
            </div>

            <BulkTagDialog
                open={tagOpen}
                selectedCount={effectiveCount}
                onOpenChange={setTagOpen}
                onApply={handleTagApply}
                pending={tagBusy}
            />
            <BulkRecategorizeDialog
                open={categoryOpen}
                selectedCount={effectiveCount}
                onOpenChange={setCategoryOpen}
                onApply={handleRecategorize}
                pending={updateBusy}
            />
            <BulkRecipientDialog
                open={recipientOpen}
                selectedCount={effectiveCount}
                onOpenChange={setRecipientOpen}
                onApply={handleReassignRecipient}
                pending={updateBusy}
            />
            <BulkExportDialog
                open={exportOpen}
                selectedCount={effectiveCount}
                onOpenChange={setExportOpen}
                onApply={handleExport}
                pending={exportBusy}
            />
            <BulkSplitDialog
                open={splitOpen}
                selectedCount={effectiveCount}
                onOpenChange={setSplitOpen}
                onApply={handleSplitApply}
                pending={splitBusy}
            />
            <ConfirmDialog />
        </>
    );
}
