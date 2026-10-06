import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { ApiErrorCode } from "@vision/types";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FieldError } from "@/components/ui/field-error";
import { DatePicker } from "@/components/shared/DatePicker";
import { AccountCombobox } from "@/components/shared/AccountCombobox";
import { CategoryCombobox } from "@/components/shared/CategoryCombobox";
import { RecipientCombobox } from "@/components/shared/RecipientCombobox";
import { useCreateTransaction } from "@/hooks/useTransactions";
import { useAccounts } from "@/hooks/useAccounts";
import { useRecipient } from "@/hooks/useRecipients";
import { useCreateTransfer } from "@/features/transactions/hooks/useCreateTransfer";
import {
    fieldErrorProps,
    useFieldErrors,
    type FieldErrorMap,
} from "@/hooks/useFieldErrors";
import { fieldErrorsFromZod } from "@/lib/forms/schemas";
import { ApiClientError } from "@/lib/api/client";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";
import {
    formatDateStringWithAppSettings,
    parseLocalDateFromYmd,
    toYmd,
} from "@/lib/dateUtils";
import { todayYmd } from "@/lib/timezone";
import { formatNumberPlaceholder } from "@/utils/currency";
import { cn } from "@/lib/utils";
import {
    ADD_TRANSACTION_FIELD_IDS,
    ADD_TRANSACTION_FIELD_ORDER,
    createAddTransactionFormState,
    createAddTransactionSchema,
    signedAmount,
    type TransactionKind,
} from "@/features/transactions/addTransactionForm";
import type { Transaction, TransactionCreate } from "@/types/api";

export interface AddTransactionSheetProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /**
     * Fires once the row (for a transfer: its outflow leg) exists on the
     * server. Screens use it to select the new row or to navigate to it.
     */
    onCreated?: (transaction: Transaction, kind: TransactionKind) => void;
}

const KINDS: TransactionKind[] = ["expense", "income", "transfer"];

function yesterdayYmd(): string {
    const today = parseLocalDateFromYmd(todayYmd());
    today.setDate(today.getDate() - 1);
    return toYmd(today);
}

/**
 * New Transaction sheet (ADR-181): a right-hand sheet with an
 * Expense / Income / Transfer segmented control, one large amount field and
 * the few fields a manual entry needs. The kind supplies the sign, the chosen
 * account supplies the currency, and a recipient's usual category fills the
 * category until the user picks another. Validation shows inline on a
 * blocked submit (useFieldErrors); server conflicts still toast and offer
 * "Add anyway". A transfer records both legs and links them.
 */
