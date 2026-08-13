import {useEffect, useState} from "react";
import {useSearchParams} from "react-router";
import { ApiErrorCode } from "@vision/types";
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
import {ApiClientError} from "@/lib/api/client";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { DatePicker } from "@/components/shared/DatePicker";
import { formatDateStringWithAppSettings, parseLocalDateFromYmd, toYmd } from "@/components/shared/dateUtils";
import { useAccounts } from "@/hooks/useAccounts";
import { ADD_TRANSACTION_FIELD_IDS, addTransactionSchema, createAddTransactionFormState } from "@/features/transactions/addTransactionForm";
import { fieldErrorsFromZod } from "@/lib/forms/schemas";
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
    // The rules live in addTransactionSchema (Zod) — the same conditions that
    // used to be hand-rolled here; issue messages are i18n keys translated at
    // this seam, so the message on each field is unchanged. Server errors
    // still toast, below.
    const parsed = addTransactionSchema.safeParse(form);
    const fieldErrors: FieldErrorMap = fieldErrorsFromZod(
        parsed.success ? undefined : parsed.error,
        ADD_TRANSACTION_FIELD_IDS,
        t,
    );
    const { visibleErrors, checkValid, resetErrors } = useFieldErrors(fieldErrors, FIELD_ORDER);

    const resetForm = () => {
        setForm(createAddTransactionFormState(appSettings.defaultCurrency));
        resetErrors();
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        // checkValid() is false exactly when the schema found an issue on one
        // of the four mapped fields; the extra parsed.success guard is for the
        // type system, not the user.
        if (!checkValid() || !parsed.success) return;

        createMutation.mutate(
            {
                transaction_date: form.transaction_date,
                bank_account: form.bank_account.trim(),
                recipient_id: Number(form.recipient_id),
                category_id: form.category_id ? Number(form.category_id) : undefined,
                memo: form.memo.trim() || undefined,
                amount: parsed.data.amount,
                currency: form.currency || appSettings.defaultCurrency,
                comment: form.comment.trim() || undefined,
            },
            {
                onSuccess: () => {
                    resetForm();
                    setOpen(false);
                },
                onError: (error: Error) => {
                    // Backend signals the manual-dedup hit as ConflictError (409,
                    // ApiErrorCode.CONFLICT) — see transactionService.createManualTransaction.
                    // Key off the machine code, not the English message text, so a
                    // reworded message can't silently stop this branch from firing.
                    if (error instanceof ApiClientError && error.code === ApiErrorCode.CONFLICT) {
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
                {/* noValidate: this form's validation is `fieldErrors` above, and
                    it has to be the only one. The browser's own constraint check
                    runs BEFORE the submit event, so a native `required`/`pattern`
                    failure would swallow the submit, focus whichever control the
                    browser picked, and show a transient bubble — never the inline
                    messages, and never the first field in FIELD_ORDER. The
                    attributes stay on the inputs (they still carry the semantics
                    to assistive tech); only the browser's UI is turned off. */}
                <form onSubmit={handleSubmit} className="space-y-4" noValidate>
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
                            <Label htmlFor="tx_currency">{t('accounts.field.currency')}</Label>
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
                        {/* Only the in-flight guard disables this button. Disabling
                            it on the empty-required fields made the inline errors
                            mouse-unreachable — the pointer hit a dead control and
                            nothing ever said which field was missing. A blocked
                            submit is the thing that reveals them. */}
                        <Button type="submit" disabled={createMutation.isPending}>
                            {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                            {t('common.create')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
