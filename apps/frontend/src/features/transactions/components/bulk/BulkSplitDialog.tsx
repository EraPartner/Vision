import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { RecipientCombobox } from "@/components/shared/RecipientCombobox";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { BulkSplitMode } from "@/lib/api/splits";

interface BulkSplitDialogProps {
    open: boolean;
    selectedCount: number;
    onOpenChange: (open: boolean) => void;
    onApply: (recipientId: number, mode: BulkSplitMode) => void;
    pending?: boolean;
}

/**
 * Bulk "Split": one payee gets the same preset share of every selected
 * transaction — half (50/50) or everything (0/100). Custom amounts are a
 * per-transaction decision, so they stay in the single-transaction dialog.
 */
export function BulkSplitDialog({
    open,
    selectedCount,
    onOpenChange,
    onApply,
    pending,
}: BulkSplitDialogProps) {
    const { t } = useLanguage();
    const [recipientId, setRecipientId] = useState<number | null>(null);
    const [mode, setMode] = useState<BulkSplitMode>("equal");

    function handleApply(e: React.FormEvent) {
        e.preventDefault();
        if (recipientId == null) return;
        onApply(recipientId, mode);
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(v) => {
                if (!v) {
                    setRecipientId(null);
                    setMode("equal");
                }
                onOpenChange(v);
            }}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {t("txPage.bulk.splitTitle", { n: selectedCount })}
                    </DialogTitle>
                    <DialogDescription>
                        {t("txPage.bulk.splitDesc")}
                    </DialogDescription>
                </DialogHeader>
                {/* Real <form> so Enter applies once a payee is chosen (cmdk
                    preventDefaults Enter inside the combobox). grid gap-5 mirrors
                    DialogContent's layout, so the wrapper is layout-neutral. */}
                <form onSubmit={handleApply} className="grid gap-5">
                    <div className="grid gap-4 py-2">
                        <div className="grid gap-2">
                            <Label htmlFor="bulk-split-recipient">
                                {t("txPage.field.recipient")}
                            </Label>
                            <RecipientCombobox
                                id="bulk-split-recipient"
                                value={recipientId}
                                onSelect={(id) => setRecipientId(id)}
                                className="w-full"
                            />
                        </div>
                        <div className="grid gap-2">
                            <SegmentedControl
                                label={t("splitDialog.splitType")}
                                value={mode}
                                onValueChange={(value) => {
                                    if (value === "equal" || value === "full")
                                        setMode(value);
                                }}
                            >
                                <SegmentedControlItem value="equal">
                                    {t("splitDialog.equalSplit")}
                                </SegmentedControlItem>
                                <SegmentedControlItem value="full">
                                    {t("splitDialog.othersPayAll")}
                                </SegmentedControlItem>
                            </SegmentedControl>
                            <p className="type-footnote text-label-secondary">
                                {mode === "full"
                                    ? t("txPage.bulk.splitFullHint")
                                    : t("txPage.bulk.splitEqualHint")}
                            </p>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                            disabled={pending}
                        >
                            {t("common.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            disabled={pending || recipientId == null}
                        >
                            {pending
                                ? t("splitDialog.splitting")
                                : t("txPage.bulk.splitConfirm")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
