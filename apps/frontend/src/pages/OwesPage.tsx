import { useState } from "react";
import { useOwedSummary, useOwedByRecipient, useRecordPayment, useSettleSplit, useDeleteSplit } from "@/hooks/useSplits";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { formatCurrency } from "@/utils/currency";
import { ArrowLeft, Check, DollarSign, Trash2, Users } from "lucide-react";
import { Progress } from "@/components/ui/progress";

export default function OwesPage() {
    const { data: summary, isLoading } = useOwedSummary();
    const [selectedRecipient, setSelectedRecipient] = useState<{ id: number; name: string } | null>(null);

    if (isLoading) {
        return (
            <div className="space-y-8 animate-in">
                <div>
                    <h2 className="text-3xl font-bold text-foreground">Who Owes You</h2>
                    <p className="text-muted-foreground mt-1">Track shared expenses and payments</p>
                </div>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {[...Array(3)].map((_, i) => (
                        <Skeleton key={i} className="h-32" />
                    ))}
                </div>
            </div>
        );
    }

    const items = summary?.items || [];
    const totalOwed = items.reduce((s, i) => s + i.remaining, 0);

    if (selectedRecipient) {
        return <RecipientOwesDetail recipient={selectedRecipient} onBack={() => setSelectedRecipient(null)} />;
    }

    return (
        <div className="space-y-8 animate-in">
            <div>
                <h2 className="text-3xl font-bold text-foreground">Who Owes You</h2>
                <p className="text-muted-foreground mt-1">Track shared expenses and payments</p>
            </div>

            {totalOwed > 0 && (
                <Card className="bg-primary/5 border-primary/20">
                    <CardContent className="pt-6">
                        <div className="text-center">
                            <p className="text-sm text-muted-foreground">Total Outstanding</p>
                            <p className="text-3xl font-bold text-primary mt-1">
                                {formatCurrency(totalOwed, "EUR")}
                            </p>
                            <p className="text-sm text-muted-foreground mt-1">
                                from {items.length} {items.length === 1 ? "person" : "people"}
                            </p>
                        </div>
                    </CardContent>
                </Card>
            )}

            {items.length === 0 ? (
                <Card>
                    <CardContent className="py-12 text-center">
                        <Users className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
                        <p className="text-sm font-medium text-foreground mb-1">No outstanding debts</p>
                        <p className="text-xs text-muted-foreground">
                            Split a transaction to start tracking who owes you
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {items.map((item) => {
                        const progress = item.total_owed > 0 ? (item.total_paid / item.total_owed) * 100 : 0;
                        return (
                            <Card
                                key={item.recipient_id}
                                className="cursor-pointer hover:border-primary/40 transition-colors"
                                onClick={() => setSelectedRecipient({ id: item.recipient_id, name: item.recipient_name })}
                            >
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-base flex items-center justify-between">
                                        <span>{item.recipient_name}</span>
                                        <Badge variant="secondary">{item.split_count} splits</Badge>
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    <div className="flex justify-between text-sm">
                                        <span className="text-muted-foreground">Remaining</span>
                                        <span className="font-semibold text-primary">
                                            {formatCurrency(item.remaining, "EUR")}
                                        </span>
                                    </div>
                                    <Progress value={progress} className="h-2" />
                                    <div className="flex justify-between text-xs text-muted-foreground">
                                        <span>Paid: {formatCurrency(item.total_paid, "EUR")}</span>
                                        <span>Total: {formatCurrency(item.total_owed, "EUR")}</span>
                                    </div>
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function RecipientOwesDetail({ recipient, onBack }: { recipient: { id: number; name: string }; onBack: () => void }) {
    const { data, isLoading } = useOwedByRecipient(recipient.id);
    const recordPayment = useRecordPayment();
    const settleSplit = useSettleSplit();
    const deleteSplit = useDeleteSplit();
    const [payDialog, setPayDialog] = useState<{ splitId: number; remaining: number } | null>(null);
    const [payAmount, setPayAmount] = useState("");

    const items = data?.items || [];

    const handlePay = () => {
        if (!payDialog) return;
        const amount = parseFloat(payAmount);
        if (!amount || amount <= 0) return;
        recordPayment.mutate(
            { splitId: payDialog.splitId, amount },
            { onSuccess: () => { setPayDialog(null); setPayAmount(""); } }
        );
    };

    return (
        <div className="space-y-6 animate-in">
            <div className="flex items-center gap-3">
                <Button variant="ghost" size="icon" onClick={onBack}>
                    <ArrowLeft className="h-5 w-5" />
                </Button>
                <div>
                    <h2 className="text-2xl font-bold text-foreground">{recipient.name}</h2>
                    <p className="text-muted-foreground text-sm">Outstanding splits</p>
                </div>
            </div>

            {isLoading ? (
                <div className="space-y-3">
                    {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24" />)}
                </div>
            ) : items.length === 0 ? (
                <Card>
                    <CardContent className="py-8 text-center">
                        <p className="text-sm text-muted-foreground">All settled! 🎉</p>
                    </CardContent>
                </Card>
            ) : (
                <div className="space-y-3">
                    {items.map((split) => {
                        const progress = split.amount > 0 ? (split.amount_paid / split.amount) * 100 : 0;
                        return (
                            <Card key={split.id}>
                                <CardContent className="py-4">
                                    <div className="flex items-start justify-between gap-4">
                                        <div className="flex-1 space-y-1">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-medium text-foreground">
                                                    {split.transaction_memo || "Transaction"}
                                                </span>
                                                <span className="text-xs text-muted-foreground">
                                                    {split.transaction_date?.split("T")[0]}
                                                </span>
                                            </div>
                                            <p className="text-xs text-muted-foreground">
                                                Original: {formatCurrency(Math.abs(split.transaction_amount), split.transaction_currency || "EUR")}
                                                {split.note && ` · ${split.note}`}
                                            </p>
                                            <div className="flex items-center gap-3 mt-2">
                                                <Progress value={progress} className="h-1.5 flex-1" />
                                                <span className="text-xs text-muted-foreground whitespace-nowrap">
                                                    {formatCurrency(split.amount_paid, "EUR")} / {formatCurrency(split.amount, "EUR")}
                                                </span>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1 shrink-0">
                                            <span className="text-sm font-semibold text-primary mr-2">
                                                {formatCurrency(split.remaining, "EUR")}
                                            </span>
                                            <Button
                                                variant="ghost" size="icon" className="h-8 w-8 text-accent hover:text-accent"
                                                title="Record payment"
                                                onClick={() => { setPayDialog({ splitId: split.id, remaining: split.remaining }); setPayAmount(String(split.remaining)); }}
                                            >
                                                <DollarSign className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-accent"
                                                title="Mark as settled"
                                                onClick={() => settleSplit.mutate(split.id)}
                                            >
                                                <Check className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                                title="Delete split"
                                                onClick={() => deleteSplit.mutate(split.id)}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>
            )}

            {/* Payment dialog */}
            <Dialog open={!!payDialog} onOpenChange={() => setPayDialog(null)}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Record Payment</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3">
                        <div>
                            <label className="text-sm text-muted-foreground">Amount</label>
                            <Input
                                type="number"
                                step="0.01"
                                value={payAmount}
                                onChange={(e) => setPayAmount(e.target.value)}
                                placeholder="Payment amount"
                            />
                            {payDialog && (
                                <p className="text-xs text-muted-foreground mt-1">
                                    Remaining: {formatCurrency(payDialog.remaining, "EUR")}
                                </p>
                            )}
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setPayDialog(null)}>Cancel</Button>
                        <Button onClick={handlePay} disabled={recordPayment.isPending}>
                            {recordPayment.isPending ? "Recording..." : "Record Payment"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
