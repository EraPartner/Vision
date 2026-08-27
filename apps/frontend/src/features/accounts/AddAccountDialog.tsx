import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { useCreateAccount } from "@/hooks/useAccounts";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api";
import { invalidateAccountDerived, invalidateTransactionData } from "@/lib/queryKeys";
import { parseDecimal } from "@/lib/decimal";
import { toYmd } from "@/components/shared/dateUtils";
import type { AccountType, AccountOwner, AccountLiquidityClass, AccountTaxWrapper } from "@/types/api";
import { SUPPORTED_CURRENCIES as CURRENCIES } from "@/utils/currency";
import { toAccountPayload } from "./accountFormMapping";
import { accountFormSchema } from "./accountFormSchema";

export type AccountFormValues = {
    name: string;
    display_name: string;
    institution: string;
    currency: string;
    type: AccountType;
    owner: AccountOwner;
    liquidity_class: AccountLiquidityClass;
    tax_wrapper: AccountTaxWrapper;
    spendable: boolean;
    in_net_worth: boolean;
    multi_currency_cash: boolean;
    has_cash_sleeve: boolean;
    statementBalance: string;
    statementBalanceDate: string;
};

const ACCOUNT_TYPES: AccountType[] = [
    "checking", "savings", "brokerage", "crypto_exchange", "wallet", "pension", "liability",
];
const OWNERS: AccountOwner[] = ["me", "partner", "joint"];
const LIQUIDITY: AccountLiquidityClass[] = ["liquid", "semi_liquid", "illiquid"];

// Flag fields that flagsForType pre-fills. Once the user edits one of these
// directly, a later type change must not clobber their choice — ADR-089
// defaults are only suggestions for fields the user hasn't touched.
// has_cash_sleeve/tax_wrapper stay listed although their inputs were removed
// from the dialog (§3 F7, consumer-less): they can no longer be "touched", so
// a type change always applies their type-driven payload defaults.
const FLAG_KEYS = ["liquidity_class", "spendable", "has_cash_sleeve", "tax_wrapper"] as const;
type FlagKey = typeof FLAG_KEYS[number];

const EMPTY: AccountFormValues = {
    name: "", display_name: "", institution: "", currency: "EUR", type: "checking",
    owner: "me", liquidity_class: "liquid", tax_wrapper: "none",
    spendable: true, in_net_worth: true, multi_currency_cash: false, has_cash_sleeve: true,
    statementBalance: "", statementBalanceDate: "",
};

// Type-driven flag suggestions (ADR-089) — selecting a type pre-fills sensible flags.
function flagsForType(type: AccountType): Partial<AccountFormValues> {
    switch (type) {
        case "savings": return { liquidity_class: "liquid", spendable: false, has_cash_sleeve: true, tax_wrapper: "none" };
        case "brokerage": return { liquidity_class: "semi_liquid", spendable: false, has_cash_sleeve: true, tax_wrapper: "none" };
        case "crypto_exchange": return { liquidity_class: "semi_liquid", spendable: false, has_cash_sleeve: true, tax_wrapper: "none" };
        case "wallet": return { liquidity_class: "semi_liquid", spendable: false, has_cash_sleeve: false, tax_wrapper: "none" };
        case "pension": return { liquidity_class: "illiquid", spendable: false, has_cash_sleeve: false, tax_wrapper: "pension" };
        case "liability": return { liquidity_class: "illiquid", spendable: false, has_cash_sleeve: false, tax_wrapper: "none" };
        case "checking":
        default: return { liquidity_class: "liquid", spendable: true, has_cash_sleeve: true, tax_wrapper: "none" };
    }
}

type AddAccountDialogProps =
    | { mode?: "create" }
    | {
        mode: "edit";
        initialValues: AccountFormValues;
        open: boolean;
        onOpenChange: (open: boolean) => void;
        onSave: (values: AccountFormValues) => void;
        isSaving?: boolean;
      };

