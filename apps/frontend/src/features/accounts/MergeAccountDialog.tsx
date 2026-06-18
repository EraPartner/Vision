import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, GitMerge } from "lucide-react";
import { useMergeAccounts } from "@/hooks/useAccounts";
import { useLanguage } from "@/contexts/LanguageContext";
import type { Account } from "@/types/api";

const label = (a: Account) => a.display_name || a.name;

/**
 * Merge `source` into another (survivor) account chosen by the user. The source's
 * transactions, planned transactions, holdings, and funding references move to the
 * survivor, and the source is deleted (ADR-088). Irreversible.
 */
export function MergeAccountDialog({ source, accounts, open, onOpenChange }: {
    source: Account;
    accounts: Account[];
    open: boolean;
    onOpenChange: (o: boolean) => void;
}) {
    const { t } = useLanguage();
    const merge = useMergeAccounts();
    const [targetId, setTargetId] = useState<string>("");

    const candidates = accounts.filter((a) => a.id !== source.id);
    const target = candidates.find((c) => String(c.id) === targetId);

    const handleMerge = () => {
        if (!targetId) return;
        merge.mutate(
            { targetId: Number(targetId), sourceIds: [source.id] },
            { onSuccess: () => { setTargetId(""); onOpenChange(false); } },
        );
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t('accounts.mergeTitle')}</DialogTitle>
                    <DialogDescription>
                        {t('accounts.mergeDescription', { source: label(source) })}
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <Label htmlFor="merge-target">{t('accounts.mergeTargetLabel')}</Label>
                    <Select value={targetId} onValueChange={setTargetId}>
                        <SelectTrigger id="merge-target">
                            <SelectValue placeholder={t('accounts.mergeTargetPlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                            {candidates.map((a) => (
                                <SelectItem key={a.id} value={String(a.id)}>{label(a)}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    {target && (
                        <p className="text-sm text-muted-foreground">
                            {t('accounts.mergeWarning', { source: label(source), target: label(target) })}
                        </p>
                    )}
                </div>
                <DialogFooter className="pt-2">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
                    <Button variant="destructive" disabled={!targetId || merge.isPending} onClick={handleMerge}>
                        {merge.isPending
                            ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
                            : <GitMerge className="h-4 w-4 mr-1" />}
                        {t('accounts.mergeConfirm')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
