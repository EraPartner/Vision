/**
 * PriceProviderFields — the shared price-provider block (provider Select +
 * provider-id + manual current-price + the six custom-JSON path inputs) used by
 * both the Add investment flow (via InvestmentFormFields) and EditInvestmentDialog,
 * which previously carried near-identical copies of this markup.
 *
 * Provider membership and ordering come from the backend catalog exposed by
 * GET /api/investments/providers. Known hints stay translated, with a local
 * fallback while the catalog request is pending or unavailable.
 *
 * The outer `isUnitBased` gating differs between callers (Add hides the whole
 * block for non-unit-based assets; Edit always shows it but hides only the
 * manual-price input), so callers keep that gate outside and pass
 * `showManualPrice` for the manual-price sub-block.
 */

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type { PriceProvider } from "@/types/api";
import { usePriceProviderCatalog } from "./usePriceProviderCatalog";

type TranslateFn = (
    key: string,
    params?: Record<string, string | number>,
) => string;

/** The provider-related fields the shared block reads and writes. */
export interface PriceProviderFormShape {
    priceProvider: PriceProvider;
    priceProviderId: string;
    currentPrice: string;
    priceProviderLatestUrl: string;
    priceProviderLatestPath: string;
    priceProviderHistoryUrl: string;
    priceProviderHistoryPath: string;
    priceProviderHistoryTsPath: string;
    priceProviderHistoryPricePath: string;
}

interface PriceProviderFieldsProps<F extends PriceProviderFormShape> {
    idPrefix: string;
    form: F;
    setForm: (updater: (prev: F) => F) => void;
    /** Whether the manual current-price input may appear (gated on unit-based). */
    showManualPrice: boolean;
    t: TranslateFn;
}

export function PriceProviderFields<F extends PriceProviderFormShape>({
    idPrefix,
    form,
    setForm,
    showManualPrice,
    t,
}: PriceProviderFieldsProps<F>) {
    const priceProviders = usePriceProviderCatalog(t);
    const selectedProvider = priceProviders.find(
        (provider) => provider.key === form.priceProvider,
    );

    return (
        <div className="space-y-3 pt-2 border-t border-border">
            <Label
                htmlFor={`${idPrefix}-price-provider`}
                className="text-sm font-medium"
            >
                {t("addInv.label.priceProvider")}
            </Label>
            <Select
                value={form.priceProvider}
                onValueChange={(v) =>
                    setForm((f) => ({
                        ...f,
                        priceProvider: v as PriceProvider,
                        priceProviderId: "",
                    }))
                }
            >
                <SelectTrigger id={`${idPrefix}-price-provider`}>
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {priceProviders.map((p) => (
                        <SelectItem key={p.key} value={p.key}>
                            <span className="font-medium">{p.name}</span>
                            <span className="text-muted-foreground ml-2 text-xs">
                                — {p.hint}
                            </span>
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {form.priceProvider !== "manual" &&
                form.priceProvider !== "custom" && (
                    <div className="space-y-2">
                        <Label
                            htmlFor={`${idPrefix}-provider-id`}
                            className="text-xs"
                        >
                            {t("addInv.label.providerId")}
                        </Label>
                        <Input
                            id={`${idPrefix}-provider-id`}
                            placeholder={selectedProvider?.hint || ""}
                            value={form.priceProviderId}
                            onChange={(e) =>
                                setForm((f) => ({
                                    ...f,
                                    priceProviderId: e.target.value,
                                }))
                            }
                            maxLength={200}
                            className="font-mono text-sm"
                        />
                    </div>
                )}

            {showManualPrice && form.priceProvider === "manual" && (
                <div className="space-y-2">
                    <Label htmlFor={`${idPrefix}-price`} className="text-xs">
                        {t("addInv.label.currentPrice")}
                    </Label>
                    <Input
                        id={`${idPrefix}-price`}
                        type="number"
                        step="0.0001"
                        min="0"
                        placeholder="0.00"
                        value={form.currentPrice}
                        onChange={(e) =>
                            setForm((f) => ({
                                ...f,
                                currentPrice: e.target.value,
                            }))
                        }
                    />
                </div>
            )}

            {form.priceProvider === "custom" && (
                <div className="space-y-3">
                    <div className="space-y-2">
                        <Label
                            htmlFor={`${idPrefix}-provider-latest-url`}
                            className="text-xs"
                        >
                            {t("addInv.label.latestJsonEndpoint")}
                        </Label>
                        <Input
                            id={`${idPrefix}-provider-latest-url`}
                            type="url"
                            placeholder={t("addInv.placeholder.jsonEndpoint")}
                            value={form.priceProviderLatestUrl}
                            onChange={(e) =>
                                setForm((f) => ({
                                    ...f,
                                    priceProviderLatestUrl: e.target.value,
                                }))
                            }
                            maxLength={500}
                            className="font-mono text-sm"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label
                            htmlFor={`${idPrefix}-provider-latest-path`}
                            className="text-xs"
                        >
                            {t("addInv.label.latestJsonPath")}
                        </Label>
                        <Input
                            id={`${idPrefix}-provider-latest-path`}
                            placeholder="price"
                            value={form.priceProviderLatestPath}
                            onChange={(e) =>
                                setForm((f) => ({
                                    ...f,
                                    priceProviderLatestPath: e.target.value,
                                }))
                            }
                            maxLength={300}
                            className="font-mono text-sm"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label
                            htmlFor={`${idPrefix}-provider-history-url`}
                            className="text-xs"
                        >
                            {t("addInv.label.historyJsonEndpoint")}
                        </Label>
                        <Input
                            id={`${idPrefix}-provider-history-url`}
                            type="url"
                            placeholder={t("addInv.placeholder.jsonEndpoint")}
                            value={form.priceProviderHistoryUrl}
                            onChange={(e) =>
                                setForm((f) => ({
                                    ...f,
                                    priceProviderHistoryUrl: e.target.value,
                                }))
                            }
                            maxLength={500}
                            className="font-mono text-sm"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label
                            htmlFor={`${idPrefix}-provider-history-path`}
                            className="text-xs"
                        >
                            {t("addInv.label.historyArrayPath")}
                        </Label>
                        <Input
                            id={`${idPrefix}-provider-history-path`}
                            placeholder="points"
                            value={form.priceProviderHistoryPath}
                            onChange={(e) =>
                                setForm((f) => ({
                                    ...f,
                                    priceProviderHistoryPath: e.target.value,
                                }))
                            }
                            maxLength={300}
                            className="font-mono text-sm"
                        />
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                            <Label
                                htmlFor={`${idPrefix}-provider-history-ts`}
                                className="text-xs"
                            >
                                {t("addInv.label.historyTimestampPath")}
                            </Label>
                            <Input
                                id={`${idPrefix}-provider-history-ts`}
                                placeholder="timestamp_ms"
                                value={form.priceProviderHistoryTsPath}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        priceProviderHistoryTsPath:
                                            e.target.value,
                                    }))
                                }
                                maxLength={300}
                                className="font-mono text-sm"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label
                                htmlFor={`${idPrefix}-provider-history-price`}
                                className="text-xs"
                            >
                                {t("addInv.label.historyPricePath")}
                            </Label>
                            <Input
                                id={`${idPrefix}-provider-history-price`}
                                placeholder="price"
                                value={form.priceProviderHistoryPricePath}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        priceProviderHistoryPricePath:
                                            e.target.value,
                                    }))
                                }
                                maxLength={300}
                                className="font-mono text-sm"
                            />
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
