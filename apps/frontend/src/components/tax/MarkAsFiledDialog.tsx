/**
 * MarkAsFiledDialog
 *
 * Collects an optional filing reference (Tax-on-Web id, paper return code, etc.) and
 * marks a year as filed. Filing also freezes the calculation — see ADR-059 §filing.
 *
 * Reference is free-text and stored verbatim. Empty reference is permitted.
 */
import { useState, type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import { useBelgianTaxProfile } from '@/contexts/BelgianTaxProfileContext';

interface MarkAsFiledDialogProps {
    trigger: ReactNode;
    year: number;
}

export function MarkAsFiledDialog({ trigger, year }: MarkAsFiledDialogProps) {
    const { t } = useLanguage();
    const { markYearAsFiled } = useBelgianTaxProfile();
    const [open, setOpen] = useState(false);
    const [reference, setReference] = useState('');

    function handleConfirm(e: React.FormEvent) {
        e.preventDefault();
        const trimmed = reference.trim();
        markYearAsFiled(year, trimmed.length > 0 ? trimmed : undefined);
        handleOpenChange(false);
    }

    function handleOpenChange(o: boolean) {
        setOpen(o);
        if (!o) setReference('');
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogTrigger asChild>{trigger}</DialogTrigger>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Lock className="h-4 w-4 text-warning" />
                        {t('tax.markFiled.title', { year: String(year) })}
                    </DialogTitle>
                    <DialogDescription>{t('tax.markFiled.description')}</DialogDescription>
                </DialogHeader>

                {/* Real <form> so Enter in the reference field confirms (filing is
                    reversible — see unmarkYearAsFiled). grid gap-5 mirrors
                    DialogContent's layout, so this wrapper is layout-neutral. */}
                <form onSubmit={handleConfirm} className="grid gap-5">
                <div className="space-y-2 py-2">
                    <Label htmlFor="filing-reference" className="text-sm">
                        {t('tax.markFiled.referenceLabel')}
                    </Label>
                    <Input
                        id="filing-reference"
                        value={reference}
                        onChange={(e) => setReference(e.target.value)}
                        placeholder={t('tax.markFiled.referencePlaceholder')}
                    />
                    <p className="text-xs text-muted-foreground">
                        {t('tax.markFiled.referenceHelp')}
                    </p>
                </div>

                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
                        {t('common.cancel')}
                    </Button>
                    <Button type="submit" className="gap-1">
                        <Lock className="h-3 w-3" />
                        {t('tax.markFiled.confirm')}
                    </Button>
                </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
