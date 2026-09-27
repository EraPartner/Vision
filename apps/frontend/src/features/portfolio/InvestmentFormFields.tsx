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
import type { PriceProvider } from "@/types/api";
import { PriceProviderFields } from "./PriceProviderFields";
import { INVESTMENT_CURRENCIES } from "@/utils/currency";
import type { ReactNode } from "react";

export interface InvestmentForm {
    assetClass: string;
    name: string;
    symbol: string;
    currency: string;
    currentPrice: string;
    interestRate: string;
    maturityDate: string;
    location: string;
    municipality: string;
    cadastralIncome: string;
    municipalityTaxRate: string;
    notes: string;
    priceProvider: PriceProvider;
    priceProviderId: string;
    priceProviderUrl: string;
    priceProviderLatestUrl: string;
    priceProviderLatestPath: string;
    priceProviderHistoryUrl: string;
    priceProviderHistoryPath: string;
    priceProviderHistoryTsPath: string;
    priceProviderHistoryPricePath: string;
    addInitialPurchase: boolean;
    initialAmount: string;
    initialUnits: string;
    initialDate: string;
    initialFees: string;
    initialAccountId?: string;
}

interface InvestmentFormFieldsProps {
    form: InvestmentForm;
    setForm: (updater: (prev: InvestmentForm) => InvestmentForm) => void;
    isUnitBased: boolean;
    isFixedIncome: boolean;
    isRealEstate: boolean;
    computedPricePerUnit: string;
    t: (key: string, params?: Record<string, string | number>) => string;
    initialBrokerField?: ReactNode;
    errors?: Record<string, string>;
}

