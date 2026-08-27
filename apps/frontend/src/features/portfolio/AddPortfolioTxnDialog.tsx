import { deriveUnitMath, parsePositive } from "@/lib/portfolioUnitMath";
import {
    addPortfolioTxnSchema,
    invalidOptionalFxRate,
    invalidOptionalMoney,
} from "./portfolioTxnSchema";
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
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Plus, Loader2 } from "lucide-react";
import { isUnitBased, isFixedIncome, isRealEstate } from "@/utils/assetClass";
import { usePortfolio } from "@/hooks/usePortfolio";
import type {
    PortfolioTxnType,
    RecurrenceInterval,
    InvestmentSummary,
} from "@/types/portfolio";
import { getTxnTypeLabel } from "@/types/portfolio";
import { toast } from "sonner";
import { toYmd } from "@/components/shared/dateUtils";
import {
    useDialogFormState,
    useReseedOnIdentityChange,
    useControlledOpen,
    returnFocusOnClose,
    type ControlledDialogProps,
} from "@/hooks/useDialogFormState";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";
import { useFieldErrors, type FieldErrorMap } from "@/hooks/useFieldErrors";
import { PortfolioTxnFormFields } from "./PortfolioTxnFormFields";

/** Visual order — decides which field gets focus on a blocked submit. */
const FIELD_ORDER = [
    "txn-units",
    "txn-amount",
    "txn-fees",
    "txn-taxes",
    "txn-fx-rate-to-eur",
] as const;

interface Props extends ControlledDialogProps {
    investment: InvestmentSummary;
    trigger?: React.ReactNode;
}

