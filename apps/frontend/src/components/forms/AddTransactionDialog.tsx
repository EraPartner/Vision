import {useState} from "react";
import {Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Textarea} from "@/components/ui/textarea";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select";
import {Plus, Loader2} from "lucide-react";
import {useCreateTransaction} from "@/hooks/useTransactions";
import {useRecipients} from "@/hooks/useRecipients";
import {useCategories} from "@/hooks/useCategories";

export function AddTransactionDialog() {
    const [open, setOpen] = useState(false);
    const createMutation = useCreateTransaction();
    const {data: recipientsData} = useRecipients({limit: 200, active: true});
    const {data: categoriesData} = useCategories({limit: 200, active: true});

    const [form, setForm] = useState({
        transaction_date: new Date().toISOString().split("T")[0],
        bank_account: "",
        recipient_id: "",
        category_id: "",
        memo: "",
        amount: "",
        currency: "EUR",
        comment: "",
    });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!form.transaction_date || !form.bank_account.trim() || !form.recipient_id || !form.amount) return;

        createMutation.mutate(
            {
                transaction_date: form.transaction_date,
                bank_account: form.bank_account.trim(),
                recipient_id: Number(form.recipient_id),
                category_id: form.category_id ? Number(form.category_id) : undefined,
                memo: form.memo.trim() || undefined,
                amount: Number(form.amount),
                currency: form.currency || "EUR",
                comment: form.comment.trim() || undefined,
            },
            {
                onSuccess: () => {
                    setForm({
                        transaction_date: new Date().toISOString().split("T")[0],
                        bank_account: "",
                        recipient_id: "",
                        category_id: "",
                        memo: "",
                        amount: "",
                        currency: "EUR",
                        comment: "",
                    });
                    setOpen(false);
                },
            }
        );
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5">
                    <Plus className="h-4 w-4" /> Add Transaction
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Add Transaction</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="tx_date">Date</Label>
                            <Input id="tx_date" type="date" value={form.transaction_date} onChange={(e) => setForm(f => ({...f, transaction_date: e.target.value}))} required />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="tx_amount">Amount</Label>
                            <Input id="tx_amount" type="number" step="0.01" placeholder="0.00" value={form.amount} onChange={(e) => setForm(f => ({...f, amount: e.target.value}))} required />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="tx_bank">Bank Account</Label>
                            <Input id="tx_bank" placeholder="e.g. Main Checking" maxLength={100} value={form.bank_account} onChange={(e) => setForm(f => ({...f, bank_account: e.target.value}))} required />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="tx_currency">Currency</Label>
                            <Input id="tx_currency" placeholder="EUR" maxLength={10} value={form.currency} onChange={(e) => setForm(f => ({...f, currency: e.target.value}))} />
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label>Recipient</Label>
                        <Select value={form.recipient_id} onValueChange={(v) => setForm(f => ({...f, recipient_id: v}))}>
                            <SelectTrigger><SelectValue placeholder="Select recipient" /></SelectTrigger>
                            <SelectContent>
                                {recipientsData?.items.map((r) => (
                                    <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-2">
                        <Label>Category (optional)</Label>
                        <Select value={form.category_id} onValueChange={(v) => setForm(f => ({...f, category_id: v}))}>
                            <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                            <SelectContent>
                                {categoriesData?.items.map((c) => (
                                    <SelectItem key={c.id} value={String(c.id)}>{c.general}: {c.detail}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="tx_memo">Description / Memo</Label>
                        <Input id="tx_memo" placeholder="Transaction description" value={form.memo} onChange={(e) => setForm(f => ({...f, memo: e.target.value}))} />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="tx_comment">Comment (optional)</Label>
                        <Textarea id="tx_comment" placeholder="Additional notes..." value={form.comment} onChange={(e) => setForm(f => ({...f, comment: e.target.value}))} />
                    </div>

                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                        <Button type="submit" disabled={createMutation.isPending}>
                            {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                            Create
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
