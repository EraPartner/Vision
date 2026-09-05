import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { TagFilterCombobox } from "@/components/shared/TagFilterCombobox";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";

interface BulkTagDialogProps {
    open: boolean;
    selectedCount: number;
    onOpenChange: (open: boolean) => void;
    onApply: (addSlugs: string[], removeSlugs: string[]) => void;
    pending?: boolean;
}

export function BulkTagDialog({
    open,
    selectedCount,
    onOpenChange,
    onApply,
    pending,
}: BulkTagDialogProps) {
    const { t } = useLanguage();
    const [addSlugs, setAddSlugs] = useState<string[]>([]);
    const [removeSlugs, setRemoveSlugs] = useState<string[]>([]);
    useUnsavedChanges(addSlugs.length > 0 || removeSlugs.length > 0);

    function reset() {
        setAddSlugs([]);
        setRemoveSlugs([]);
    }

    function handleApply(e: React.FormEvent) {
        e.preventDefault();
        if (addSlugs.length === 0 && removeSlugs.length === 0) return;
        onApply(addSlugs, removeSlugs);
        reset();
    }

    // No reset on dismissal: Radix reports an overlay click and Escape through
    // the same callback as a deliberate close, so resetting there wiped the
    // chosen tags on one stray click. The chosen tags are not tied to *which*
    // rows are selected — they stay meaningful for whatever the selection is
    // when the dialog is reopened — and the dialog stays mounted while closed,
    // so they are still there. reset() belongs to Cancel and to a applied edit.
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {t("txPage.bulk.tagTitle", { n: selectedCount })}
                    </DialogTitle>
                    <DialogDescription>
                        {t("txPage.bulk.tagDesc")}
                    </DialogDescription>
                </DialogHeader>
                {/* Real <form> so Enter submits once tags are chosen (cmdk
                    preventDefaults Enter inside the comboboxes, so item selection
                    never falls through to this). grid gap-5 mirrors DialogContent's
                    layout, so the wrapper is layout-neutral. */}
                <form onSubmit={handleApply} className="grid gap-5">
                    <div className="py-2 space-y-3">
                        <div className="space-y-1">
                            <label
                                htmlFor="bulk-tag-add"
                                className="text-xs font-medium text-muted-foreground"
                            >
                                {t("txPage.bulk.tagAdd")}
                            </label>
                            <TagFilterCombobox
                                id="bulk-tag-add"
                                value={addSlugs}
                                onChange={setAddSlugs}
                                className="w-full"
                            />
                        </div>
                        <div className="space-y-1">
                            <label
                                htmlFor="bulk-tag-remove"
                                className="text-xs font-medium text-muted-foreground"
                            >
                                {t("txPage.bulk.tagRemove")}
                            </label>
                            <TagFilterCombobox
                                id="bulk-tag-remove"
                                value={removeSlugs}
                                onChange={setRemoveSlugs}
                                className="w-full"
                            />
                        </div>
                    </div>
                    <DialogFooter className="gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                                reset();
                                onOpenChange(false);
                            }}
                            disabled={pending}
                        >
                            {t("common.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            disabled={
                                pending ||
                                (addSlugs.length === 0 &&
                                    removeSlugs.length === 0)
                            }
                        >
                            {pending ? t("common.applying") : t("common.apply")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
