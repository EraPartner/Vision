import { parseDecimal } from "@/lib/decimal";
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
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { toast } from "sonner";
import type { InvestmentSummary } from "@/types/portfolio";
import { isUnitBased } from "@/utils/assetClass";
import type { PriceProvider } from "@/types/api";
import { PriceProviderFields } from "./PriceProviderFields";
import { priceProviderPayload } from "./priceProviderPayload";
import { INVESTMENT_CURRENCIES } from "@/utils/currency";
import {
    useDialogFormState,
    useReseedOnIdentityChange,
    useControlledOpen,
    returnFocusOnClose,
    type ControlledDialogProps,
} from "@/hooks/useDialogFormState";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";

interface Props extends ControlledDialogProps {
    investment: InvestmentSummary;
    trigger?: React.ReactNode;
}

export function EditInvestmentDialog({
    investment,
    trigger,
    open: openProp,
    onOpenChange,
    returnFocusRef,
}: Props) {
    const { t } = useLanguage();
    const { updateInvestment, isUpdatingInvestment } = usePortfolio();
    const { open, setOpen, controlled } = useControlledOpen({
        open: openProp,
        onOpenChange,
    });

    const initialForm = () => ({
        name: investment.name,
        symbol: investment.symbol || "",
        // Edit the investment's NATIVE currency. On an InvestmentSummary `currency`
        // is the app's display/target currency (all amounts are converted to it);
        // the native currency lives in `originalCurrency`. Reading `currency` here
        // pre-filled the wrong value and a save could overwrite the real native
        // currency with the display one.
        currency: investment.originalCurrency || investment.currency || "EUR",
        currentPrice:
            investment.currentPrice != null
                ? String(investment.currentPrice)
                : investment.current_price != null
                  ? String(investment.current_price)
                  : "",
        priceProvider: (investment.price_provider || "manual") as PriceProvider,
        priceProviderId: investment.price_provider_id || "",
        priceProviderUrl: investment.price_provider_url || "",
        priceProviderLatestUrl: investment.price_provider_latest_url || "",
        priceProviderLatestPath: investment.price_provider_latest_path || "",
        priceProviderHistoryUrl: investment.price_provider_history_url || "",
        priceProviderHistoryPath:
            investment.price_provider_history_path || "points",
        priceProviderHistoryTsPath:
            investment.price_provider_history_ts_path || "timestamp_ms",
        priceProviderHistoryPricePath:
            investment.price_provider_history_price_path || "price",
    });

    // Edits survive a dismissal (overlay click / Escape / ✕) — see
    // useDialogFormState. The prefill still has to be right, so the form re-seeds
    // when this instance is pointed at a different investment, and whenever a
    // pristine dialog is reopened (picking up the values a save just persisted).
    const { form, setForm, reset, dirty } = useDialogFormState(initialForm);
    useUnsavedChanges(dirty);
    useReseedOnIdentityChange(investment.id, reset);

    const handleOpenChange = (v: boolean) => {
        if (v && !dirty) reset();
        setOpen(v);
    };

    const unitBased = isUnitBased(investment.assetClass);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        // The input's `required` blocks a truly empty field, but a whitespace-only
        // name passed it and this guard then silently no-op'd the Save.
        if (!form.name.trim()) {
            toast.error(t("invEdit.nameRequired"));
            return;
        }
        if (unitBased && !form.symbol.trim()) {
            toast.error(t("invEdit.symbolRequired"));
            return;
        }

        try {
            await updateInvestment(investment.id, {
                name: form.name.trim(),
                symbol: unitBased
                    ? form.symbol.trim().toUpperCase()
                    : undefined,
                currency: form.currency,
                current_price:
                    form.priceProvider === "manual" && form.currentPrice
                        ? parseDecimal(form.currentPrice)
                        : undefined,
                ...priceProviderPayload(form),
            });
            toast.success(
                t("invEdit.toast.updated", { name: form.name.trim() }),
            );
            reset();
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
                    <DialogTitle>{t("invEdit.title")}</DialogTitle>
                    <DialogDescription className="sr-only">
                        {t("invEdit.title")}
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="edit-inv-name">
                            {t("addInv.label.name")}
                        </Label>
                        <Input
                            id="edit-inv-name"
                            value={form.name}
                            onChange={(e) =>
                                setForm((f) => ({ ...f, name: e.target.value }))
                            }
                            maxLength={100}
                            required
                        />
                    </div>

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        {unitBased && (
                            <div className="space-y-2">
                                <Label htmlFor="edit-inv-symbol">
                                    {t("addInv.label.ticker")}
                                </Label>
                                <Input
                                    id="edit-inv-symbol"
                                    value={form.symbol}
                                    onChange={(e) =>
                                        setForm((f) => ({
                                            ...f,
                                            symbol: e.target.value.toUpperCase(),
                                        }))
                                    }
                                    maxLength={20}
                                    className="font-mono"
                                    required
                                />
                            </div>
                        )}

                        <div className="space-y-2">
                            <Label htmlFor="edit-inv-currency">
                                {t("addInv.label.currency")}
                            </Label>
                            <Select
                                value={form.currency}
                                onValueChange={(v) =>
                                    setForm((f) => ({ ...f, currency: v }))
                                }
                            >
                                <SelectTrigger id="edit-inv-currency">
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

                    <PriceProviderFields
                        idPrefix="edit-inv"
                        form={form}
                        setForm={setForm}
                        showManualPrice={unitBased}
                        t={t}
                    />

                    <DialogFooter className="pt-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                                reset();
                                setOpen(false);
                            }}
                        >
                            {t("common.cancel")}
                        </Button>
                        <Button type="submit" disabled={isUpdatingInvestment}>
                            {isUpdatingInvestment && (
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