export function InvestmentFormFields({
    form,
    setForm,
    isUnitBased,
    isFixedIncome,
    isRealEstate,
    computedPricePerUnit,
    t,
    initialBrokerField,
    errors = {},
}: InvestmentFormFieldsProps) {
    return (
        <>
            {/* Basic Info */}
            <div className="space-y-4">
                <div className="space-y-2">
                    <Label htmlFor="inv-name">{t("addInv.label.name")}</Label>
                    <Input
                        id="inv-name"
                        placeholder={
                            isUnitBased
                                ? t("addInv.placeholder.name.stock")
                                : isRealEstate
                                  ? t("addInv.placeholder.name.property")
                                  : t("addInv.placeholder.name.savings")
                        }
                        value={form.name}
                        onChange={(e) =>
                            setForm((f) => ({ ...f, name: e.target.value }))
                        }
                        maxLength={100}
                        required
                    />
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {isUnitBased && (
                        <div className="space-y-2">
                            <Label htmlFor="inv-symbol">
                                {t("addInv.label.ticker")}
                            </Label>
                            <Input
                                id="inv-symbol"
                                placeholder={t("addInv.placeholder.ticker")}
                                value={form.symbol}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        symbol: e.target.value.toUpperCase(),
                                    }))
                                }
                                maxLength={20}
                                className="font-mono"
                            />
                        </div>
                    )}

                    <div className="space-y-2">
                        <Label htmlFor="inv-currency">
                            {t("addInv.label.currency")}
                        </Label>
                        <Select
                            value={form.currency}
                            onValueChange={(v) =>
                                setForm((f) => ({ ...f, currency: v }))
                            }
                        >
                            <SelectTrigger id="inv-currency">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {INVESTMENT_CURRENCIES.map((c) => (
                                    <SelectItem key={c} value={c}>
                                        {c}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                {isFixedIncome && (
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                            <Label htmlFor="inv-rate">
                                {t("addInv.label.interestRate")}
                            </Label>
                            <Input
                                id="inv-rate"
                                aria-invalid={Boolean(errors["inv-rate"])}
                                aria-describedby={
                                    errors["inv-rate"]
                                        ? "inv-rate-error"
                                        : undefined
                                }
                                type="text"
                                inputMode="decimal"
                                placeholder="3.50"
                                value={form.interestRate}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        interestRate: e.target.value,
                                    }))
                                }
                            />
                            {errors["inv-rate"] && (
                                <p
                                    id="inv-rate-error"
                                    role="alert"
                                    className="text-sm text-destructive"
                                >
                                    {errors["inv-rate"]}
                                </p>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="inv-maturity">
                                {t("addInv.label.maturityDate")}
                            </Label>
                            <DatePicker
                                id="inv-maturity"
                                value={
                                    form.maturityDate
                                        ? parseLocalDateFromYmd(
                                              form.maturityDate,
                                          )
                                        : undefined
                                }
                                onChange={(date) =>
                                    setForm((f) => ({
                                        ...f,
                                        maturityDate: date ? toYmd(date) : "",
                                    }))
                                }
                                placeholder={t("plannedPage.link.pickDate")}
                                allowClear
                                clearLabel={t("common.clear")}
                            />
                        </div>
                    </div>
                )}

                {isRealEstate && (
                    <div className="space-y-4">
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Label htmlFor="inv-location">
                                    {t("addInv.label.location")}
                                </Label>
                                <Input
                                    id="inv-location"
                                    placeholder={t(
                                        "addInv.placeholder.location",
                                    )}
                                    value={form.location}
                                    onChange={(e) =>
                                        setForm((f) => ({
                                            ...f,
                                            location: e.target.value,
                                        }))
                                    }
                                    maxLength={200}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="inv-municipality">
                                    {t("addInv.label.municipality")}
                                </Label>
                                <Input
                                    id="inv-municipality"
                                    placeholder={t(
                                        "addInv.placeholder.municipality",
                                    )}
                                    value={form.municipality}
                                    onChange={(e) =>
                                        setForm((f) => ({
                                            ...f,
                                            municipality: e.target.value,
                                        }))
                                    }
                                    maxLength={200}
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Label htmlFor="inv-cadastral-income">
                                    {t("addInv.label.cadastralIncome")}
                                </Label>
                                <Input
                                    id="inv-cadastral-income"
                                    aria-invalid={Boolean(
                                        errors["inv-cadastral-income"],
                                    )}
                                    aria-describedby={
                                        errors["inv-cadastral-income"]
                                            ? "inv-cadastral-income-error"
                                            : undefined
                                    }
                                    type="text"
                                    inputMode="decimal"
                                    placeholder={t(
                                        "addInv.placeholder.cadastralIncome",
                                    )}
                                    value={form.cadastralIncome}
                                    onChange={(e) =>
                                        setForm((f) => ({
                                            ...f,
                                            cadastralIncome: e.target.value,
                                        }))
                                    }
                                />
                                {errors["inv-cadastral-income"] && (
                                    <p
                                        id="inv-cadastral-income-error"
                                        role="alert"
                                        className="text-sm text-destructive"
                                    >
                                        {errors["inv-cadastral-income"]}
                                    </p>
                                )}
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="inv-municipality-tax-rate">
                                    {t("addInv.label.municipalityTaxRate")}
                                </Label>
                                <Input
                                    id="inv-municipality-tax-rate"
                                    aria-invalid={Boolean(
                                        errors["inv-municipality-tax-rate"],
                                    )}
                                    aria-describedby={
                                        errors["inv-municipality-tax-rate"]
                                            ? "inv-municipality-tax-rate-error"
                                            : undefined
                                    }
                                    type="text"
                                    inputMode="decimal"
                                    placeholder={t(
                                        "addInv.placeholder.municipalityTaxRate",
                                    )}
                                    value={form.municipalityTaxRate}
                                    onChange={(e) =>
                                        setForm((f) => ({
                                            ...f,
                                            municipalityTaxRate: e.target.value,
                                        }))
                                    }
                                />
                                {errors["inv-municipality-tax-rate"] && (
                                    <p
                                        id="inv-municipality-tax-rate-error"
                                        role="alert"
                                        className="text-sm text-destructive"
                                    >
                                        {errors["inv-municipality-tax-rate"]}
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Initial Purchase */}
            <div className="rounded-lg border border-border p-4 space-y-4">
                <div className="flex items-center justify-between">
                    <div>
                        <Label
                            htmlFor="initial-purchase-enabled"
                            className="text-sm font-medium"
                        >
                            {t("addInv.initial.label", {
                                txType: isRealEstate
                                    ? t("addInv.initial.purchase")
                                    : isFixedIncome
                                      ? t("addInv.initial.deposit")
                                      : t("addInv.initial.buy"),
                            })}
                        </Label>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            {t("addInv.initial.desc", {
                                txWord: isRealEstate
                                    ? t("addInv.initial.purchaseWord")
                                    : isFixedIncome
                                      ? t("addInv.initial.depositWord")
                                      : t("addInv.initial.transactionWord"),
                            })}
                        </p>
                    </div>
                    <Switch
                        id="initial-purchase-enabled"
                        aria-label={t("addInv.initial.label", {
                            txType: isRealEstate
                                ? t("addInv.initial.purchase")
                                : isFixedIncome
                                  ? t("addInv.initial.deposit")
                                  : t("addInv.initial.buy"),
                        })}
                        checked={form.addInitialPurchase}
                        onCheckedChange={(v) =>
                            setForm((f) => ({ ...f, addInitialPurchase: v }))
                        }
                    />
                </div>

                {form.addInitialPurchase && (
                    <div className="space-y-3 pt-2 border-t border-border">
                        {isUnitBased && (
                            <p className="text-xs text-muted-foreground">
                                {t("addInv.initial.unitHelp")}
                            </p>
                        )}
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Label htmlFor="init-date" className="text-xs">
                                    {t("addInv.label.date")}
                                </Label>
                                <DatePicker
                                    id="init-date"
                                    value={
                                        form.initialDate
                                            ? parseLocalDateFromYmd(
                                                  form.initialDate,
                                              )
                                            : undefined
                                    }
                                    onChange={(date) =>
                                        setForm((f) => ({
                                            ...f,
                                            initialDate: date
                                                ? toYmd(date)
                                                : "",
                                        }))
                                    }
                                    placeholder={t("plannedPage.link.pickDate")}
                                    buttonClassName="h-9"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label
                                    htmlFor="init-amount"
                                    className="text-xs"
                                >
                                    {isRealEstate
                                        ? t("addInv.label.purchasePrice")
                                        : isFixedIncome
                                          ? t("addInv.label.depositAmount")
                                          : t("addInv.label.totalCost")}{" "}
                                    *
                                </Label>
                                <Input
                                    id="init-amount"
                                    aria-required="true"
                                    aria-invalid={Boolean(
                                        errors["init-amount"],
                                    )}
                                    aria-describedby={
                                        errors["init-amount"]
                                            ? "init-amount-error"
                                            : undefined
                                    }
                                    type="text"
                                    inputMode="decimal"
                                    className="h-9"
                                    placeholder="10000.00"
                                    value={form.initialAmount}
                                    onChange={(e) =>
                                        setForm((f) => ({
                                            ...f,
                                            initialAmount: e.target.value,
                                        }))
                                    }
                                />
                                {errors["init-amount"] && (
                                    <p
                                        id="init-amount-error"
                                        role="alert"
                                        className="text-sm text-destructive"
                                    >
                                        {errors["init-amount"]}
                                    </p>
                                )}
                            </div>
                        </div>

                        {isUnitBased && (
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div className="space-y-2">
                                    <Label
                                        htmlFor="init-units"
                                        className="text-xs"
                                    >
                                        {t("addInv.label.units")} *
                                    </Label>
                                    <Input
                                        id="init-units"
                                        aria-required="true"
                                        aria-invalid={Boolean(
                                            errors["init-units"],
                                        )}
                                        aria-describedby={
                                            errors["init-units"]
                                                ? "init-units-error"
                                                : undefined
                                        }
                                        type="text"
                                        inputMode="decimal"
                                        className="h-9"
                                        placeholder="100"
                                        value={form.initialUnits}
                                        onChange={(e) =>
                                            setForm((f) => ({
                                                ...f,
                                                initialUnits: e.target.value,
                                            }))
                                        }
                                    />
                                    {errors["init-units"] && (
                                        <p
                                            id="init-units-error"
                                            role="alert"
                                            className="text-sm text-destructive"
                                        >
                                            {errors["init-units"]}
                                        </p>
                                    )}
                                </div>
                                <div className="space-y-2">
                                    <p className="text-xs font-medium">
                                        {t("addInv.label.pricePerUnit")}
                                    </p>
                                    <div className="h-9 px-3 flex items-center rounded-md border border-input bg-muted/50 text-sm text-muted-foreground font-mono">
                                        {computedPricePerUnit || "—"}
                                    </div>
                                </div>
                            </div>
                        )}

                        <div className="space-y-2">
                            <Label htmlFor="init-fees" className="text-xs">
                                {t("addInv.label.fees")}
                            </Label>
                            <Input
                                id="init-fees"
                                aria-invalid={Boolean(errors["init-fees"])}
                                aria-describedby={
                                    errors["init-fees"]
                                        ? "init-fees-error"
                                        : undefined
                                }
                                type="text"
                                inputMode="decimal"
                                className="h-9"
                                placeholder="0.00"
                                value={form.initialFees}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        initialFees: e.target.value,
                                    }))
                                }
                            />
                            {errors["init-fees"] && (
                                <p
                                    id="init-fees-error"
                                    role="alert"
                                    className="text-sm text-destructive"
                                >
                                    {errors["init-fees"]}
                                </p>
                            )}
                        </div>
                        {initialBrokerField}
                    </div>
                )}
            </div>

            {/* Price Provider */}
            {isUnitBased && (
                <PriceProviderFields
                    idPrefix="inv"
                    form={form}
                    setForm={setForm}
                    showManualPrice
                    currentPriceError={errors["inv-price"]}
                    t={t}
                />
            )}

            {/* Notes */}
            <div className="space-y-2">
                <Label htmlFor="inv-notes">{t("addInv.label.notes")}</Label>
                <Textarea
                    id="inv-notes"
                    placeholder={t("addInv.placeholder.notes")}
                    rows={2}
                    value={form.notes}
                    onChange={(e) =>
                        setForm((f) => ({ ...f, notes: e.target.value }))
                    }
                    maxLength={500}
                />
            </div>
        </>
    );
}
