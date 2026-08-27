import { deriveUnitMath, parsePositive } from "@/lib/portfolioUnitMath";
import {
    editPortfolioTxnSchema,
    invalidOptionalFxRate,
    invalidOptionalMoney,
    parseNonNegative,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toYmd } from "@/components/shared/dateUtils";
import { usePortfolio } from "@/hooks/usePortfolio";
import { isUnitBased } from "@/utils/assetClass";
import { toast } from "sonner";
import type {
    InvestmentSummary,
    PortfolioTxnType,
    RecurrenceInterval,
} from "@/types/portfolio";
import type { PortfolioTransaction } from "@/types/api";
import { getTxnTypeLabel } from "@/types/portfolio";
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
    "edit-txn-date",
    "edit-txn-units",
    "edit-txn-amount",
    "edit-txn-fees",
    "edit-txn-taxes",
    "edit-txn-fx-rate-to-eur",
] as const;

function normalizeYmdInput(value?: string): string {
    if (!value) return "";
    const trimmed = value.trim();
    const datePart = trimmed.includes("T")
        ? trimmed.split("T")[0]
        : trimmed.includes(" ")
          ? trimmed.split(" ")[0]
          : trimmed;

    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
        return datePart;
    }

    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) return "";
    return toYmd(parsed);
}

interface Props extends ControlledDialogProps {
    investment: InvestmentSummary;
    transaction: PortfolioTransaction;
    trigger?: React.ReactNode;
}

