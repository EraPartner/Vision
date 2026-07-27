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
import { formatDateStringWithAppSettings, parseLocalDateFromYmd, toYmd } from "@/components/shared/dateUtils";
import { useAccounts } from "@/hooks/useAccounts";
import { createAddTransactionFormState } from "@/components/forms/addTransactionForm";
import { parseLocaleNumber } from "@/utils/currency";
import { AccountCombobox } from "@/components/shared/AccountCombobox";
import { FieldError } from "@/components/ui/field-error";
import { fieldErrorProps, useFieldErrors, type FieldErrorMap } from "@/hooks/useFieldErrors";

/** Visual order — decides which field gets focus on a blocked submit. */
const FIELD_ORDER = ["tx_date", "tx_amount", "tx_bank", "tx_recipient"] as const;

export function AddTransactionDialog() {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const [open, setOpen] = useState(false);
    const createMutation = useCreateTransaction();
    const {data: recipientsData} = useRecipients({limit: 200, active: true});
    const {data: categoriesData} = useCategories({limit: 200, active: true});
    // Same cached list the AccountCombobox reads (identical query key) — used to
    // resolve the chosen account's statement anchor for the backdated note below.
    const {data: accountsData} = useAccounts({ active: "true" });

    const [form, setForm] = useState(() => createAddTransactionFormState(appSettings.defaultCurrency));

    // Backdated-entry provenance note (WP-B2): the computed balance anchors on
    // the most recent stamped bank-statement balance and only adds entries
    // *after* it, so an entry dated on/before that anchor won't move the
    // balance. Resolve the combobox's name value on the D1 normalized identity
    // (lower/trim), the same way AccountCombobox marks its selection; both
    // dates are YYYY-MM-DD strings, so plain string compare orders correctly.
    const normalizedChosen = form.bank_account.trim().toLowerCase();
    const chosenAccount = normalizedChosen
        ? accountsData?.items.find((a) => a.name.trim().toLowerCase() === normalizedChosen)
        : undefined;
    const backdatedAnchorDate =
        chosenAccount?.anchor_date && form.transaction_date && form.transaction_date <= chosenAccount.anchor_date
            ? chosenAccount.anchor_date
            : undefined;

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

    // Validation is recomputed every render but only *shown* once a submit has
    // been blocked (see useFieldErrors), so a corrected field clears itself.
    // These are the same conditions that used to return early / fire a toast —
    // the toast is gone because the message now lives on the field itself,
    // where a screen reader is taken to it. Server errors still toast, below.
    const amountValue = parseLocaleNumber(form.amount);
    const fieldErrors: FieldErrorMap = {
        tx_date: !form.transaction_date ? t('validation.required') : undefined,
        tx_amount: !form.amount
            ? t('validation.required')
            : !Number.isFinite(amountValue)
                ? (t('addTxn.invalidAmount') || 'Invalid amount')
                // Sign is the expense/income marker, so 0 is meaningless — the
                // backend rejects it too; catching it here gives a proper message.
                : amountValue === 0
                    ? t('addTxn.zeroAmount')
                    : undefined,
        // The bank-account field is a combobox and has no native `required`
        // message of its own.
        tx_bank: !form.bank_account.trim() ? t('portfolio.move.selectAccount') : undefined,
        tx_recipient: !form.recipient_id ? t('validation.required') : undefined,
    };
    const { visibleErrors, checkValid, resetErrors } = useFieldErrors(fieldErrors, FIELD_ORDER);

    const resetForm = () => {
        setForm(createAddTransactionFormState(appSettings.defaultCurrency));
        resetErrors();
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!checkValid()) return;

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
                                id="tx_date"
                                value={form.transaction_date ? parseLocalDateFromYmd(form.transaction_date) : undefined}
                                onChange={(date) => setForm(f => ({ ...f, transaction_date: date ? toYmd(date) : "" }))}
                                placeholder={t('plannedPage.link.pickDate')}
                                {...fieldErrorProps("tx_date", visibleErrors.tx_date)}
                            />
                            <FieldError field="tx_date" message={visibleErrors.tx_date} />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="tx_amount">{t('form.addTransaction.amount')}</Label>
                            <Input id="tx_amount" type="text" inputMode="decimal" pattern="^-?[0-9]+([.,][0-9]+)?$" placeholder={t('form.addTransaction.amountPlaceholder')} value={form.amount} onChange={(e) => setForm(f => ({...f, amount: e.target.value}))} required {...fieldErrorProps("tx_amount", visibleErrors.tx_amount)} />
                            <FieldError field="tx_amount" message={visibleErrors.tx_amount} />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="tx_bank">{t('addTxn.bankAccount')}</Label>
                            <AccountCombobox
                                id="tx_bank"
                                value={form.bank_account}
                                onChange={(name) => setForm(f => ({...f, bank_account: name}))}
                                placeholder={t('addTxn.bankAccountPlaceholder')}
                                {...fieldErrorProps("tx_bank", visibleErrors.tx_bank)}
                            />
                            <FieldError field="tx_bank" message={visibleErrors.tx_bank} />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="tx_currency">{t('form.addTransaction.bank')}</Label>
                            <Input id="tx_currency" placeholder={t('addTxn.currencyPlaceholder')} maxLength={10} value={form.currency} onChange={(e) => setForm(f => ({...f, currency: e.target.value}))} />
                        </div>
                    </div>

                    {backdatedAnchorDate && (
                        <p className="text-xs text-muted-foreground">
                            {t('addTxn.backdatedBeforeAnchor', {
                                date: formatDateStringWithAppSettings(backdatedAnchorDate, appSettings.dateFormat),
                            })}
                        </p>
                    )}

                    <div className="space-y-2">
                        <Label htmlFor="tx_recipient">{t('form.addTransaction.recipient')}</Label>
                        <Select value={form.recipient_id} onValueChange={(v) => setForm(f => ({...f, recipient_id: v}))}>
                            <SelectTrigger id="tx_recipient" {...fieldErrorProps("tx_recipient", visibleErrors.tx_recipient)}><SelectValue placeholder={t('form.addTransaction.recipient')} /></SelectTrigger>
                            <SelectContent>
                                {recipientsData?.items.map((r) => (
                                    <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <FieldError field="tx_recipient" message={visibleErrors.tx_recipient} />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="tx_category">{t('addTxn.categoryOptional')}</Label>
                        <Select value={form.category_id} onValueChange={(v) => setForm(f => ({...f, category_id: v}))}>
                            <SelectTrigger id="tx_category"><SelectValue placeholder={t('form.addTransaction.category')} /></SelectTrigger>
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
