import { useState } from "react";
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { RecipientCombobox } from "@/components/shared/RecipientCombobox";
import { useCreateSplits, useSplitsByTransaction } from "@/hooks/useSplits";
import { Split, Plus, Trash2, Users } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { formatCurrency } from "@/utils/currency";
import { parseDecimal } from "@/lib/decimal";
import { toDecimal, addAll, multiply, roundMoney } from "@/lib/money";

interface SplitEntry {
    uid: string;
    recipient_id: number | null;
    amount: string;
    note: string;
}

interface SplitTransactionDialogProps {
    transactionId: number;
    transactionAmount: number;
    transactionCurrency: string;
}

export function SplitTransactionDialog({ transactionId, transactionAmount, transactionCurrency }: SplitTransactionDialogProps) {
    const [open, setOpen] = useState(false);
    const [splitType, setSplitType] = useState<"equal" | "custom">("equal");
    const [entries, setEntries] = useState<SplitEntry[]>([
        { uid: crypto.randomUUID(), recipient_id: null, amount: "", note: "" },
    ]);
    const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
    const createSplits = useCreateSplits();
    const { data: existingSplitsData, isLoading: isLoadingExistingSplits } = useSplitsByTransaction(open ? transactionId : null);
    const { t } = useLanguage();

    const absAmount = Math.abs(transactionAmount);

    const addEntry = () => setEntries(prev => [...prev, { uid: crypto.randomUUID(), recipient_id: null, amount: "", note: "" }]);

    const removeEntry = (idx: number) => setEntries(prev => prev.filter((_, i) => i !== idx));

    const updateEntry = (idx: number, field: keyof SplitEntry, value: number | string | null) => {
        setEntries(prev => prev.map((e, i) => i === idx ? { ...e, [field]: value } : e));
    };

    const validEntries = entries.filter(e => e.recipient_id != null);
    const totalPeople = validEntries.length + 1; // +1 for "me"

    // Money math runs through Decimal and rounds to cents on emit so the
    // "exceeds total" gate compares exact cent values — a float `reduce`
    // could drift an exact split just past `absAmount` and mis-gate it.
    // All of these values are only consumed inside <DialogContent> (rendered
    // only when open), so a closed dialog — one sits in every table row — must
    // not run the Decimal pipeline on every parent re-render/keystroke.
    const equalShare = open && totalPeople > 1 ? roundMoney(toDecimal(absAmount).div(totalPeople)) : 0;

    const customTotal = open ? roundMoney(addAll(validEntries.map((e) => parseDecimal(e.amount)))) : 0;
    const existingSplits = existingSplitsData?.items ?? [];
    const existingSplitTotal = open ? roundMoney(addAll(existingSplits.map((split) => split.amount || 0))) : 0;
    const existingRecipientNames = existingSplits
        .map((split) => split.recipient_name)
        .filter(Boolean)
        .join(', ');
    const newSplitTotal = splitType === "equal"
        ? roundMoney(multiply(equalShare, validEntries.length))
        : customTotal;
    const hasNonPositiveSplitAmount = !open
        ? false
        : splitType === "equal"
            ? validEntries.length > 0 && equalShare <= 0
            : validEntries.some((entry) => {
                if (!entry.recipient_id) return false;
                return parseDecimal(entry.amount) <= 0;
            });
    const totalAfterSubmit = roundMoney(toDecimal(existingSplitTotal).plus(newSplitTotal));
    const remainingSplitCapacity = open ? Math.max(roundMoney(toDecimal(absAmount).minus(existingSplitTotal)), 0) : 0;
    const hasExceededTransactionTotal = open ? toDecimal(totalAfterSubmit).gt(roundMoney(absAmount)) : false;

    const handleSubmit = () => {
        const splits = validEntries.map(e => ({
            recipient_id: e.recipient_id!,
            amount: splitType === "equal" ? equalShare : parseDecimal(e.amount),
            note: e.note || undefined,
        }));

        if (splits.length === 0) return;

        createSplits.mutate(
            { transaction_id: transactionId, splits },
            {
                onSuccess: () => {
                    setOpen(false);
                    setEntries([{ uid: crypto.randomUUID(), recipient_id: null, amount: "", note: "" }]);
                },
            }
        );
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className="icon-touch-target text-muted-foreground hover:text-primary" title={t('splitDialog.buttonTitle')}>
                    <Users className="h-4 w-4" />
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
                {/* Portal target: dropdowns render here (inside dialog DOM) so the dialog focus trap covers them */}
                <div ref={setPortalContainer} />
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Split className="h-5 w-5" />
                        {t('splitDialog.buttonTitle')}
                    </DialogTitle>
                    <DialogDescription>
                        {t('splitDialog.total', { amount: formatCurrency(absAmount, transactionCurrency) })}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    {!isLoadingExistingSplits && (
                        <Alert className="py-3">
                            <AlertDescription>
                                {existingSplits.length > 0
                                    ? t('splitDialog.alreadySplit', { n: existingSplits.length })
                                    : t('splitDialog.notSplitYet')}
                                {existingRecipientNames && (
                                    <span className="block mt-1 text-xs text-muted-foreground">
                                        {t('splitDialog.existingRecipients', {
                                            recipients: existingRecipientNames,
                                        })}
                                    </span>
                                )}
                                {existingSplits.length > 0 && (
                                    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                                        {existingSplits.map((split) => (
                                            <li key={split.id}>
                                                {t('splitDialog.existingSplitLine', {
                                                    recipient: split.recipient_name || t('txPage.field.unknown'),
                                                    amount: formatCurrency(split.amount, transactionCurrency),
                                                })}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </AlertDescription>
                        </Alert>
                    )}

                    {!isLoadingExistingSplits && hasExceededTransactionTotal && (
                        <Alert variant="destructive" className="py-3">
                            <AlertDescription>
                                {t('splitDialog.exceedsTotal', { remaining: formatCurrency(remainingSplitCapacity, transactionCurrency) })}
                            </AlertDescription>
                        </Alert>
                    )}

                    {/* Split type toggle */}
                    <div className="flex gap-2">
                        <Button
                            variant={splitType === "equal" ? "default" : "outline"}
                            size="sm"
                            onClick={() => setSplitType("equal")}
                        >
                            {t('splitDialog.equalSplit')}
                        </Button>
                        <Button
                            variant={splitType === "custom" ? "default" : "outline"}
                            size="sm"
                            onClick={() => setSplitType("custom")}
                        >
                            {t('splitDialog.customAmounts')}
                        </Button>
                    </div>

                    {splitType === "equal" && validEntries.length > 0 && (
                        <div className="text-sm text-muted-foreground rounded-md bg-muted p-3">
                            {t('splitDialog.eachPays', { amount: formatCurrency(equalShare, transactionCurrency), n: totalPeople })}
                        </div>
                    )}

                    {/* Entries */}
                    <div className="space-y-3 max-h-[300px] overflow-y-auto">
                        {entries.map((entry, idx) => (
                            <div key={entry.uid} className="flex items-start gap-2 p-3 rounded-md border bg-card">
                                <div className="flex-1 space-y-2">
                                    <RecipientCombobox
                                        value={entry.recipient_id}
                                        onSelect={(id) => updateEntry(idx, "recipient_id", id)}
                                        className="w-full"
                                        portalContainer={portalContainer}
                                    />
                                    {splitType === "custom" && (
                                        <Input
                                            type="number"
                                            step="0.01"
                                            placeholder={t('splitDialog.amountOwed')}
                                            value={entry.amount}
                                            onChange={(e) => updateEntry(idx, "amount", e.target.value)}
                                        />
                                    )}
                                    <Input
                                        placeholder={t('splitDialog.noteOptional')}
                                        value={entry.note}
                                        onChange={(e) => updateEntry(idx, "note", e.target.value)}
                                    />
                                </div>
                                {entries.length > 1 && (
                                    <Button variant="ghost" size="icon" className="icon-touch-target text-muted-foreground hover:text-destructive shrink-0"
                                        aria-label={t('aria.removeEntry')}
                                        onClick={() => removeEntry(idx)}>
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                )}
                            </div>
                        ))}
                    </div>

                    <Button variant="outline" size="sm" onClick={addEntry} className="gap-1.5">
                        <Plus className="h-4 w-4" /> {t('splitDialog.addPerson')}
                    </Button>

                    {splitType === "custom" && validEntries.length > 0 && (
                        <p className="text-sm text-muted-foreground">
                            {t('splitDialog.othersOwe', { x: formatCurrency(customTotal, transactionCurrency), total: formatCurrency(absAmount, transactionCurrency) })}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
                    <Button
                        onClick={handleSubmit}
                        disabled={validEntries.length === 0 || hasNonPositiveSplitAmount || hasExceededTransactionTotal || createSplits.isPending}
                    >
                        {createSplits.isPending ? t('splitDialog.splitting') : t('splitDialog.split')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