export function EditPortfolioTxnDialog({
    investment,
    transaction,
    trigger,
    open: openProp,
    onOpenChange,
    returnFocusRef,
}: Props) {
    const { t } = useLanguage();
    const { updateTransaction, isUpdatingTransaction } = usePortfolio();
    const { open, setOpen, controlled } = useControlledOpen({
        open: openProp,
        onOpenChange,
    });

    const unitBased = isUnitBased(investment.assetClass);

    const initialForm = () => ({
        date: normalizeYmdInput(transaction.date),
        amount: String(transaction.amount ?? ""),
        units: transaction.units !== undefined ? String(transaction.units) : "",
        pricePerUnit:
            transaction.price_per_unit !== undefined
                ? String(transaction.price_per_unit)
                : "",
        fees: transaction.fees !== undefined ? String(transaction.fees) : "",
        taxes: transaction.taxes !== undefined ? String(transaction.taxes) : "",
        fxRateToEur:
            transaction.fx_rate_to_eur !== undefined
                ? String(transaction.fx_rate_to_eur)
                : "",
        note: transaction.note || "",
        accountId:
            transaction.account_id != null
                ? String(transaction.account_id)
                : "",
        isRecurring: Boolean(transaction.is_recurring),
        recurrenceInterval: (transaction.recurrence_interval ||
            "monthly") as RecurrenceInterval,
        recurrenceEndDate: normalizeYmdInput(transaction.recurrence_end_date),
    });

    // Edits survive a dismissal (overlay click / Escape / ✕) — see
    // useDialogFormState. The prefill still has to be right, so the form re-seeds
    // when this instance is pointed at a different transaction, and whenever a
    // pristine dialog is reopened (picking up the values a save just persisted).
    const { form, setForm, reset, dirty } = useDialogFormState(initialForm);
    useUnsavedChanges(dirty);

    const isBuySell = transaction.type === "buy" || transaction.type === "sell";
    const isGift = transaction.type === "gift";

    // Render-time unit math only feeds the live UI (the derived-amount hint, the
    // inline two-of-three message and the inline field errors); the submit gate
    // below re-runs the same helper inside the Zod schema, so the two can never
    // disagree.
    const unitMath = deriveUnitMath({
        amount: parseNonNegative(form.amount),
        units: parsePositive(form.units),
        price: parsePositive(form.pricePerUnit),
        derive: isBuySell || isGift,
    });
    const { derivedAmount } = unitMath;
    const buySellIsValid = !isBuySell || unitMath.isConsistent;

    const showUnits =
        unitBased && ["buy", "sell", "gift"].includes(transaction.type);
    const showFeesTaxes = ["buy", "sell", "dividend"].includes(
        transaction.type,
    );
    const showRecurring = [
        "buy",
        "sell",
        "dividend",
        "interest",
        "rent_income",
    ].includes(transaction.type);

    // The same rules editPortfolioTxnSchema enforces on submit, re-expressed per
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
        "edit-txn-date": !form.date
            ? t("plannedPage.link.pickDate")
            : undefined,
        "edit-txn-units":
            isGift && unitMath.effectiveUnits === undefined
                ? t("addPortTxn.error.unitsRequired")
                : showUnits
                  ? twoOfThreeError
                  : undefined,
        "edit-txn-amount":
            !showUnits && twoOfThreeError
                ? twoOfThreeError
                : !isGift &&
                    (unitMath.effectiveAmount === undefined ||
                        Number.isNaN(unitMath.effectiveAmount) ||
                        unitMath.effectiveAmount <= 0)
                  ? t("addPortTxn.error.amountRequired")
                  : undefined,
        "edit-txn-fees": invalidOptionalMoney(form.fees)
            ? t("addPortTxn.error.invalidNumber")
            : undefined,
        "edit-txn-taxes": invalidOptionalMoney(form.taxes)
            ? t("addPortTxn.error.invalidNumber")
            : undefined,
        "edit-txn-fx-rate-to-eur": invalidOptionalFxRate(form.fxRateToEur)
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
    useReseedOnIdentityChange(transaction.id, resetForm);

    const handleOpenChange = (v: boolean) => {
        if (v && !dirty) resetForm();
        setOpen(v);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!checkValid()) return;
        // Narrowing only — checkValid() mirrors the schema's rules field-by-field,
        // so a blocked submit never reaches this parse.
        const parsed = editPortfolioTxnSchema({ isBuySell, isGift }).safeParse(
            form,
        );
        if (!parsed.success) return;

        try {
            // account_id: a number reassigns the lot, explicit null clears it back to
            // unassigned (the PATCH endpoint maps null → SQL NULL, undefined → unchanged).
            await updateTransaction(transaction.id, {
                date: parsed.data.date,
                amount: parsed.data.amount,
                units: parsed.data.units,
                price_per_unit: parsed.data.pricePerUnit,
                // Cleared fields must be SENT, not dropped: undefined keys vanish from
                // the JSON body and the backend merge keeps the old value — "delete the
                // €7.50 fee → Save → success" left the fee in the DB (and the FX/note
                // likewise). Cleared money fields are 0; cleared note/FX are explicit
                // null, same semantics as account_id below.
                fees: parsed.data.fees,
                taxes: parsed.data.taxes,
                fx_rate_to_eur: parsed.data.fxRateToEur,
                note: form.note.trim() || null,
                account_id: form.accountId ? Number(form.accountId) : null,
                is_recurring: form.isRecurring,
                recurrence_interval: form.isRecurring
                    ? form.recurrenceInterval
                    : undefined,
                recurrence_end_date: form.isRecurring
                    ? form.recurrenceEndDate || null
                    : null,
            });
            toast.success(
                t("txnEdit.toast.updated", {
                    type: getTxnTypeLabel(
                        t,
                        transaction.type as PortfolioTxnType,
                    ),
                }),
            );
            resetForm();
            setOpen(false);
        } catch {
            // handled in hook
        }
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            {!controlled && (
                <DialogTrigger asChild>
                    {trigger ?? (
                        <Button variant="outline">{t("common.edit")}</Button>
                    )}
                </DialogTrigger>
            )}
            <DialogContent
                className="sm:max-w-md"
                onCloseAutoFocus={returnFocusOnClose(returnFocusRef)}
            >
                <DialogHeader>
                    <DialogTitle>{t("txnEdit.title")}</DialogTitle>
                    <DialogDescription className="sr-only">
                        {t("txnEdit.title")}
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <PortfolioTxnFormFields
                        idPrefix="edit-txn"
                        form={form}
                        setForm={setForm}
                        currency={investment.currency}
                        t={t}
                        typeField={
                            <div className="space-y-2">
                                <Label htmlFor="edit-txn-type">
                                    {t("addPortTxn.type")}
                                </Label>
                                <Input
                                    id="edit-txn-type"
                                    value={getTxnTypeLabel(t, transaction.type)}
                                    disabled
                                />
                            </div>
                        }
                        showUnits={showUnits}
                        showFeesTaxes={showFeesTaxes}
                        showRecurring={showRecurring}
                        derivedAmount={derivedAmount}
                        isBuySell={isBuySell}
                        buySellIsValid={buySellIsValid}
                        isGift={isGift}
                        lockAmountWhenGift={false}
                        withPlaceholders={false}
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
                            {t("common.cancel")}
                        </Button>
                        <Button type="submit" disabled={isUpdatingTransaction}>
                            {isUpdatingTransaction && (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            )}
                            {t("common.save")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
