import { useState } from "react";
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
    Download,
    FolderTree,
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
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { BulkRecategorizeDialog } from "./BulkRecategorizeDialog";
import { BulkRecipientDialog } from "./BulkRecipientDialog";
import { BulkTagDialog } from "./BulkTagDialog";
import { BulkExportDialog } from "./BulkExportDialog";

export type BulkSelectionMode = 'ids' | 'filter';

interface BulkActionsBarProps {
    selectedIds: Set<number>;
    selectionMode: BulkSelectionMode;
    totalMatching: number;
    visibleItemCount: number;
    filter: BulkTransactionFilter;
    onClearSelection: () => void;
    onPromoteToFilterMode: () => void;
}

export function BulkActionsBar({
    selectedIds,
    selectionMode,
    totalMatching,
    visibleItemCount,
    filter,
    onClearSelection,
    onPromoteToFilterMode,
}: BulkActionsBarProps) {
    const { t } = useLanguage();
    const { confirm, ConfirmDialog } = useConfirmDialog();

    const bulkDelete = useBulkDeleteTransactions();
    const bulkUpdate = useBulkUpdateTransactions();
    const bulkExport = useBulkExportTransactions();
    const bulkTag = useBulkTagTransactions();

    const [tagOpen, setTagOpen] = useState(false);
    const [categoryOpen, setCategoryOpen] = useState(false);
    const [recipientOpen, setRecipientOpen] = useState(false);
    const [exportOpen, setExportOpen] = useState(false);

    const idCount = selectedIds.size;
    const effectiveCount = selectionMode === 'filter' ? totalMatching : idCount;

    if (idCount === 0) return null;

    const showSelectAllMatching =
        selectionMode === 'ids' &&
        idCount === visibleItemCount &&
        totalMatching > visibleItemCount;

    function buildSelector(): BulkSelectionRequest {
        if (selectionMode === 'filter') {
            return { filter };
        }
        return { ids: Array.from(selectedIds) };
    }

    async function handleDelete() {
        const ok = await confirm({
            title: t('txPage.bulk.confirmDeleteTitle', { n: effectiveCount }),
            description: t('txPage.bulk.confirmDeleteBody', { n: effectiveCount }),
            confirmLabel: t('txPage.bulk.delete'),
            variant: "destructive",
        });
        if (!ok) return;
        bulkDelete.mutate(buildSelector(), {
            onSuccess: () => onClearSelection(),
        });
    }

    async function handleSetActive(active: boolean) {
        if (!active) {
            const ok = await confirm({
                title: t('txPage.bulk.confirmDeactivateTitle', { n: effectiveCount }),
                description: t('txPage.bulk.confirmDeactivateBody', { n: effectiveCount }),
                confirmLabel: t('txPage.bulk.deactivate'),
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

    function handleExport(format: 'csv' | 'json') {
        const request: BulkExportRequest = { ...buildSelector(), format };
        bulkExport.mutate(request, {
            onSuccess: () => setExportOpen(false),
        });
    }

    function handleTagApply(addSlugs: string[], removeSlugs: string[]) {
        // Bulk tag uses the legacy id-only contract. For filter-mode, fall back to
        // the resolved selection: backend ids endpoint expects an array.
        const ids =
            selectionMode === 'filter'
                ? null
                : Array.from(selectedIds);
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

    const updateBusy = bulkUpdate.isPending;
    const deleteBusy = bulkDelete.isPending;
    const exportBusy = bulkExport.isPending;
    const tagBusy = bulkTag.isPending;
    const anyBusy = updateBusy || deleteBusy || exportBusy || tagBusy;

    return (
        <>
            <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium">
                    {t('txPage.bulk.nSelected', { n: effectiveCount })}
                </span>

                {showSelectAllMatching && (
                    <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={onPromoteToFilterMode}
                        disabled={anyBusy}
                    >
                        {t('txPage.bulk.selectAllMatching', { n: totalMatching })}
                    </Button>
                )}

                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button size="sm" className="h-7 text-xs gap-1" disabled={anyBusy}>
                            {t('txPage.bulk.actions')}
                            <ChevronDown className="h-3 w-3" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                        <DropdownMenuLabel>{t('txPage.bulk.menuLabel')}</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => setTagOpen(true)} disabled={selectionMode === 'filter'}>
                            <Tag className="h-4 w-4 mr-2" />
                            {t('txPage.bulk.tag')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setCategoryOpen(true)}>
                            <FolderTree className="h-4 w-4 mr-2" />
                            {t('txPage.bulk.recategorize')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setRecipientOpen(true)}>
                            <UserCog className="h-4 w-4 mr-2" />
                            {t('txPage.bulk.reassignRecipient')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleSetActive(true)}>
                            <ToggleRight className="h-4 w-4 mr-2" />
                            {t('txPage.bulk.activate')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleSetActive(false)}>
                            <ToggleLeft className="h-4 w-4 mr-2" />
                            {t('txPage.bulk.deactivate')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setExportOpen(true)}>
                            <Download className="h-4 w-4 mr-2" />
                            {t('txPage.bulk.export')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            onClick={handleDelete}
                            className="text-destructive focus:text-destructive focus:bg-destructive/10"
                        >
                            <Trash2 className="h-4 w-4 mr-2" />
                            {t('txPage.bulk.delete')}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>

                <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={onClearSelection}
                    disabled={anyBusy}
                >
                    {t('common.clear')}
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
            <ConfirmDialog />
        </>
    );
}