export function AddTransactionSheet({
    open,
    onOpenChange,
    onCreated,
}: AddTransactionSheetProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const [duplicateDetected, setDuplicateDetected] = useState(false);
    const createMutation = useCreateTransaction({ silent: true });
    const createTransfer = useCreateTransfer();
    // Same cached list the AccountCombobox reads (identical query key): used
    // for the account's currency and its statement anchor (backdated note).
    const { data: accountsData } = useAccounts({ active: "true" });

    const [form, setForm] = useState(() =>
        createAddTransactionFormState(appSettings.defaultCurrency),
    );
    const [categoryAuto, setCategoryAuto] = useState(false);
    const [customDate, setCustomDate] = useState(false);
    const [portalContainer, setPortalContainer] =
        useState<HTMLDivElement | null>(null);
    const amountRef = useRef<HTMLInputElement | null>(null);

    const defaultForm = createAddTransactionFormState(
        appSettings.defaultCurrency,
        form.kind,
    );
    useUnsavedChanges(
        open && JSON.stringify(form) !== JSON.stringify(defaultForm),
    );

    const accounts = useMemo(
        () => accountsData?.items ?? [],
        [accountsData?.items],
    );
    const findAccount = useCallback(
        (name: string) => {
            const normalized = name.trim().toLowerCase();
            if (!normalized) return undefined;
            return accounts.find(
                (a) => a.name.trim().toLowerCase() === normalized,
            );
        },
        [accounts],
    );
    const chosenAccount = findAccount(form.bank_account);
    const backdatedAnchorDate =
        chosenAccount?.anchor_date &&
        form.transaction_date &&
        form.transaction_date <= chosenAccount.anchor_date
            ? chosenAccount.anchor_date
            : undefined;

    // A recipient's usual category fills the field until the user chooses.
    const recipientId = form.recipient_id ? Number(form.recipient_id) : null;
    const { data: recipient } = useRecipient(recipientId);
    useEffect(() => {
        if (!recipient || recipient.id !== recipientId) return;
        const usual = recipient.default_category_id;
        setForm((f) => {
            if (f.category_id && !categoryAuto) return f;
            const next = usual ? String(usual) : "";
            if (f.category_id === next) return f;
            return { ...f, category_id: next };
        });
        setCategoryAuto(Boolean(usual));
        // categoryAuto is intentionally not a dependency: it describes the
        // current value's origin and must not re-run the fill when it flips.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recipient, recipientId]);

    // Deep link: /transactions?new=1 opens the sheet (native menu ⌘N, dock
    // menu and the web ⌘N shortcut). Consumed so back/refresh don't reopen.
    const [searchParams, setSearchParams] = useSearchParams();
    const wantsNew = searchParams.get("new") === "1";
    useEffect(() => {
        if (!wantsNew) return;
        onOpenChange(true);
        setSearchParams(
            (prev) => {
                const next = new URLSearchParams(prev);
                next.delete("new");
                return next;
            },
            { replace: true },
        );
    }, [wantsNew, setSearchParams, onOpenChange]);

    const parsed = createAddTransactionSchema(
        appSettings.numberFormat,
    ).safeParse(form);
    const fieldErrors: FieldErrorMap = fieldErrorsFromZod(
        parsed.success ? undefined : parsed.error,
        ADD_TRANSACTION_FIELD_IDS,
        t,
    );
    const { visibleErrors, checkValid, resetErrors } = useFieldErrors(
        fieldErrors,
        ADD_TRANSACTION_FIELD_ORDER,
    );

    const resetForm = useCallback(() => {
        setForm(createAddTransactionFormState(appSettings.defaultCurrency));
        setCategoryAuto(false);
        setCustomDate(false);
        setDuplicateDetected(false);
        resetErrors();
    }, [appSettings.defaultCurrency, resetErrors]);

    useEffect(() => {
        setDuplicateDetected(false);
    }, [form]);

    const isPending = createMutation.isPending || createTransfer.isPending;

    const finish = (created: Transaction) => {
        const kind = form.kind;
        resetForm();
        onOpenChange(false);
        onCreated?.(created, kind);
    };

    const submitTransaction = (transaction: TransactionCreate) => {
        createMutation.mutate(transaction, {
            onSuccess: finish,
            onError: (error: Error) => {
                if (
                    error instanceof ApiClientError &&
                    error.code === ApiErrorCode.CONFLICT
                ) {
                    setDuplicateDetected(true);
                    toast.error(t("addTxn.duplicateError"));
                }
            },
        });
    };

    const transactionFromForm = (): TransactionCreate | null => {
        if (!parsed.success) return null;
        return {
            transaction_date: form.transaction_date,
            account_id: parsed.data.account_id,
            recipient_id: Number(form.recipient_id),
            category_id: form.category_id
                ? Number(form.category_id)
                : undefined,
            memo: form.memo.trim() || undefined,
            amount: signedAmount(form.kind, parsed.data.amount),
            currency: form.currency || appSettings.defaultCurrency,
            comment: form.comment.trim() || undefined,
        };
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!checkValid() || !parsed.success) return;
        if (form.kind === "transfer") {
            const toAccount = parsed.data.to_account_id;
            if (toAccount == null) return;
            createTransfer.mutate(
                {
                    transaction_date: form.transaction_date,
                    from_account_id: parsed.data.account_id,
                    from_account_name: form.bank_account,
                    to_account_id: toAccount,
                    to_account_name: form.to_bank_account,
                    amount: Math.abs(parsed.data.amount),
                    currency: form.currency || appSettings.defaultCurrency,
                    memo: form.memo.trim() || undefined,
                    comment: form.comment.trim() || undefined,
                },
                { onSuccess: ({ outflow }) => finish(outflow) },
            );
            return;
        }
        const transaction = transactionFromForm();
        if (transaction) submitTransaction(transaction);
    };

    const setKind = (kind: TransactionKind) => {
        setForm((f) => ({ ...f, kind }));
        resetErrors();
    };

    const pickAccount = (name: string) => {
        const account = findAccount(name);
        setForm((f) => ({
            ...f,
            bank_account: name,
            currency: account?.currency ?? f.currency,
        }));
    };

    const today = todayYmd();
    const yesterday = yesterdayYmd();
    const dateIsPreset =
        !customDate &&
        (form.transaction_date === today ||
            form.transaction_date === yesterday);

    const hint = (() => {
        if (!form.amount.trim()) return t("addTxn.hint.amount");
        if (form.kind !== "transfer" && !form.recipient_id)
            return t(
                form.kind === "income"
                    ? "addTxn.hint.recipientIncome"
                    : "addTxn.hint.recipient",
            );
        if (!form.account_id) return t("addTxn.hint.account");
        if (form.kind === "transfer" && !form.to_account_id)
            return t("addTxn.hint.toAccount");
        return "";
    })();

    const verb = t(
        form.kind === "income"
            ? "addTxn.addIncome"
            : form.kind === "transfer"
              ? "addTxn.addTransfer"
              : "addTxn.addExpense",
    );
    const sign = form.kind === "expense" ? "−" : form.kind === "income" ? "+" : "";
    const title = t("form.addTransaction.title");

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent
                side="right"
                className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[470px]"
                onOpenAutoFocus={(event) => {
                    event.preventDefault();
                    amountRef.current?.focus();
                }}
            >
                <div ref={setPortalContainer} />
                <SheetHeader className="px-6 pt-6">
                    <SheetTitle>{title}</SheetTitle>
                    <SheetDescription className="sr-only">
                        {title}
                    </SheetDescription>
                </SheetHeader>
                {/* noValidate: validation is `fieldErrors` above, and it has to
                    be the only one (see useFieldErrors for the focus contract). */}
                <form
                    onSubmit={handleSubmit}
                    noValidate
                    className="flex min-h-0 flex-1 flex-col"
                    onKeyDown={(event) => {
                        if (
                            event.key === "Enter" &&
                            (event.metaKey || event.ctrlKey)
                        ) {
                            event.preventDefault();
                            event.currentTarget.requestSubmit();
                        }
                    }}
                >
                    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
                        <SegmentedControl
                            aria-label={t("addTxn.kind")}
                            value={form.kind}
                            onValueChange={(value) =>
                                setKind(value as TransactionKind)
                            }
                            className="w-full max-w-[320px] self-center"
                        >
                            {KINDS.map((kind) => (
                                <SegmentedControlItem key={kind} value={kind}>
                                    {t(`addTxn.kind.${kind}`)}
                                </SegmentedControlItem>
                            ))}
                        </SegmentedControl>

                        <div className="space-y-2">
                            <Label htmlFor="tx_amount" className="sr-only">
                                {t("form.addTransaction.amount")}
                            </Label>
                            <div
                                className={cn(
                                    "flex items-center justify-center gap-2 rounded-card corner-continuous bg-foreground/[0.04] px-4 py-5",
                                    visibleErrors.tx_amount &&
                                        "ring-1 ring-destructive/60",
                                )}
                            >
                                <span
                                    aria-hidden="true"
                                    className="w-6 text-right type-large-title text-label-tertiary tabular-nums"
                                >
                                    {sign}
                                </span>
                                <Input
                                    ref={amountRef}
                                    id="tx_amount"
                                    type="text"
                                    inputMode="decimal"
                                    autoComplete="off"
                                    placeholder={formatNumberPlaceholder(
                                        appSettings.numberFormat,
                                    )}
                                    value={form.amount}
                                    onChange={(e) =>
                                        setForm((f) => ({
                                            ...f,
                                            amount: e.target.value,
                                        }))
                                    }
                                    required
                                    className="h-auto w-[11ch] border-0 bg-transparent px-0 text-center type-large-title tabular-nums shadow-none placeholder:text-label-tertiary focus-visible:outline-none"
                                    {...fieldErrorProps(
                                        "tx_amount",
                                        visibleErrors.tx_amount,
                                    )}
                                />
                                <Input
                                    id="tx_currency"
                                    aria-label={t("accounts.field.currency")}
                                    placeholder={t(
                                        "addTxn.currencyPlaceholder",
                                    )}
                                    maxLength={10}
                                    value={form.currency}
                                    onChange={(e) =>
                                        setForm((f) => ({
                                            ...f,
                                            currency: e.target.value,
                                        }))
                                    }
                                    className="h-8 w-[5.5ch] border-0 bg-transparent px-0 text-center type-title-3 text-label-secondary shadow-none uppercase"
                                />
                            </div>
                            <FieldError
                                field="tx_amount"
                                message={visibleErrors.tx_amount}
                                className="text-center"
                            />
                        </div>

                        <div className="grid grid-cols-1 gap-4">
                            {form.kind === "transfer" ? (
                                <>
                                    <div className="space-y-2">
                                        <Label htmlFor="tx_bank">
                                            {t("addTxn.fromAccount")}
                                        </Label>
                                        <AccountCombobox
                                            id="tx_bank"
                                            value={form.bank_account}
                                            onChange={pickAccount}
                                            onAccountIdChange={(accountId) =>
                                                setForm((f) => ({
                                                    ...f,
                                                    account_id: accountId,
                                                }))
                                            }
                                            placeholder={t(
                                                "addTxn.bankAccountPlaceholder",
                                            )}
                                            portalContainer={portalContainer}
                                            {...fieldErrorProps(
                                                "tx_bank",
                                                visibleErrors.tx_bank,
                                            )}
                                        />
                                        <FieldError
                                            field="tx_bank"
                                            message={visibleErrors.tx_bank}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="tx_to_bank">
                                            {t("addTxn.toAccount")}
                                        </Label>
                                        <AccountCombobox
                                            id="tx_to_bank"
                                            value={form.to_bank_account}
                                            onChange={(name) =>
                                                setForm((f) => ({
                                                    ...f,
                                                    to_bank_account: name,
                                                }))
                                            }
                                            onAccountIdChange={(accountId) =>
                                                setForm((f) => ({
                                                    ...f,
                                                    to_account_id: accountId,
                                                }))
                                            }
                                            placeholder={t(
                                                "addTxn.bankAccountPlaceholder",
                                            )}
                                            portalContainer={portalContainer}
                                            {...fieldErrorProps(
                                                "tx_to_bank",
                                                visibleErrors.tx_to_bank,
                                            )}
                                        />
                                        <FieldError
                                            field="tx_to_bank"
                                            message={visibleErrors.tx_to_bank}
                                        />
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="space-y-2">
                                        <Label htmlFor="tx_recipient">
                                            {t(
                                                form.kind === "income"
                                                    ? "addTxn.recipientIncome"
                                                    : "form.addTransaction.recipient",
                                            )}
                                        </Label>
                                        <RecipientCombobox
                                            id="tx_recipient"
                                            value={recipientId}
                                            onSelect={(id) => {
                                                setForm((f) => ({
                                                    ...f,
                                                    recipient_id:
                                                        id == null
                                                            ? ""
                                                            : String(id),
                                                    category_id: categoryAuto
                                                        ? ""
                                                        : f.category_id,
                                                }));
                                                if (categoryAuto)
                                                    setCategoryAuto(false);
                                            }}
                                            active
                                            allowCreate
                                            className="w-full"
                                            portalContainer={portalContainer}
                                            {...fieldErrorProps(
                                                "tx_recipient",
                                                visibleErrors.tx_recipient,
                                            )}
                                        />
                                        <FieldError
                                            field="tx_recipient"
                                            message={visibleErrors.tx_recipient}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="tx_category">
                                            {t("addTxn.categoryOptional")}
                                        </Label>
                                        <CategoryCombobox
                                            id="tx_category"
                                            value={
                                                form.category_id
                                                    ? Number(form.category_id)
                                                    : null
                                            }
                                            onSelect={(id) => {
                                                setCategoryAuto(false);
                                                setForm((f) => ({
                                                    ...f,
                                                    category_id:
                                                        id == null
                                                            ? ""
                                                            : String(id),
                                                }));
                                            }}
                                            className="w-full"
                                            portalContainer={portalContainer}
                                        />
                                        {categoryAuto && recipient && (
                                            <p className="type-footnote text-label-secondary">
                                                {t("addTxn.usualCategory", {
                                                    name: recipient.name,
                                                    category:
                                                        recipient.default_category_name ??
                                                        "",
                                                })}
                                            </p>
                                        )}
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="tx_bank">
                                            {t("addTxn.bankAccount")}
                                        </Label>
                                        <AccountCombobox
                                            id="tx_bank"
                                            value={form.bank_account}
                                            onChange={pickAccount}
                                            onAccountIdChange={(accountId) =>
                                                setForm((f) => ({
                                                    ...f,
                                                    account_id: accountId,
                                                }))
                                            }
                                            placeholder={t(
                                                "addTxn.bankAccountPlaceholder",
                                            )}
                                            portalContainer={portalContainer}
                                            {...fieldErrorProps(
                                                "tx_bank",
                                                visibleErrors.tx_bank,
                                            )}
                                        />
                                        <FieldError
                                            field="tx_bank"
                                            message={visibleErrors.tx_bank}
                                        />
                                    </div>
                                </>
                            )}

                            <div className="space-y-2">
                                <Label htmlFor="tx_date">
                                    {t("form.addTransaction.date")}
                                </Label>
                                <div className="flex flex-wrap items-center gap-2">
                                    <SegmentedControl
                                        id={dateIsPreset ? "tx_date" : undefined}
                                        size="sm"
                                        aria-label={t("form.addTransaction.date")}
                                        value={
                                            dateIsPreset
                                                ? form.transaction_date ===
                                                  today
                                                    ? "today"
                                                    : "yesterday"
                                                : "other"
                                        }
                                        onValueChange={(value) => {
                                            if (value === "other") {
                                                setCustomDate(true);
                                                return;
                                            }
                                            setCustomDate(false);
                                            setForm((f) => ({
                                                ...f,
                                                transaction_date:
                                                    value === "today"
                                                        ? today
                                                        : yesterday,
                                            }));
                                        }}
                                    >
                                        <SegmentedControlItem value="today">
                                            {t("addTxn.date.today")}
                                        </SegmentedControlItem>
                                        <SegmentedControlItem value="yesterday">
                                            {t("addTxn.date.yesterday")}
                                        </SegmentedControlItem>
                                        <SegmentedControlItem value="other">
                                            {t("addTxn.date.other")}
                                        </SegmentedControlItem>
                                    </SegmentedControl>
                                    {!dateIsPreset && (
                                        <DatePicker
                                            id="tx_date"
                                            value={
                                                form.transaction_date
                                                    ? parseLocalDateFromYmd(
                                                          form.transaction_date,
                                                      )
                                                    : undefined
                                            }
                                            onChange={(date) =>
                                                setForm((f) => ({
                                                    ...f,
                                                    transaction_date: date
                                                        ? toYmd(date)
                                                        : "",
                                                }))
                                            }
                                            placeholder={t(
                                                "plannedPage.link.pickDate",
                                            )}
                                            buttonClassName="h-8"
                                            {...fieldErrorProps(
                                                "tx_date",
                                                visibleErrors.tx_date,
                                            )}
                                        />
                                    )}
                                </div>
                                <FieldError
                                    field="tx_date"
                                    message={visibleErrors.tx_date}
                                />
                                {backdatedAnchorDate && (
                                    <p className="type-footnote text-label-secondary">
                                        {t("addTxn.backdatedBeforeAnchor", {
                                            date: formatDateStringWithAppSettings(
                                                backdatedAnchorDate,
                                                appSettings.dateFormat,
                                            ),
                                        })}
                                    </p>
                                )}
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="tx_memo">
                                    {t("addTxn.descMemo")}
                                </Label>
                                <Input
                                    id="tx_memo"
                                    placeholder={t("addTxn.descPlaceholder")}
                                    maxLength={500}
                                    value={form.memo}
                                    onChange={(e) =>
                                        setForm((f) => ({
                                            ...f,
                                            memo: e.target.value,
                                        }))
                                    }
                                />
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="tx_comment">
                                    {t("addTxn.commentOptional")}
                                </Label>
                                <Textarea
                                    id="tx_comment"
                                    placeholder={t("addTxn.commentPlaceholder")}
                                    maxLength={1000}
                                    rows={2}
                                    value={form.comment}
                                    onChange={(e) =>
                                        setForm((f) => ({
                                            ...f,
                                            comment: e.target.value,
                                        }))
                                    }
                                />
                            </div>
                        </div>
                    </div>

                    <div className="flex flex-col gap-3 border-t border-border/50 px-6 py-4">
                        {duplicateDetected && (
                            <div className="space-y-2 type-footnote" role="alert">
                                <p>{t("addTxn.duplicatePrompt")}</p>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    disabled={isPending}
                                    onClick={() => {
                                        const transaction =
                                            transactionFromForm();
                                        if (transaction) {
                                            submitTransaction({
                                                ...transaction,
                                                allow_duplicate: true,
                                            });
                                        }
                                    }}
                                >
                                    {t("addTxn.addAnyway")}
                                </Button>
                            </div>
                        )}
                        <div className="flex items-center gap-3">
                            <p
                                className="min-w-0 flex-1 truncate type-footnote text-label-secondary"
                                aria-live="polite"
                            >
                                {hint || t("addTxn.hint.ready")}
                            </p>
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={() => onOpenChange(false)}
                            >
                                {t("common.cancel")}
                            </Button>
                            {/* Only the in-flight guard disables this: a blocked
                                submit is what reveals the inline errors. */}
                            <Button type="submit" disabled={isPending}>
                                {isPending && (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                )}
                                {verb}
                            </Button>
                        </div>
                    </div>
                </form>
            </SheetContent>
        </Sheet>
    );
}

export interface AddTransactionButtonProps {
    onCreated?: AddTransactionSheetProps["onCreated"];
    size?: "default" | "sm";
    className?: string;
}

/** The primary "Add transaction" button together with the sheet it opens. */
export function AddTransactionButton({
    onCreated,
    size = "default",
    className,
}: AddTransactionButtonProps) {
    const { t } = useLanguage();
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button
                size={size}
                className={className}
                onClick={() => setOpen(true)}
            >
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t("form.addTransaction.title")}
            </Button>
            <AddTransactionSheet
                open={open}
                onOpenChange={setOpen}
                onCreated={onCreated}
            />
        </>
    );
}
