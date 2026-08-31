import { useState } from "react";
import { parseDecimal } from "@/lib/decimal";
import { deriveUnitMath, parsePositive } from "@/lib/portfolioUnitMath";
import { useLanguage } from "@/contexts/LanguageContext";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Plus, Loader2 } from "lucide-react";
import { isUnitBased } from "@/utils/assetClass";
import { usePortfolio } from "@/hooks/usePortfolio";
import type {
    PortfolioTxnType,
    RecurrenceInterval,
    InvestmentSummary,
} from "@/types/portfolio";
import { getTxnTypeLabel } from "@/types/portfolio";
import { toast } from "sonner";
import { formatDateWithAppSettings } from "@/lib/dateUtils";
import { todayYmd } from "@/lib/timezone";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { PortfolioTxnFormFields } from "./PortfolioTxnFormFields";
import { SUPPORTED_CURRENCIES } from "@/utils/currency";
import {
    useDialogFormState,
    useReseedOnIdentityChange,
} from "@/hooks/useDialogFormState";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";

interface Quote {
    symbol: string;
    name: string;
    price: number;
    change: number;
    changePercent: number;
    currency: string;
    exchange: string;
    type: string;
}

interface Props {
    quote: Quote;
    existingInvestment?: InvestmentSummary;
}