export function AddAccountDialog(props: AddAccountDialogProps = {}) {
    const { t } = useLanguage();
    const queryClient = useQueryClient();
    const isEditMode = props.mode === "edit";
    const editProps = isEditMode ? props : undefined;

    const [createOpen, setCreateOpen] = useState(false);
    // In edit mode the account already has populated flags/statement fields, so
    // the "Advanced" section starts expanded — don't hide the user's data behind
    // a collapsed toggle. Create mode still starts collapsed for a lean form.
    const [showAdvanced, setShowAdvanced] = useState(isEditMode);
    const createMutation = useCreateAccount();

    // Initialized once on mount. Parents mount the edit dialog per target
    // (keyed by account id), so a target switch remounts with fresh values —
    // no sync effect, which would revert in-flight edits on parent re-renders.
    const [form, setForm] = useState<AccountFormValues>(
        isEditMode ? props.initialValues : EMPTY,
    );

    // Optional opening balance on create (§3 F4) — after the account is created
    // this lands as the visible transfer_source='opening' ledger row via the
    // existing POST /accounts/:id/opening-balance path. Not part of
    // AccountFormValues: edit mode uses the OpeningBalanceDialog instead.
    const [openingBalance, setOpeningBalance] = useState("");
    const [openingBalanceDate, setOpeningBalanceDate] = useState(() => toYmd(new Date()));

    const stampOpeningBalance = useMutation({
        mutationFn: (input: { id: number; balance: number; date: string; currency: string }) =>
            apiClient.setOpeningBalance(input.id, {
                balance: input.balance,
                date: input.date,
                currency: input.currency,
            }),
        onSuccess: (result) => {
            // The anchor is a real ledger row — balances/net worth and the
            // transaction lists all restate (same fan-out as OpeningBalanceDialog).
            invalidateAccountDerived(queryClient);
            invalidateTransactionData(queryClient);
            if (result.warning) toast.warning(t('accounts.openingBalance.saved'), { description: result.warning });
            else toast.success(t('accounts.openingBalance.saved'));
        },
        onError: (e: Error) => toast.error(t('accounts.openingBalance.failed'), { description: apiErrorToMessage(e, t) }),
    });

    // Flag fields the user has edited by hand this session; a type change leaves
    // these alone and only applies flagsForType defaults to untouched fields.
    const [touchedFlags, setTouchedFlags] = useState<Set<FlagKey>>(new Set());

    // display_name mirrors name until the user edits it by hand (§3 F7
    // auto-suggest). Only in create mode — an existing account's display name
    // is its own value and must never be clobbered by a name edit.
    const [displayNameEdited, setDisplayNameEdited] = useState(isEditMode);

    const set = <K extends keyof AccountFormValues>(key: K, value: AccountFormValues[K]) => {
        if ((FLAG_KEYS as readonly string[]).includes(key as string)) {
            setTouchedFlags(prev => new Set(prev).add(key as FlagKey));
        }
        setForm(f => ({ ...f, [key]: value }));
    };

    const onNameChange = (name: string) => {
        setForm(f => ({
            ...f,
            name,
            ...(displayNameEdited ? {} : { display_name: name }),
        }));
    };

    const onDisplayNameChange = (display_name: string) => {
        setDisplayNameEdited(true);
        setForm(f => ({ ...f, display_name }));
    };

    const onTypeChange = (type: AccountType) => {
        const defaults = flagsForType(type);
        const untouched = Object.fromEntries(
            FLAG_KEYS.filter(k => !touchedFlags.has(k)).map(k => [k, defaults[k]]),
        ) as Partial<AccountFormValues>;
        setForm(f => ({ ...f, type, ...untouched }));
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        // Validation + string normalization live in accountFormSchema; the
        // presentation of each failure is unchanged.
        const parsed = accountFormSchema(isEditMode ? "edit" : "create").safeParse(form);
        if (!parsed.success) {
            // Missing name: silent block, as always (the submit button is
            // disabled on it too — this is the keyboard-submit backstop).
            if (parsed.error.issues.some((issue) => issue.path[0] === "name")) return;
            // Statement balance without its as-of date (ADR-094, edit only).
            // The date input is marked required, but it lives in the Advanced
            // section which is unmounted while collapsed — so a bare `return`
            // here would be a silent dead-end. Expand the section (revealing
            // the required field) and surface a toast instead of failing
            // invisibly.
            setShowAdvanced(true);
            toast.error(t('accounts.field.statementBalance'), {
                description: t('accounts.field.statementBalanceDate'),
            });
            return;
        }

        const values: AccountFormValues = {
            ...form,
            ...parsed.data,
            // Belt-and-braces: a create payload must never carry a statement
            // reading, whatever a stale form value says.
            ...(isEditMode ? {} : { statementBalance: "", statementBalanceDate: "" }),
        };

        if (isEditMode) {
            editProps?.onSave(values);
        } else {
            const openingAmount = openingBalance.trim() ? parseDecimal(openingBalance) : null;
            createMutation.mutate(
                toAccountPayload(values, "create"),
                {
                    onSuccess: (created) => {
                        // Opening balance entered on create → stamp the visible
                        // 'opening' ledger row on the new account (§3 F4).
                        if (openingAmount != null && Number.isFinite(openingAmount) && openingBalanceDate) {
                            stampOpeningBalance.mutate({
                                id: created.id,
                                balance: openingAmount,
                                date: openingBalanceDate,
                                currency: values.currency,
                            });
                        }
                        setForm(EMPTY);
                        setTouchedFlags(new Set());
                        setDisplayNameEdited(false);
                        setOpeningBalance("");
                        setOpeningBalanceDate(toYmd(new Date()));
                        setShowAdvanced(false);
                        setCreateOpen(false);
                    },
                },
            );
        }
    };

    const open = editProps?.open ?? createOpen;
    const onOpenChange = editProps?.onOpenChange ?? setCreateOpen;
    const isPending = editProps?.isSaving ?? createMutation.isPending;

    const switchRow = (key: keyof AccountFormValues, label: string, hint?: string) => (
        <div className="py-1.5">
            <div className="flex items-center justify-between">
                <Label htmlFor={`acct-${key}`} className="font-normal">{label}</Label>
                <Switch
                    id={`acct-${key}`}
                    checked={form[key] as boolean}
                    onCheckedChange={(v) => set(key, v as AccountFormValues[typeof key])}
                />
            </div>
            {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
    );

    const dialogContent = (
        <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
            <DialogHeader>
                <DialogTitle>
                    {isEditMode ? t('accounts.editTitle') : t('accounts.addTitle')}
                </DialogTitle>
                <DialogDescription className="sr-only">
                    {isEditMode ? t('accounts.editTitle') : t('accounts.addTitle')}
                </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                    <Label htmlFor="acct-name">{t('accounts.field.name')}</Label>
                    <Input
                        id="acct-name"
                        placeholder={t('accounts.field.namePlaceholder')}
                        maxLength={200}
                        value={form.name}
                        onChange={(e) => onNameChange(e.target.value)}
                        required
                    />
                    <p className="text-xs text-muted-foreground">{t('accounts.field.nameHint')}</p>
                </div>
                <div className="space-y-2">
                    <Label htmlFor="acct-display">{t('accounts.field.displayName')}</Label>
                    <Input
                        id="acct-display"
                        placeholder={t('accounts.field.displayNamePlaceholder')}
                        maxLength={200}
                        value={form.display_name}
                        onChange={(e) => onDisplayNameChange(e.target.value)}
                    />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                        <Label htmlFor="acct-institution">{t('accounts.field.institution')}</Label>
                        <Input
                            id="acct-institution"
                            maxLength={200}
                            value={form.institution}
                            onChange={(e) => set("institution", e.target.value)}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="acct-currency">{t('accounts.field.currency')}</Label>
                        <Select value={form.currency} onValueChange={(v) => set("currency", v)}>
                            <SelectTrigger id="acct-currency"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {(CURRENCIES.includes(form.currency)
                                    ? CURRENCIES
                                    : [form.currency, ...CURRENCIES]
                                ).map((c) => (
                                    <SelectItem key={c} value={c}>{c}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>
                <div className="space-y-2">
                    <Label htmlFor="acct-type">{t('accounts.field.type')}</Label>
                    <Select value={form.type} onValueChange={(v) => onTypeChange(v as AccountType)}>
                        <SelectTrigger id="acct-type"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {ACCOUNT_TYPES.map((tp) => (
                                <SelectItem key={tp} value={tp}>{t(`accounts.type.${tp}`)}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {/* Opening balance on create (§3 F4) — stamps the visible
                    'opening' ledger row after creation. Liability accounts
                    call it what it is: outstanding debt. */}
                {!isEditMode && (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                            <Label htmlFor="acct-opening-balance">
                                {form.type === "liability"
                                    ? t('accounts.openingBalance.createDebtLabel')
                                    : t('accounts.openingBalance.createLabel')}
                            </Label>
                            <Input
                                id="acct-opening-balance"
                                type="text"
                                inputMode="decimal"
                                pattern="^-?[0-9]+([.,][0-9]+)?$"
                                placeholder={t('accounts.openingBalance.createPlaceholder')}
                                value={openingBalance}
                                onChange={(e) => setOpeningBalance(e.target.value)}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="acct-opening-date">{t('accounts.openingBalance.dateLabel')}</Label>
                            <Input
                                id="acct-opening-date"
                                type="date"
                                required={!!openingBalance.trim()}
                                value={openingBalanceDate}
                                onChange={(e) => setOpeningBalanceDate(e.target.value)}
                            />
                        </div>
                        <p className="-mt-1 text-xs text-muted-foreground sm:col-span-2">
                            {t('accounts.openingBalance.createHint')}
                        </p>
                    </div>
                )}

                <button
                    type="button"
                    className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                    onClick={() => setShowAdvanced(v => !v)}
                >
                    {showAdvanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    {t('accounts.advanced')}
                </button>

                {showAdvanced && (
                    <div className="space-y-3 rounded-lg border border-border/50 p-3">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Label htmlFor="acct-owner">{t('accounts.field.owner')}</Label>
                                <Select value={form.owner} onValueChange={(v) => set("owner", v as AccountOwner)}>
                                    <SelectTrigger id="acct-owner"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {OWNERS.map((o) => (
                                            <SelectItem key={o} value={o}>{t(`accounts.owner.${o}`)}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <p className="text-xs text-muted-foreground">{t('accounts.field.ownerHint')}</p>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="acct-liquidity">{t('accounts.field.liquidityClass')}</Label>
                                <Select value={form.liquidity_class} onValueChange={(v) => set("liquidity_class", v as AccountLiquidityClass)}>
                                    <SelectTrigger id="acct-liquidity"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {LIQUIDITY.map((l) => (
                                            <SelectItem key={l} value={l}>{t(`accounts.liquidity.${l}`)}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <p className="text-xs text-muted-foreground">{t('accounts.field.liquidityHint')}</p>
                            </div>
                        </div>
                        {/* tax_wrapper / has_cash_sleeve / multi_currency_cash inputs removed
                            (§3 F7): nothing consumes them, so the dialog stops asking. The
                            payload still carries their type-driven defaults untouched. */}
                        <div className="divide-y divide-border/40">
                            {switchRow("spendable", t('accounts.field.spendable'), t('accounts.field.spendableHint'))}
                            {switchRow("in_net_worth", t('accounts.field.inNetWorth'))}
                        </div>
                        {/* Statement reading — EDIT ONLY (§3 F1). On create these
                            two raw fields only minted instant drift against an
                            empty ledger; a new account records its starting
                            figure through the opening-balance field above, and a
                            later statement through the Reconcile dialog. */}
                        {isEditMode && (
                            <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2">
                                <div className="space-y-2">
                                    <Label htmlFor="acct-stmt-bal">{t('accounts.field.statementBalance')}</Label>
                                    <Input id="acct-stmt-bal" type="text" inputMode="decimal" pattern="^-?[0-9]+([.,][0-9]+)?$" value={form.statementBalance} onChange={(e) => set("statementBalance", e.target.value)} />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="acct-stmt-date">{t('accounts.field.statementBalanceDate')}</Label>
                                    <Input id="acct-stmt-date" type="date" required={!!form.statementBalance} value={form.statementBalanceDate} onChange={(e) => set("statementBalanceDate", e.target.value)} />
                                </div>
                            </div>
                        )}
                    </div>
                )}

                <DialogFooter className="pt-2">
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                        {t('common.cancel')}
                    </Button>
                    <Button type="submit" disabled={isPending || !form.name.trim()}>
                        {isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                        {isEditMode ? t('common.save') : t('common.create')}
                    </Button>
                </DialogFooter>
            </form>
        </DialogContent>
    );

    if (isEditMode) {
        return <Dialog open={open} onOpenChange={onOpenChange}>{dialogContent}</Dialog>;
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5">
                    <Plus className="h-4 w-4" /> {t('accounts.addTitle')}
                </Button>
            </DialogTrigger>
            {dialogContent}
        </Dialog>
    );
}
