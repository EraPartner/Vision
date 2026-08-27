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
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useLanguage } from "@/contexts/LanguageContext";

type ExportFormat = 'csv' | 'json';

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
    const [format, setFormat] = useState<ExportFormat>('csv');

    function handleApply(e: React.FormEvent) {
        e.preventDefault();
        onApply(format);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t('txPage.bulk.exportTitle', { n: selectedCount })}</DialogTitle>
                    <DialogDescription>{t('txPage.bulk.exportDesc')}</DialogDescription>
                </DialogHeader>
                {/* Real <form> so Enter (e.g. with a format radio focused) exports.
                    grid gap-5 mirrors DialogContent's layout, so the wrapper is
                    layout-neutral. */}
                <form onSubmit={handleApply} className="grid gap-5">
                <div className="py-2">
                    <RadioGroup value={format} onValueChange={(v) => setFormat(v as ExportFormat)}>
                        <div className="flex items-center gap-2">
                            <RadioGroupItem value="csv" id="bulk-export-csv" />
                            <Label htmlFor="bulk-export-csv">{t('txPage.bulk.exportFormatCsv')}</Label>
                        </div>
                        <div className="flex items-center gap-2">
                            <RadioGroupItem value="json" id="bulk-export-json" />
                            <Label htmlFor="bulk-export-json">{t('txPage.bulk.exportFormatJson')}</Label>
                        </div>
                    </RadioGroup>
                </div>
                <DialogFooter className="gap-2">
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                        {t('common.cancel')}
                    </Button>
                    <Button type="submit" disabled={pending}>
                        {pending ? t('common.applying') : t('txPage.bulk.exportConfirm')}
                    </Button>
                </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
