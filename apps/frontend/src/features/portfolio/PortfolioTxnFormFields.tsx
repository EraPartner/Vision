/**
 * PortfolioTxnFormFields — the shared type/date/units/price/amount/
 * fees/taxes/FX/recurring/note field body for the portfolio Add and Edit
 * transaction dialogs, which were ~90% identical JSX.
 *
 * The `type` control differs between the dialogs (an editable Select on Add, a
 * disabled Input on Edit), so it is supplied by each caller via the `typeField`
 * slot. Everything else is parameterised so the exact per-dialog behaviour is
 * preserved: `idPrefix` keeps the input ids stable, `withPlaceholders` toggles
 * the Add-only placeholders, and `lockAmountWhenGift` reproduces Add's
 * gift-locks-the-amount rule (Edit keeps the amount editable for gifts).
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
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
import { Switch } from "@/components/ui/switch";
import { DatePicker } from "@/components/shared/DatePicker";
import { parseLocalDateFromYmd, toYmd } from "@/lib/dateUtils";
import { FieldError } from "@/components/ui/field-error";
import {
    fieldErrorId,
    fieldErrorProps,
    type FieldErrorMap,
} from "@/hooks/useFieldErrors";
import type { RecurrenceInterval } from "@/types/portfolio";
import type { DividendAmountConvention } from "@/types/api";

type TranslateFn = (
    key: string,
    params?: Record<string, string | number>,
) => string;

/** The transaction fields the shared body reads and writes. */
export interface PortfolioTxnFieldsForm {
    date: string;
    amount: string;
    units: string;
    pricePerUnit: string;
    fees: string;
    taxes: string;
    dividendAmountConvention: DividendAmountConvention;
    fxRateToEur: string;
    note: string;
    isRecurring: boolean;
    recurrenceInterval: RecurrenceInterval;
    recurrenceEndDate: string;
}

/** Localised labels for the recurrence-interval dropdown (shared by both dialogs). */
function buildRecurrenceLabels(
    t: TranslateFn,
): Record<RecurrenceInterval, string> {
    return {
        daily: t("addPortTxn.recurrence.daily"),
        weekly: t("addPortTxn.recurrence.weekly"),
        "bi-weekly": t("addPortTxn.recurrence.biweekly"),
        monthly: t("addPortTxn.recurrence.monthly"),
        quarterly: t("addPortTxn.recurrence.quarterly"),
        yearly: t("addPortTxn.recurrence.yearly"),
    };
}

interface PortfolioTxnFormFieldsProps<F extends PortfolioTxnFieldsForm> {
    /** Prefix for input ids so htmlFor targets stay unique per dialog. */
    idPrefix: string;
    form: F;
    setForm: (updater: (prev: F) => F) => void;
    currency: string;
    t: TranslateFn;
    /** The type control (editable on Add, read-only on Edit). */
    typeField: ReactNode;
    showUnits: boolean;
    showFeesTaxes: boolean;
    showDividendConvention: boolean;
    showRecurring: boolean;
    derivedAmount?: number;
    isBuySell: boolean;
    buySellIsValid: boolean;
    isGift: boolean;
    /** Add locks the amount to 0 for gifts; Edit leaves it editable. */
    lockAmountWhenGift: boolean;
    /** Add renders example placeholders; Edit renders none. */
    withPlaceholders: boolean;
    /**
     * Submit-revealed inline errors, keyed by the controls' DOM ids (so
     * `${idPrefix}-amount` etc.) — the dialog's `useFieldErrors` visibleErrors.
     * The two-of-three message keeps its existing live rendering below; when it
     * is the revealed error, that element doubles as the ARIA error target
     * instead of a duplicate `<FieldError>`.
     */
    errors?: FieldErrorMap;
}

