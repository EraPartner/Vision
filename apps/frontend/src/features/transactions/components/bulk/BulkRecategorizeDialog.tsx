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
import { CategoryCombobox } from "@/components/shared/CategoryCombobox";
import { useLanguage } from "@/contexts/LanguageContext";

interface BulkRecategorizeDialogProps {
    open: boolean;
    selectedCount: number;
    onOpenChange: (open: boolean) => void;
    onApply: (categoryId: number | null) => void;
    pending?: boolean;
}

export function BulkRecategorizeDialog({
    open,
    selectedCount,
    onOpenChange,
    onApply,
    pending,
}: BulkRecategorizeDialogProps) {
    const { t } = useLanguage();
    const [categoryId, setCategoryId] = useState<number | null>(null);

    function handleApply(e: React.FormEvent) {
        e.preventDefault();
        onApply(categoryId);
    }

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!v) setCategoryId(null); onOpenChange(v); }}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t('txPage.bulk.recategorizeTitle', { n: selectedCount })}</DialogTitle>
                    <DialogDescription>{t('txPage.bulk.recategorizeDesc')}</DialogDescription>
                </DialogHeader>
                {/* Real <form> so Enter applies (cmdk preventDefaults Enter inside
                    the combobox). grid gap-5 mirrors DialogContent's layout, so the
                    wrapper is layout-neutral. */}
                <form onSubmit={handleApply} className="grid gap-5">
                <div className="grid gap-2 py-2">
                    <Label htmlFor="bulk-category">{t('txPage.field.category')}</Label>
                    <CategoryCombobox
                        id="bulk-category"
                        value={categoryId}
                        onSelect={(id) => setCategoryId(id)}
                        className="w-full"
                    />
                </div>
                <DialogFooter className="gap-2">
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                        {t('common.cancel')}
                    </Button>
                    <Button type="submit" disabled={pending}>
                        {pending ? t('common.applying') : t('common.apply')}
                    </Button>
                </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
