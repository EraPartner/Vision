import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { useCreateAccount } from "@/hooks/useAccounts";
import { useLanguage } from "@/contexts/LanguageContext";
import type { AccountType, AccountOwner, AccountLiquidityClass, AccountTaxWrapper } from "@/types/api";

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
const TAX_WRAPPERS: AccountTaxWrapper[] = ["none", "pension", "tax_advantaged"];
const CURRENCIES = [
    "EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK",
    "PLN", "CZK", "HUF", "RON", "BGN", "HRK", "TRY", "SAR", "AED", "INR",
    "BRL", "MXN", "ZAR", "SGD", "HKD", "NZD", "KRW", "THB", "MYR", "PHP",
];

// Flag fields that flagsForType pre-fills. Once the user edits one of these
// directly, a later type change must not clobber their choice — ADR-089
// defaults are only suggestions for fields the user hasn't touched.
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

    // Flag fields the user has edited by hand this session; a type change leaves
    // these alone and only applies flagsForType defaults to untouched fields.
    const [touchedFlags, setTouchedFlags] = useState<Set<FlagKey>>(new Set());

    const set = <K extends keyof AccountFormValues>(key: K, value: AccountFormValues[K]) => {
        if ((FLAG_KEYS as readonly string[]).includes(key as string)) {
            setTouchedFlags(prev => new Set(prev).add(key as FlagKey));
        }
        setForm(f => ({ ...f, [key]: value }));
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
        if (!form.name.trim()) return;
        // A statement balance is only meaningful with its as-of date (ADR-094);
        // the date input is marked required, this guards non-native submits.
        if (form.statementBalance && !form.statementBalanceDate) return;

        const values: AccountFormValues = {
            ...form,
            name: form.name.trim(),
            display_name: form.display_name.trim(),
            institution: form.institution.trim(),
            currency: form.currency.trim().toUpperCase() || "EUR",
        };

        if (isEditMode) {
            editProps?.onSave(values);
        } else {
            createMutation.mutate(
                {
                    name: values.name,
                    display_name: values.display_name || undefined,
                    institution: values.institution || undefined,
                    currency: values.currency,
                    type: values.type,
                    owner: values.owner,
                    liquidity_class: values.liquidity_class,
                    tax_wrapper: values.tax_wrapper,
                    spendable: values.spendable,
                    in_net_worth: values.in_net_worth,
                    multi_currency_cash: values.multi_currency_cash,
                    has_cash_sleeve: values.has_cash_sleeve,
                    statement_balance: values.statementBalance ? Number(values.statementBalance) : undefined,
                    statement_balance_date: values.statementBalanceDate || undefined,
                },
                {
                    onSuccess: () => {
                        setForm(EMPTY);
                        setTouchedFlags(new Set());
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

    const switchRow = (key: keyof AccountFormValues, label: string) => (
        <div className="flex items-center justify-between py-1.5">
            <Label htmlFor={`acct-${key}`} className="font-normal">{label}</Label>
            <Switch
                id={`acct-${key}`}
                checked={form[key] as boolean}
                onCheckedChange={(v) => set(key, v as AccountFormValues[typeof key])}
            />
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
                        onChange={(e) => set("name", e.target.value)}
                        required
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="acct-display">{t('accounts.field.displayName')}</Label>
                    <Input
                        id="acct-display"
                        placeholder={t('accounts.field.displayNamePlaceholder')}
                        maxLength={200}
                        value={form.display_name}
                        onChange={(e) => set("display_name", e.target.value)}
                    />
                </div>
                <div className="grid grid-cols-2 gap-3">
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
                        <div className="grid grid-cols-2 gap-3">
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
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="acct-tax">{t('accounts.field.taxWrapper')}</Label>
                            <Select value={form.tax_wrapper} onValueChange={(v) => set("tax_wrapper", v as AccountTaxWrapper)}>
                                <SelectTrigger id="acct-tax"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {TAX_WRAPPERS.map((w) => (
                                        <SelectItem key={w} value={w}>{t(`accounts.taxWrapper.${w}`)}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="divide-y divide-border/40">
                            {switchRow("spendable", t('accounts.field.spendable'))}
                            {switchRow("in_net_worth", t('accounts.field.inNetWorth'))}
                            {switchRow("has_cash_sleeve", t('accounts.field.hasCashSleeve'))}
                            {switchRow("multi_currency_cash", t('accounts.field.multiCurrencyCash'))}
                        </div>
                        <div className="grid grid-cols-2 gap-3 pt-1">
                            <div className="space-y-2">
                                <Label htmlFor="acct-stmt-bal">{t('accounts.field.statementBalance')}</Label>
                                <Input id="acct-stmt-bal" type="number" step="0.01" value={form.statementBalance} onChange={(e) => set("statementBalance", e.target.value)} />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="acct-stmt-date">{t('accounts.field.statementBalanceDate')}</Label>
                                <Input id="acct-stmt-date" type="date" required={!!form.statementBalance} value={form.statementBalanceDate} onChange={(e) => set("statementBalanceDate", e.target.value)} />
                            </div>
                        </div>
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
