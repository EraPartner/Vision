import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, ArrowLeftRight } from "lucide-react";
import { apiClient } from "@/lib/api";
import { useAccounts } from "@/hooks/useAccounts";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "sonner";
import type { Account } from "@/types/api";
import type { MoveHoldingStrategy } from "@/lib/api/portfolio";

const label = (a: Account) => a.display_name || a.name;

/**
 * Move a holding's lots from one account to another — in-specie, cost-basis-preserving
 * (no sale, no cash leg, ADR-091). Leave units empty to move the whole position; enter a
 * number for a partial-unit transfer.
 */
export function MoveHoldingDialog({ investmentId, investmentLabel, open, onOpenChange }: {
    investmentId: number;
    investmentLabel: string;
    open: boolean;
    onOpenChange: (o: boolean) => void;
}) {
    const { t } = useLanguage();
    const queryClient = useQueryClient();
    const { data } = useAccounts({ active: "true" });
    const accounts = data?.items ?? [];

    const [fromId, setFromId] = useState("");
    const [toId, setToId] = useState("");
    const [units, setUnits] = useState("");
    const [strategy, setStrategy] = useState<MoveHoldingStrategy>("fifo");

    const reset = () => { setFromId(""); setToId(""); setUnits(""); setStrategy("fifo"); };

    // The strategy only changes which lots a PARTIAL unit move draws from; a whole
    // move (units blank) re-points every lot regardless.
    const isPartial = units.trim() !== "" && Number(units) > 0;

    const move = useMutation({
        mutationFn: () => apiClient.moveHolding(investmentId, {
            from_account_id: Number(fromId),
            to_account_id: Number(toId),
            units: units.trim() ? Number(units) : null,
            ...(isPartial ? { strategy } : {}),
        }),
        onSuccess: (r) => {
            queryClient.invalidateQueries();
            toast.success(t('portfolio.move.done', { units: String(r.movedUnits) }));
            reset();
            onOpenChange(false);
        },
        onError: (e: Error) => toast.error(t('portfolio.move.failed'), { description: e.message }),
    });

    const canSubmit = !!fromId && !!toId && fromId !== toId;

    return (
        <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t('portfolio.move.title')}</DialogTitle>
                    <DialogDescription>{t('portfolio.move.description', { holding: investmentLabel })}</DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <div className="space-y-1.5">
                        <Label htmlFor="move-from">{t('portfolio.move.from')}</Label>
                        <Select value={fromId} onValueChange={setFromId}>
                            <SelectTrigger id="move-from"><SelectValue placeholder={t('portfolio.move.selectAccount')} /></SelectTrigger>
                            <SelectContent>
                                {accounts.map((a) => <SelectItem key={a.id} value={String(a.id)}>{label(a)}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="move-to">{t('portfolio.move.to')}</Label>
                        <Select value={toId} onValueChange={setToId}>
                            <SelectTrigger id="move-to"><SelectValue placeholder={t('portfolio.move.selectAccount')} /></SelectTrigger>
                            <SelectContent>
                                {accounts.filter((a) => String(a.id) !== fromId).map((a) => (
                                    <SelectItem key={a.id} value={String(a.id)}>{label(a)}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="move-units">{t('portfolio.move.units')}</Label>
                        <Input
                            id="move-units" type="number" inputMode="decimal" min="0" step="any"
                            value={units} onChange={(e) => setUnits(e.target.value)}
                            placeholder={t('portfolio.move.unitsPlaceholder')}
                        />
                        <p className="text-xs text-muted-foreground">{t('portfolio.move.unitsHint')}</p>
                    </div>
                    {isPartial && (
                        <div className="space-y-1.5">
                            <Label htmlFor="move-strategy">{t('portfolio.move.strategy')}</Label>
                            <Select value={strategy} onValueChange={(v) => setStrategy(v as MoveHoldingStrategy)}>
                                <SelectTrigger id="move-strategy"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="fifo">{t('portfolio.move.strategy.fifo')}</SelectItem>
                                    <SelectItem value="proportional">{t('portfolio.move.strategy.proportional')}</SelectItem>
                                </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">
                                {strategy === 'fifo' ? t('portfolio.move.strategy.fifoHint') : t('portfolio.move.strategy.proportionalHint')}
                            </p>
                        </div>
                    )}
                </div>
                <DialogFooter className="pt-2">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
                    <Button disabled={!canSubmit || move.isPending} onClick={() => move.mutate()}>
                        {move.isPending
                            ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
                            : <ArrowLeftRight className="h-4 w-4 mr-1" />}
                        {t('portfolio.move.confirm')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
