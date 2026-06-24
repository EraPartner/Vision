import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, GitMerge, AlertTriangle } from "lucide-react";
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
    const [acknowledged, setAcknowledged] = useState(false);

    const candidates = accounts.filter((a) => a.id !== source.id);
    const target = candidates.find((c) => String(c.id) === targetId);

    const reset = () => { setTargetId(""); setAcknowledged(false); };

    const handleMerge = () => {
        if (!targetId || !acknowledged) return;
        merge.mutate(
            { targetId: Number(targetId), sourceIds: [source.id] },
            { onSuccess: () => { reset(); onOpenChange(false); } },
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
                    {/* Irreversibility is always called out, not only once a target is picked. */}
                    <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                            {target
                                ? t('accounts.mergeWarning', { source: label(source), target: label(target) })
                                : t('accounts.mergeIrreversible')}
                        </span>
                    </div>
                    {target && target.type !== source.type && (
                        <p className="text-sm text-amber-600 dark:text-amber-500">
                            {t('accounts.mergeTypeMismatch', {
                                sourceType: t(`accounts.type.${source.type}`),
                                targetType: t(`accounts.type.${target.type}`),
                            })}
                        </p>
                    )}
                    <label className="flex items-start gap-2 text-sm">
                        <Checkbox
                            checked={acknowledged}
                            onCheckedChange={(c) => setAcknowledged(c === true)}
                            className="mt-0.5"
                        />
                        <span>{t('accounts.mergeAcknowledge')}</span>
                    </label>
                </div>
                <DialogFooter className="pt-2">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
                    <Button variant="destructive" disabled={!targetId || !acknowledged || merge.isPending} onClick={handleMerge}>
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