export function AddInvestmentFromMarketDialog({
    quote,
    existingInvestment,
}: Props) {
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState<"choose" | "new" | "transaction">(
        "choose",
    );
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const {
        addInvestment,
        addTransaction,
        isAddingInvestment,
        isAddingTransaction,
    } = usePortfolio();

    const today = todayYmd();
    const todayLabel = formatDateWithAppSettings(
        new Date(),
        appSettings.dateFormat,
    );

    // Determine asset class from quote type
    const getAssetClass = (type: string) => {
        if (type.toLowerCase().includes("etf")) return "etf";
        if (["stock", "equity"].some((t) => type.toLowerCase().includes(t)))
            return "stock";
        if (type.toLowerCase().includes("crypto")) return "crypto";
        return "stock"; // default
    };

    const assetClass = getAssetClass(quote.type);
    const unitBased = isUnitBased(assetClass);

    const makeNewInvestmentForm = () => ({
        name: quote.name,
        symbol: quote.symbol,
        currency: quote.currency ?? "EUR",
        currentPrice: quote.price.toString(),
        notes: t("addInvFromMarket.notesDefault", { date: todayLabel }),
    });

    const makeTransactionForm = () => ({
        type: "buy" as PortfolioTxnType,
        date: today,
        amount: "",
        units: "",
        pricePerUnit: quote.price.toString(),
        fees: "",
        taxes: "",
        fxRateToEur: "",
        note: "",
        isRecurring: false,
        recurrenceInterval: "monthly" as RecurrenceInterval,
        recurrenceEndDate: "",
    });

    // Typed input survives a dismissal (overlay click / Escape / ✕) — see
    // useDialogFormState. Both step forms share one dirty verdict so a half-typed
    // transaction is not wiped by a re-seed aimed at the other step.
    const {
        form: newInvestmentForm,
        setForm: setNewInvestmentForm,
        reset: resetNewInvestmentForm,
        dirty: newInvestmentDirty,
    } = useDialogFormState(makeNewInvestmentForm);
    const {
        form: transactionForm,
        setForm: setTransactionForm,
        reset: resetTransactionForm,
        dirty: transactionDirty,
    } = useDialogFormState(makeTransactionForm);

    const dirty = newInvestmentDirty || transactionDirty;
    useUnsavedChanges(dirty);

    const reset = () => {
        setStep("choose");
        resetNewInvestmentForm();
        resetTransactionForm();
    };

    // Both forms are seeded from the quote (name, symbol, price), so looking up a
    // different symbol on the page behind the dialog must re-seed them — keeping
    // input across a dismissal must never mean submitting AAPL's price as MSFT's.
    useReseedOnIdentityChange(quote.symbol, reset);

    const handleOpenChange = (v: boolean) => {
        if (v && !dirty) reset();
        setOpen(v);
    };

    const handleCreateInvestment = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newInvestmentForm.name.trim()) return;

        try {
            await addInvestment({
                name: newInvestmentForm.name.trim(),
                symbol: newInvestmentForm.symbol.trim(),
                asset_class: assetClass,
                currency: newInvestmentForm.currency,
                // Cleared/invalid price → omit rather than persisting a bogus 0.
                current_price: parsePositive(newInvestmentForm.currentPrice),
                notes: newInvestmentForm.notes.trim() || undefined,
                price_provider: "yahoo",
                price_provider_id: quote.symbol,
            });
            toast.success(
                t("addInv.toast.added", { assetClass, name: quote.symbol }),
            );
            reset();
            setOpen(false);
        } catch {
            // error handled by hook
        }
    };

    const amountInput = parsePositive(transactionForm.amount);
    const unitsInput = parsePositive(transactionForm.units);
    const priceInput = parsePositive(transactionForm.pricePerUnit);
    const isBuySell = ["buy", "sell"].includes(transactionForm.type);
    // Backend requires a consistent 2-of-3 (amount / units / price) only for
    // unit-based buy/sell; other types just need an amount.
    const deriveUnits = isBuySell && unitBased;

    const unitMath = deriveUnitMath({
        amount: amountInput,
        units: unitsInput,
        price: priceInput,
        derive: deriveUnits,
    });
    const { derivedAmount } = unitMath;

    const buySellIsValid = !deriveUnits || unitMath.isConsistent;

    const handleAddTransaction = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!existingInvestment) return;

        // The DatePicker can clear the date to '' — the backend 400s on it.
        if (!transactionForm.date) {
            toast.error(t("addPortTxn.error.dateRequired"));
            return;
        }

        let amount = amountInput;
        let units = unitsInput;
        let pricePerUnit = priceInput;
        if (deriveUnits) {
            // Validate the 2-of-3 here instead of surfacing a raw 400.
            if (
                !unitMath.isConsistent ||
                unitMath.effectiveAmount === undefined
            ) {
                toast.error(t("addPortTxn.error.twoOfThreeRequired"));
                return;
            }
            amount = unitMath.effectiveAmount;
            units = unitMath.effectiveUnits;
            pricePerUnit = unitMath.effectivePrice;
        } else if (amount === undefined) {
            toast.error(t("addPortTxn.error.amountRequired"));
            return;
        }

        // NaN fallback, not the default 0 — garbage in these fields must block the
        // submit instead of silently posting €0 fees/taxes or fx_rate_to_eur = 0.
        const feesValue = transactionForm.fees
            ? parseDecimal(transactionForm.fees, NaN)
            : undefined;
        const taxesValue = transactionForm.taxes
            ? parseDecimal(transactionForm.taxes, NaN)
            : undefined;
        const fxRateValue = transactionForm.fxRateToEur
            ? parseDecimal(transactionForm.fxRateToEur, NaN)
            : undefined;
        if (
            (feesValue !== undefined &&
                (!Number.isFinite(feesValue) || feesValue < 0)) ||
            (taxesValue !== undefined &&
                (!Number.isFinite(taxesValue) || taxesValue < 0)) ||
            (fxRateValue !== undefined &&
                (!Number.isFinite(fxRateValue) || fxRateValue <= 0))
        ) {
            toast.error(t("addPortTxn.error.invalidNumber"));
            return;
        }

        try {
            await addTransaction({
                investmentId: existingInvestment.id,
                type: transactionForm.type,
                date: transactionForm.date,
                amount,
                units,
                price_per_unit: pricePerUnit,
                fees: feesValue,
                taxes: taxesValue,
                fx_rate_to_eur: fxRateValue,
                currency: existingInvestment.currency,
                note: transactionForm.note.trim() || undefined,
                is_recurring: transactionForm.isRecurring,
                recurrence_interval: transactionForm.isRecurring
                    ? transactionForm.recurrenceInterval
                    : undefined,
                recurrence_end_date:
                    transactionForm.isRecurring &&
                    transactionForm.recurrenceEndDate
                        ? transactionForm.recurrenceEndDate
                        : undefined,
            });
            toast.success(
                t("addPortTxn.toast.recorded", {
                    type: getTxnTypeLabel(t, transactionForm.type),
                    name: quote.symbol,
                }),
            );
            reset();
            setOpen(false);
        } catch {
            // error handled by hook
        }
    };

    const allowedTypes: PortfolioTxnType[] = unitBased
        ? ["buy", "sell", "dividend", "fee", "tax"]
        : ["buy", "sell", "fee", "tax"];

    const showUnits =
        unitBased && ["buy", "sell"].includes(transactionForm.type);
    const showFeesTaxes = ["buy", "sell", "dividend"].includes(
        transactionForm.type,
    );
    const showRecurring = ["buy", "sell", "dividend"].includes(
        transactionForm.type,
    );

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5">
                    <Plus className="h-4 w-4" />
                    {t(
                        existingInvestment
                            ? "form.addTransaction.title"
                            : "portfolio.addInvestment",
                    )}
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>
                        {step === "choose"
                            ? t("addInvFromMarket.title.add", {
                                  symbol: quote.symbol,
                              })
                            : step === "new"
                              ? t("addInvFromMarket.title.create")
                              : t("addInvFromMarket.title.transaction")}
                    </DialogTitle>
                    <DialogDescription className="sr-only">
                        {t("addInvFromMarket.title.add", {
                            symbol: quote.symbol,
                        })}
                    </DialogDescription>
                </DialogHeader>

                {step === "choose" && (
                    <div className="space-y-4">
                        <div className="text-sm text-muted-foreground">
                            {t("addInvFromMarket.prompt", {
                                symbol: quote.symbol,
                            })}
                        </div>
                        <div className="space-y-2">
                            {existingInvestment && (
                                <Button
                                    variant="outline"
                                    className="w-full justify-start h-auto p-4"
                                    onClick={() => setStep("transaction")}
                                >
                                    <div className="text-left">
                                        <div className="font-medium">
                                            {t("form.addTransaction.title")}
                                        </div>
                                        <div className="text-sm text-muted-foreground">
                                            {t(
                                                "addInvFromMarket.option.addTxnDesc",
                                            )}
                                        </div>
                                    </div>
                                </Button>
                            )}
                            <Button
                                variant="outline"
                                className="w-full justify-start h-auto p-4"
                                onClick={() => setStep("new")}
                            >
                                <div className="text-left">
                                    <div className="font-medium">
                                        {t("addInvFromMarket.option.createNew")}
                                    </div>
                                    <div className="text-sm text-muted-foreground">
                                        {existingInvestment
                                            ? t(
                                                  "addInvFromMarket.option.createDescExisting",
                                              )
                                            : t(
                                                  "addInvFromMarket.option.createDescNew",
                                              )}
                                    </div>
                                </div>
                            </Button>
                        </div>
                    </div>
                )}

                {step === "new" && (
                    <form
                        onSubmit={handleCreateInvestment}
                        className="space-y-4"
                    >
                        <div className="space-y-3">
                            <div className="space-y-2">
                                <Label htmlFor="new-name">
                                    {t("addInv.label.name")}
                                </Label>
                                <Input
                                    id="new-name"
                                    value={newInvestmentForm.name}
                                    onChange={(e) =>
                                        setNewInvestmentForm((f) => ({
                                            ...f,
                                            name: e.target.value,
                                        }))
                                    }
                                    maxLength={100}
                                    required
                                />
                            </div>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div className="space-y-2">
                                    <Label htmlFor="new-symbol">
                                        {t("addInv.label.ticker")}
                                    </Label>
                                    <Input
                                        id="new-symbol"
                                        value={newInvestmentForm.symbol}
                                        onChange={(e) =>
                                            setNewInvestmentForm((f) => ({
                                                ...f,
                                                symbol: e.target.value.toUpperCase(),
                                            }))
                                        }
                                        maxLength={20}
                                        className="font-mono"
                                        readOnly
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="new-currency">
                                        {t("addInv.label.currency")}
                                    </Label>
                                    <Select
                                        value={newInvestmentForm.currency}
                                        onValueChange={(v) =>
                                            setNewInvestmentForm((f) => ({
                                                ...f,
                                                currency: v,
                                            }))
                                        }
                                    >
                                        <SelectTrigger id="new-currency">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {SUPPORTED_CURRENCIES.slice(
                                                0,
                                                4,
                                            ).map((c) => (
                                                <SelectItem key={c} value={c}>
                                                    {c}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="new-price">
                                    {t("addInv.label.currentPrice")}
                                </Label>
                                <Input
                                    id="new-price"
                                    type="number"
                                    step="0.0001"
                                    min="0"
                                    value={newInvestmentForm.currentPrice}
                                    onChange={(e) =>
                                        setNewInvestmentForm((f) => ({
                                            ...f,
                                            currentPrice: e.target.value,
                                        }))
                                    }
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="new-notes">
                                    {t("addInv.label.notes")}
                                </Label>
                                <Textarea
                                    id="new-notes"
                                    rows={2}
                                    value={newInvestmentForm.notes}
                                    onChange={(e) =>
                                        setNewInvestmentForm((f) => ({
                                            ...f,
                                            notes: e.target.value,
                                        }))
                                    }
                                    maxLength={500}
                                />
                            </div>
                        </div>
                        <DialogFooter className="sm:justify-between">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setStep("choose")}
                            >
                                {t("addInv.back")}
                            </Button>
                            <Button type="submit" disabled={isAddingInvestment}>
                                {isAddingInvestment && (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                )}
                                {t("addInv.create")}
                            </Button>
                        </DialogFooter>
                    </form>
                )}

                {step === "transaction" && existingInvestment && (
                    <form onSubmit={handleAddTransaction} className="space-y-4">
                        <PortfolioTxnFormFields
                            idPrefix="market-txn"
                            form={transactionForm}
                            setForm={setTransactionForm}
                            currency={existingInvestment.currency}
                            t={t}
                            typeField={
                                <div className="space-y-2">
                                    <Label htmlFor="market-txn-type">
                                        {t("addPortTxn.type")}
                                    </Label>
                                    <Select
                                        value={transactionForm.type}
                                        onValueChange={(v) =>
                                            setTransactionForm((f) => ({
                                                ...f,
                                                type: v as PortfolioTxnType,
                                            }))
                                        }
                                    >
                                        <SelectTrigger id="market-txn-type">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {allowedTypes.map((txnType) => (
                                                <SelectItem
                                                    key={txnType}
                                                    value={txnType}
                                                >
                                                    {getTxnTypeLabel(
                                                        t,
                                                        txnType,
                                                    )}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            }
                            showUnits={showUnits}
                            showFeesTaxes={showFeesTaxes}
                            showRecurring={showRecurring}
                            derivedAmount={derivedAmount}
                            isBuySell={deriveUnits}
                            buySellIsValid={buySellIsValid}
                            isGift={false}
                            lockAmountWhenGift={false}
                            withPlaceholders
                        />

                        <DialogFooter className="sm:justify-between">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setStep("choose")}
                            >
                                {t("addInv.back")}
                            </Button>
                            <Button
                                type="submit"
                                disabled={isAddingTransaction}
                            >
                                {isAddingTransaction && (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                )}
                                {t("addPortTxn.record")}
                            </Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
