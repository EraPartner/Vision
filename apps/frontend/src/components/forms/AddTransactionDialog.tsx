import {useEffect, useState} from "react";
import {useSearchParams} from "react-router-dom";
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger} from "@/components/ui/dialog";
import {toast} from "sonner";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Textarea} from "@/components/ui/textarea";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select";
import {Plus, Loader2} from "lucide-react";
import {useCreateTransaction} from "@/hooks/useTransactions";
import {useRecipients} from "@/hooks/useRecipients";
import {useCategories} from "@/hooks/useCategories";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { DatePicker } from "@/components/shared/DatePicker";
import { parseLocalDateFromYmd, toYmd } from "@/components/shared/dateUtils";
import { createAddTransactionFormState } from "@/components/forms/addTransactionForm";
import { parseLocaleNumber } from "@/utils/currency";

export function AddTransactionDialog() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const [open, setOpen] = useState(false);
    const createMutation = useCreateTransaction();
    const {data: recipientsData} = useRecipients({limit: 200, active: true});
    const {data: categoriesData} = useCategories({limit: 200, active: true});

    const [form, setForm] = useState(() => createAddTransactionFormState(appSettings.defaultCurrency));

    // Deep link: /transactions?new=1 opens the dialog (native menu ⌘N + dock
    // menu "New Transaction"). Param is consumed so back/refresh don't reopen.
    const [searchParams, setSearchParams] = useSearchParams();
    const wantsNew = searchParams.get('new') === '1';
    useEffect(() => {
        if (!wantsNew) return;
        setOpen(true);
        setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.delete('new');
            return next;
        }, { replace: true });
    }, [wantsNew, setSearchParams]);

    const resetForm = () => {
        setForm(createAddTransactionFormState(appSettings.defaultCurrency));
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!form.transaction_date || !form.bank_account.trim() || !form.recipient_id || !form.amount) return;

        const amountValue = parseLocaleNumber(form.amount);
        if (!Number.isFinite(amountValue)) {
            toast.error(t('addTxn.invalidAmount') || 'Invalid amount');
            return;
        }

        createMutation.mutate(
            {
                transaction_date: form.transaction_date,
                bank_account: form.bank_account.trim(),
                recipient_id: Number(form.recipient_id),
                category_id: form.category_id ? Number(form.category_id) : undefined,
                memo: form.memo.trim() || undefined,
                amount: amountValue,
                currency: form.currency || appSettings.defaultCurrency,
                comment: form.comment.trim() || undefined,
            },
            {
                onSuccess: () => {
                    resetForm();
                    setOpen(false);
                },
                onError: (error: Error) => {
                    if (error.message.includes('Duplicate')) {
                        toast.error(t('addTxn.duplicateError'));
                    }
                },
            }
        );
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5">
                    <Plus className="h-4 w-4" /> {t('form.addTransaction.title')}
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t('form.addTransaction.title')}</DialogTitle>
                    <DialogDescription className="sr-only">{t('form.addTransaction.title')}</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="tx_date">{t('form.addTransaction.date')}</Label>
                            <DatePicker
                                value={form.transaction_date ? parseLocalDateFromYmd(form.transaction_date) : undefined}
                                onChange={(date) => setForm(f => ({ ...f, transaction_date: date ? toYmd(date) : "" }))}
                                placeholder={t('plannedPage.link.pickDate')}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="tx_amount">{t('form.addTransaction.amount')}</Label>
                            <Input id="tx_amount" type="text" inputMode="decimal" pattern="^-?[0-9]+([.,][0-9]+)?$" placeholder={t('form.addTransaction.amountPlaceholder')} value={form.amount} onChange={(e) => setForm(f => ({...f, amount: e.target.value}))} required />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="tx_bank">{t('addTxn.bankAccount')}</Label>
                            <Input id="tx_bank" placeholder={t('addTxn.bankAccountPlaceholder')} maxLength={100} value={form.bank_account} onChange={(e) => setForm(f => ({...f, bank_account: e.target.value}))} required />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="tx_currency">{t('form.addTransaction.bank')}</Label>
                            <Input id="tx_currency" placeholder={t('addTxn.currencyPlaceholder')} maxLength={10} value={form.currency} onChange={(e) => setForm(f => ({...f, currency: e.target.value}))} />
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label>{t('form.addTransaction.recipient')}</Label>
                        <Select value={form.recipient_id} onValueChange={(v) => setForm(f => ({...f, recipient_id: v}))}>
                            <SelectTrigger><SelectValue placeholder={t('form.addTransaction.recipient')} /></SelectTrigger>
                            <SelectContent>
                                {recipientsData?.items.map((r) => (
                                    <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-2">
                        <Label>{t('addTxn.categoryOptional')}</Label>
                        <Select value={form.category_id} onValueChange={(v) => setForm(f => ({...f, category_id: v}))}>
                            <SelectTrigger><SelectValue placeholder={t('form.addTransaction.category')} /></SelectTrigger>
                            <SelectContent>
                                {categoriesData?.items.map((c) => (
                                    <SelectItem key={c.id} value={String(c.id)}>{c.general}: {c.detail}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="tx_memo">{t('addTxn.descMemo')}</Label>
                        <Input id="tx_memo" placeholder={t('addTxn.descPlaceholder')} maxLength={500} value={form.memo} onChange={(e) => setForm(f => ({...f, memo: e.target.value}))} />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="tx_comment">{t('addTxn.commentOptional')}</Label>
                        <Textarea id="tx_comment" placeholder={t('addTxn.commentPlaceholder')} maxLength={1000} value={form.comment} onChange={(e) => setForm(f => ({...f, comment: e.target.value}))} />
                    </div>

                    <DialogFooter className="pt-2">
                        <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
                        <Button type="submit" disabled={createMutation.isPending || !form.transaction_date || !form.bank_account.trim() || !form.recipient_id || !form.amount}>
                            {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                            {t('common.create')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
