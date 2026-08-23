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
import { RecipientCombobox } from "@/components/shared/RecipientCombobox";
import { useLanguage } from "@/contexts/LanguageContext";

interface BulkRecipientDialogProps {
    open: boolean;
    selectedCount: number;
    onOpenChange: (open: boolean) => void;
    onApply: (recipientId: number) => void;
    pending?: boolean;
}

export function BulkRecipientDialog({
    open,
    selectedCount,
    onOpenChange,
    onApply,
    pending,
}: BulkRecipientDialogProps) {
    const { t } = useLanguage();
    const [recipientId, setRecipientId] = useState<number | null>(null);

    function handleApply(e: React.FormEvent) {
        e.preventDefault();
        if (recipientId == null) return;
        onApply(recipientId);
    }

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!v) setRecipientId(null); onOpenChange(v); }}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t('txPage.bulk.reassignRecipientTitle', { n: selectedCount })}</DialogTitle>
                    <DialogDescription>{t('txPage.bulk.reassignRecipientDesc')}</DialogDescription>
                </DialogHeader>
                {/* Real <form> so Enter applies once a recipient is chosen (cmdk
                    preventDefaults Enter inside the combobox). grid gap-5 mirrors
                    DialogContent's layout, so the wrapper is layout-neutral. */}
                <form onSubmit={handleApply} className="grid gap-5">
                <div className="grid gap-2 py-2">
                    <Label htmlFor="bulk-recipient">{t('txPage.field.recipient')}</Label>
                    <RecipientCombobox
                        id="bulk-recipient"
                        value={recipientId}
                        onSelect={(id) => setRecipientId(id)}
                        className="w-full"
                    />
                </div>
                <DialogFooter className="gap-2">
                    <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
                        {t('common.cancel')}
                    </Button>
                    <Button type="submit" disabled={pending || recipientId == null}>
                        {pending ? t('common.applying') : t('common.apply')}
                    </Button>
                </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