export function PortfolioTxnFormFields<F extends PortfolioTxnFieldsForm>({
    idPrefix,
    form,
    setForm,
    currency,
    t,
    typeField,
    showUnits,
    showFeesTaxes,
    showDividendConvention,
    showRecurring,
    derivedAmount,
    isBuySell,
    buySellIsValid,
    isGift,
    lockAmountWhenGift,
    withPlaceholders,
    errors,
}: PortfolioTxnFormFieldsProps<F>) {
    const recurrenceLabels = buildRecurrenceLabels(t);
    const lockAmount = isGift && lockAmountWhenGift;
    const amountPlaceholder = withPlaceholders
        ? lockAmount
            ? "0.00"
            : derivedAmount !== undefined
              ? derivedAmount.toFixed(4)
              : "0.00"
        : undefined;
    const dateId = `${idPrefix}-date`;
    const unitsId = `${idPrefix}-units`;
    const amountId = `${idPrefix}-amount`;
    const feesId = `${idPrefix}-fees`;
    const taxesId = `${idPrefix}-taxes`;
    const fxId = `${idPrefix}-fx-rate-to-eur`;
    // The live two-of-three message (below) already sits inline; when it is the
    // field's revealed error it becomes the aria-describedby target, and the
    // per-field <FieldError> is suppressed so the message never renders twice.
    const twoOfThreeShown = isBuySell && !buySellIsValid;
    const twoOfThreeTargetId = showUnits ? unitsId : amountId;

    return (
        <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {typeField}
                <div className="space-y-2">
                    <Label htmlFor={dateId}>{t("addPortTxn.date")}</Label>
                    <DatePicker
                        id={dateId}
                        value={
                            form.date
                                ? parseLocalDateFromYmd(form.date)
                                : undefined
                        }
                        onChange={(date) =>
                            setForm((f) => ({
                                ...f,
                                date: date ? toYmd(date) : "",
                            }))
                        }
                        placeholder={t("plannedPage.link.pickDate")}
                        {...fieldErrorProps(dateId, errors?.[dateId])}
                    />
                    <FieldError field={dateId} message={errors?.[dateId]} />
                </div>

                {showUnits && (
                    <>
                        <div className="space-y-2">
                            <Label htmlFor={unitsId}>
                                {t("addPortTxn.units")}
                            </Label>
                            <Input
                                id={unitsId}
                                type="text"
                                inputMode="decimal"
                                pattern="^[0-9]+([.,][0-9]+)?$"
                                placeholder={
                                    withPlaceholders ? "10" : undefined
                                }
                                value={form.units}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        units: e.target.value,
                                    }))
                                }
                                {...fieldErrorProps(unitsId, errors?.[unitsId])}
                            />
                            {/* On buy/sell the only units error is two-of-three, shown live below. */}
                            <FieldError
                                field={unitsId}
                                message={
                                    isBuySell ? undefined : errors?.[unitsId]
                                }
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor={`${idPrefix}-ppu`}>
                                {t("addPortTxn.pricePerUnit")}
                            </Label>
                            <Input
                                id={`${idPrefix}-ppu`}
                                type="text"
                                inputMode="decimal"
                                pattern="^[0-9]+([.,][0-9]+)?$"
                                placeholder={
                                    withPlaceholders ? "98.50" : undefined
                                }
                                value={form.pricePerUnit}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        pricePerUnit: e.target.value,
                                    }))
                                }
                            />
                        </div>
                    </>
                )}

                <div className={cn("space-y-2", showUnits && "sm:col-span-2")}>
                    <Label htmlFor={amountId}>
                        {t("addPortTxn.totalAmount", { currency })}
                        {lockAmount ? (
                            <span className="text-muted-foreground ml-1 text-xs">
                                = 0
                            </span>
                        ) : derivedAmount !== undefined ? (
                            <span className="text-muted-foreground ml-1 text-xs">
                                = {derivedAmount.toFixed(4)}
                            </span>
                        ) : null}
                    </Label>
                    <Input
                        id={amountId}
                        type="text"
                        inputMode="decimal"
                        pattern="^[0-9]+([.,][0-9]+)?$"
                        placeholder={amountPlaceholder}
                        value={lockAmount ? "0" : form.amount}
                        disabled={lockAmount}
                        onChange={(e) =>
                            setForm((f) => ({ ...f, amount: e.target.value }))
                        }
                        {...fieldErrorProps(amountId, errors?.[amountId])}
                    />
                    {/* When the amount slot holds the two-of-three error (units hidden),
              the live message below is the error element — don't render it twice. */}
                    <FieldError
                        field={amountId}
                        message={
                            twoOfThreeShown && !showUnits
                                ? undefined
                                : errors?.[amountId]
                        }
                    />
                </div>

                {twoOfThreeShown && (
                    <div
                        id={fieldErrorId(twoOfThreeTargetId)}
                        className="text-xs text-destructive sm:col-span-2"
                    >
                        {t("addPortTxn.error.twoOfThreeRequired")}
                    </div>
                )}

                {showFeesTaxes && (
                    <>
                        <div className="space-y-2">
                            <Label htmlFor={feesId}>
                                {t("addPortTxn.fees")}
                            </Label>
                            <Input
                                id={feesId}
                                type="text"
                                inputMode="decimal"
                                pattern="^[0-9]+([.,][0-9]+)?$"
                                placeholder={
                                    withPlaceholders ? "0.00" : undefined
                                }
                                value={form.fees}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        fees: e.target.value,
                                    }))
                                }
                                {...fieldErrorProps(feesId, errors?.[feesId])}
                            />
                            <FieldError
                                field={feesId}
                                message={errors?.[feesId]}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor={taxesId}>
                                {t("addPortTxn.taxes")}
                            </Label>
                            <Input
                                id={taxesId}
                                type="text"
                                inputMode="decimal"
                                pattern="^[0-9]+([.,][0-9]+)?$"
                                placeholder={
                                    withPlaceholders ? "0.00" : undefined
                                }
                                value={form.taxes}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        taxes: e.target.value,
                                    }))
                                }
                                {...fieldErrorProps(taxesId, errors?.[taxesId])}
                            />
                            <FieldError
                                field={taxesId}
                                message={errors?.[taxesId]}
                            />
                        </div>
                    </>
                )}

                {showDividendConvention && (
                    <div className="space-y-2 sm:col-span-2">
                        <Label htmlFor={`${idPrefix}-dividend-convention`}>
                            {t("addPortTxn.dividendAmountConvention")}
                        </Label>
                        <Select
                            value={form.dividendAmountConvention}
                            onValueChange={(value) =>
                                setForm((f) => ({
                                    ...f,
                                    dividendAmountConvention:
                                        value as DividendAmountConvention,
                                }))
                            }
                        >
                            <SelectTrigger
                                id={`${idPrefix}-dividend-convention`}
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="gross">
                                    {t("addPortTxn.dividendConvention.gross")}
                                </SelectItem>
                                <SelectItem value="net">
                                    {t("addPortTxn.dividendConvention.net")}
                                </SelectItem>
                                <SelectItem value="unknown">
                                    {t("addPortTxn.dividendConvention.unknown")}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                            {t("addPortTxn.dividendConvention.help")}
                        </p>
                    </div>
                )}

                <div
                    className={cn(
                        "space-y-2",
                        showFeesTaxes && "sm:col-span-2",
                    )}
                >
                    <Label htmlFor={fxId}>{t("addPortTxn.fxRate")}</Label>
                    <Input
                        id={fxId}
                        type="text"
                        inputMode="decimal"
                        pattern="^[0-9]+([.,][0-9]+)?$"
                        placeholder={
                            withPlaceholders ? "1.0000000000" : undefined
                        }
                        value={form.fxRateToEur}
                        onChange={(e) =>
                            setForm((f) => ({
                                ...f,
                                fxRateToEur: e.target.value,
                            }))
                        }
                        {...fieldErrorProps(fxId, errors?.[fxId])}
                    />
                    <FieldError field={fxId} message={errors?.[fxId]} />
                </div>
            </div>

            {showRecurring && (
                <div className="rounded-lg border border-border p-3 space-y-3">
                    <div className="flex items-center justify-between">
                        <Label
                            htmlFor={`${idPrefix}-recurring`}
                            className="text-sm"
                        >
                            {t("addPortTxn.recurring")}
                        </Label>
                        <Switch
                            id={`${idPrefix}-recurring`}
                            checked={form.isRecurring}
                            onCheckedChange={(v) =>
                                setForm((f) => ({ ...f, isRecurring: v }))
                            }
                        />
                    </div>
                    {form.isRecurring && (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="space-y-1">
                                <Label
                                    htmlFor={`${idPrefix}-interval`}
                                    className="text-xs"
                                >
                                    {t("addPortTxn.interval")}
                                </Label>
                                <Select
                                    value={form.recurrenceInterval}
                                    onValueChange={(v) =>
                                        setForm((f) => ({
                                            ...f,
                                            recurrenceInterval:
                                                v as RecurrenceInterval,
                                        }))
                                    }
                                >
                                    <SelectTrigger
                                        id={`${idPrefix}-interval`}
                                        className="h-8 text-xs"
                                    >
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {Object.entries(recurrenceLabels).map(
                                            ([k, l]) => (
                                                <SelectItem key={k} value={k}>
                                                    {l}
                                                </SelectItem>
                                            ),
                                        )}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-1">
                                <Label
                                    htmlFor={`${idPrefix}-end-date`}
                                    className="text-xs"
                                >
                                    {t("addPortTxn.endDate")}
                                </Label>
                                <DatePicker
                                    id={`${idPrefix}-end-date`}
                                    value={
                                        form.recurrenceEndDate
                                            ? parseLocalDateFromYmd(
                                                  form.recurrenceEndDate,
                                              )
                                            : undefined
                                    }
                                    onChange={(date) =>
                                        setForm((f) => ({
                                            ...f,
                                            recurrenceEndDate: date
                                                ? toYmd(date)
                                                : "",
                                        }))
                                    }
                                    placeholder={t("plannedPage.link.pickDate")}
                                    allowClear
                                    clearLabel={t("common.clear")}
                                    buttonClassName="h-8 text-xs"
                                />
                            </div>
                        </div>
                    )}
                </div>
            )}

            <div className="space-y-2">
                <Label htmlFor={`${idPrefix}-note`}>
                    {t("addPortTxn.note")}
                </Label>
                <Textarea
                    id={`${idPrefix}-note`}
                    placeholder={
                        withPlaceholders ? t("addPortTxn.note") : undefined
                    }
                    rows={2}
                    value={form.note}
                    onChange={(e) =>
                        setForm((f) => ({ ...f, note: e.target.value }))
                    }
                    maxLength={300}
                />
            </div>
        </>
    );
}
