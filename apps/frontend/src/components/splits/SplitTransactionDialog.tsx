import { useState } from "react";
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RecipientCombobox } from "@/components/shared/RecipientCombobox";
import { useCreateSplits } from "@/hooks/useSplits";
import { Split, Plus, Trash2, Users } from "lucide-react";
import { formatCurrency } from "@/utils/currency";

interface SplitEntry {
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
        { recipient_id: null, amount: "", note: "" },
    ]);
    const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
    const createSplits = useCreateSplits();

    const absAmount = Math.abs(transactionAmount);

    const addEntry = () => setEntries(prev => [...prev, { recipient_id: null, amount: "", note: "" }]);

    const removeEntry = (idx: number) => setEntries(prev => prev.filter((_, i) => i !== idx));

    const updateEntry = (idx: number, field: keyof SplitEntry, value: any) => {
        setEntries(prev => prev.map((e, i) => i === idx ? { ...e, [field]: value } : e));
    };

    const validEntries = entries.filter(e => e.recipient_id != null);
    const totalPeople = validEntries.length + 1; // +1 for "me"

    const equalShare = totalPeople > 1 ? Math.round((absAmount / totalPeople) * 100) / 100 : 0;

    const customTotal = validEntries.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

    const handleSubmit = () => {
        const splits = validEntries.map(e => ({
            recipient_id: e.recipient_id!,
            amount: splitType === "equal" ? equalShare : parseFloat(e.amount) || 0,
            note: e.note || undefined,
        }));

        if (splits.length === 0) return;

        createSplits.mutate(
            { transaction_id: transactionId, splits },
            {
                onSuccess: () => {
                    setOpen(false);
                    setEntries([{ recipient_id: null, amount: "", note: "" }]);
                },
            }
        );
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary" title="Split transaction">
                    <Users className="h-4 w-4" />
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
                {/* Portal target: dropdowns render here (inside dialog DOM) so the dialog focus trap covers them */}
                <div ref={setPortalContainer} />
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Split className="h-5 w-5" />
                        Split Transaction
                    </DialogTitle>
                    <p className="text-sm text-muted-foreground">
                        Total: {formatCurrency(absAmount, transactionCurrency)}
                    </p>
                </DialogHeader>

                <div className="space-y-4">
                    {/* Split type toggle */}
                    <div className="flex gap-2">
                        <Button
                            variant={splitType === "equal" ? "default" : "outline"}
                            size="sm"
                            onClick={() => setSplitType("equal")}
                        >
                            Equal Split
                        </Button>
                        <Button
                            variant={splitType === "custom" ? "default" : "outline"}
                            size="sm"
                            onClick={() => setSplitType("custom")}
                        >
                            Custom Amounts
                        </Button>
                    </div>

                    {splitType === "equal" && validEntries.length > 0 && (
                        <div className="text-sm text-muted-foreground rounded-md bg-muted p-3">
                            Each person pays: <span className="font-semibold text-foreground">{formatCurrency(equalShare, transactionCurrency)}</span>
                            {" "}({totalPeople} people including you)
                        </div>
                    )}

                    {/* Entries */}
                    <div className="space-y-3 max-h-[300px] overflow-y-auto">
                        {entries.map((entry, idx) => (
                            <div key={idx} className="flex items-start gap-2 p-3 rounded-md border bg-card">
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
                                            placeholder="Amount owed"
                                            value={entry.amount}
                                            onChange={(e) => updateEntry(idx, "amount", e.target.value)}
                                        />
                                    )}
                                    <Input
                                        placeholder="Note (optional)"
                                        value={entry.note}
                                        onChange={(e) => updateEntry(idx, "note", e.target.value)}
                                    />
                                </div>
                                {entries.length > 1 && (
                                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0"
                                        onClick={() => removeEntry(idx)}>
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                )}
                            </div>
                        ))}
                    </div>

                    <Button variant="outline" size="sm" onClick={addEntry} className="gap-1.5">
                        <Plus className="h-4 w-4" /> Add Person
                    </Button>

                    {splitType === "custom" && validEntries.length > 0 && (
                        <p className="text-sm text-muted-foreground">
                            Others owe: {formatCurrency(customTotal, transactionCurrency)} of {formatCurrency(absAmount, transactionCurrency)}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                    <Button
                        onClick={handleSubmit}
                        disabled={validEntries.length === 0 || createSplits.isPending}
                    >
                        {createSplits.isPending ? "Splitting..." : "Split"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
