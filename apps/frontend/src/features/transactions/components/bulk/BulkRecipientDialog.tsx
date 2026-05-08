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

    function handleApply() {
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
                <div className="py-2">
                    <RecipientCombobox
                        value={recipientId}
                        onSelect={(id) => setRecipientId(id)}
                        className="w-full"
                    />
                </div>
                <DialogFooter className="gap-2">
                    <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
                        {t('common.cancel')}
                    </Button>
                    <Button onClick={handleApply} disabled={pending || recipientId == null}>
                        {pending ? t('common.applying') : t('common.apply')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
