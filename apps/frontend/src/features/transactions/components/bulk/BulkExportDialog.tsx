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
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

type ExportFormat = "csv" | "json";

interface BulkExportDialogProps {
    open: boolean;
    selectedCount: number;
    onOpenChange: (open: boolean) => void;
    onApply: (format: ExportFormat) => void;
    pending?: boolean;
}

export function BulkExportDialog({
    open,
    selectedCount,
    onOpenChange,
    onApply,
    pending,
}: BulkExportDialogProps) {
    const { t } = useLanguage();
    const [format, setFormat] = useState<ExportFormat>("csv");

    function handleApply(e: React.FormEvent) {
        e.preventDefault();
        onApply(format);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {t("txPage.bulk.exportTitle", { n: selectedCount })}
                    </DialogTitle>
                    <DialogDescription>
                        {t("txPage.bulk.exportDesc")}
                    </DialogDescription>
                </DialogHeader>
                {/* Real <form> so Enter (e.g. with a format segment focused) exports.
                    grid gap-5 mirrors DialogContent's layout, so the wrapper is
                    layout-neutral. */}
                <form onSubmit={handleApply} className="grid gap-5">
                    <SegmentedControl
                        label={t("txPage.bulk.exportFormat")}
                        wrapperClassName="py-2"
                        value={format}
                        onValueChange={(v) => setFormat(v as ExportFormat)}
                        className="w-full"
                    >
                        <SegmentedControlItem value="csv">
                            {t("txPage.bulk.exportFormatCsv")}
                        </SegmentedControlItem>
                        <SegmentedControlItem value="json">
                            {t("txPage.bulk.exportFormatJson")}
                        </SegmentedControlItem>
                    </SegmentedControl>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                            disabled={pending}
                        >
                            {t("common.cancel")}
                        </Button>
                        <Button type="submit" disabled={pending}>
                            {pending
                                ? t("common.applying")
                                : t("txPage.bulk.exportConfirm")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