export function AddPortfolioTxnDialog({
    investment,
    trigger,
    open: openProp,
    onOpenChange,
    returnFocusRef,
}: Props) {
    const { open, setOpen, controlled } = useControlledOpen({
        open: openProp,
        onOpenChange,
    });
    const { t } = useLanguage();
    const { addTransaction, isAddingTransaction } = usePortfolio();

    const unitBased = isUnitBased(investment.assetClass);
    const realEstate = isRealEstate(investment.assetClass);
    const fixedIncome = isFixedIncome(investment.assetClass);

    // Filter relevant transaction types per asset class
    const allowedTypes: PortfolioTxnType[] = (() => {
        if (unitBased) return ["buy", "sell", "gift", "dividend", "fee", "tax"];
        if (realEstate)
            return ["buy", "sell", "rent_income", "appreciation", "fee", "tax"];
        if (fixedIncome) return ["buy", "sell", "interest", "fee", "tax"];
        return ["buy", "sell", "fee", "tax"];
    })();

    const initialForm = () => ({
        type: "buy" as PortfolioTxnType,
        date: toYmd(new Date()),
        amount: "",
        units: "",
        pricePerUnit: "",
        fees: "",
        taxes: "",
        fxRateToEur: "",
        note: "",
        isRecurring: false,
        recurrenceInterval: "monthly" as RecurrenceInterval,
        recurrenceEndDate: "",
    });

    // Typed input survives a dismissal (overlay click / Escape / ✕) — see
    // useDialogFormState. Reopening a pristine form re-seeds it so the default
    // date is still today; a dirty one is left exactly as the user left it.
    const { form, setForm, reset, dirty } = useDialogFormState(initialForm);
    useUnsavedChanges(dirty);

    const isBuySell = ["buy", "sell"].includes(form.type);
    const isGift = form.type === "gift";

    // Render-time unit math only feeds the live UI (the derived-amount hint, the
    // inline two-of-three message and the inline field errors); the submit gate
    // below re-runs the same helper inside the Zod schema, so the two can never
    // disagree.
    const unitMath = deriveUnitMath({
        amount: parsePositive(form.amount),
        units: parsePositive(form.units),
        price: parsePositive(form.pricePerUnit),
        derive: isBuySell,
    });
    const { derivedAmount } = unitMath;
    const buySellIsValid = !isBuySell || unitMath.isConsistent;

    const showUnits = unitBased && ["buy", "sell", "gift"].includes(form.type);

    // The same rules addPortfolioTxnSchema enforces on submit, re-expressed per
    // field: recomputed every render but only *shown* once a submit has been
    // blocked (see useFieldErrors), so a corrected field clears itself. These
    // used to surface as one detached toast for the first failing rule — the
    // toast is gone because the message now lives on the field itself, where a
    // screen reader is taken to it. Server errors still toast, in the hook.
    const twoOfThreeError =
        isBuySell && !unitMath.isConsistent
            ? t("addPortTxn.error.twoOfThreeRequired")
            : undefined;
    const fieldErrors: FieldErrorMap = {
        "txn-units":
            isGift && unitMath.effectiveUnits === undefined
                ? t("addPortTxn.error.unitsRequired")
                : showUnits
                  ? twoOfThreeError
                  : undefined,
        "txn-amount":
            !showUnits && twoOfThreeError
                ? twoOfThreeError
                : !isGift &&
                    (unitMath.effectiveAmount === undefined ||
                        Number.isNaN(unitMath.effectiveAmount))
                  ? t("addPortTxn.error.amountRequired")
                  : undefined,
        "txn-fees": invalidOptionalMoney(form.fees)
            ? t("addPortTxn.error.invalidNumber")
            : undefined,
        "txn-taxes": invalidOptionalMoney(form.taxes)
            ? t("addPortTxn.error.invalidNumber")
            : undefined,
        "txn-fx-rate-to-eur": invalidOptionalFxRate(form.fxRateToEur)
            ? t("addPortTxn.error.invalidNumber")
            : undefined,
    };
    const { visibleErrors, checkValid, resetErrors } = useFieldErrors(
        fieldErrors,
        FIELD_ORDER,
    );

    const resetForm = () => {
        reset();
        resetErrors();
    };
    useReseedOnIdentityChange(investment.id, resetForm);

    const handleOpenChange = (v: boolean) => {
        if (v && !dirty) resetForm();
        setOpen(v);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!checkValid()) return;
        // Narrowing only — checkValid() mirrors the schema's rules field-by-field,
        // so a blocked submit never reaches this parse.
        const parsed = addPortfolioTxnSchema({ isBuySell, isGift }).safeParse(
            form,
        );
        if (!parsed.success) return;

        try {
            await addTransaction({
                investmentId: investment.id,
                type: form.type,
                date: parsed.data.date,
                amount: parsed.data.amount,
                units: parsed.data.units,
                price_per_unit: parsed.data.pricePerUnit,
                fees: parsed.data.fees,
                taxes: parsed.data.taxes,
                fx_rate_to_eur: parsed.data.fxRateToEur,
                currency: investment.currency,
                note: form.note.trim() || undefined,
                is_recurring: form.isRecurring,
                recurrence_interval: form.isRecurring
                    ? form.recurrenceInterval
                    : undefined,
                recurrence_end_date:
                    form.isRecurring && form.recurrenceEndDate
                        ? form.recurrenceEndDate
                        : undefined,
            });
            toast.success(
                t("addPortTxn.toast.recorded", {
                    type: getTxnTypeLabel(t, form.type),
                    name: investment.name,
                }),
            );
            resetForm();
            setOpen(false);
        } catch {
            // error handled by hook
        }
    };

    const showFeesTaxes = ["buy", "sell", "dividend"].includes(form.type);
    const showRecurring = [
        "buy",
        "sell",
        "dividend",
        "interest",
        "rent_income",
    ].includes(form.type);

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            {!controlled && (
                <DialogTrigger asChild>
                    {trigger ?? (
                        <Button size="sm" variant="outline" className="gap-1.5">
                            <Plus className="h-4 w-4" />{" "}
                            {t("form.addTransaction.title")}
                        </Button>
                    )}
                </DialogTrigger>
            )}
            <DialogContent
                className="sm:max-w-md"
                onCloseAutoFocus={returnFocusOnClose(returnFocusRef)}
            >
                <DialogHeader>
                    <DialogTitle>
                        {t("addPortTxn.title", {
                            symbol: investment.symbol || investment.name,
                        })}
                    </DialogTitle>
                    <DialogDescription className="sr-only">
                        {t("addPortTxn.title", {
                            symbol: investment.symbol || investment.name,
                        })}
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <PortfolioTxnFormFields
                        idPrefix="txn"
                        form={form}
                        setForm={setForm}
                        currency={investment.currency}
                        t={t}
                        typeField={
                            <div className="space-y-2">
                                <Label htmlFor="txn-type">
                                    {t("addPortTxn.type")}
                                </Label>
                                <Select
                                    value={form.type}
                                    onValueChange={(v) =>
                                        setForm((f) => ({
                                            ...f,
                                            type: v as PortfolioTxnType,
                                        }))
                                    }
                                >
                                    <SelectTrigger id="txn-type">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {allowedTypes.map((txnType) => (
                                            <SelectItem
                                                key={txnType}
                                                value={txnType}
                                            >
                                                {getTxnTypeLabel(t, txnType)}
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
                        isBuySell={isBuySell}
                        buySellIsValid={buySellIsValid}
                        isGift={isGift}
                        lockAmountWhenGift
                        withPlaceholders
                        errors={visibleErrors}
                    />

                    <DialogFooter className="pt-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                                resetForm();
                                setOpen(false);
                            }}
                        >
                            {t("addPortTxn.cancel")}
                        </Button>
                        <Button type="submit" disabled={isAddingTransaction}>
                            {isAddingTransaction && (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            )}
                            {t("addPortTxn.record")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
