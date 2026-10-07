import {
    TrendingUp,
    Bitcoin,
    Building2,
    PiggyBank,
    BarChart3,
    Gem,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAssetClassLabel } from "@/types/portfolio";
import type { AssetClass } from "@/types/portfolio";
import type { PriceProvider } from "@/types/api";
import { defaultProviderFor } from "./defaultProviderFor";

const ASSET_ICONS: Record<AssetClass, typeof TrendingUp> = {
    stock: TrendingUp,
    etf: BarChart3,
    crypto: Bitcoin,
    metals: Gem,
    real_estate: Building2,
    savings: PiggyBank,
    bond: PiggyBank,
};

interface AssetTypeSelectorProps {
    visibleAssetClasses: AssetClass[];
    assetDescriptions: Record<AssetClass, string>;
    onSelect: (key: AssetClass, defaultProvider: PriceProvider) => void;
    t: (key: string) => string;
}

export function AssetTypeSelector({
    visibleAssetClasses,
    assetDescriptions,
    onSelect,
    t,
}: AssetTypeSelectorProps) {
    return (
        <div className="grid grid-cols-2 gap-3">
            {visibleAssetClasses.map((key) => {
                const Icon = ASSET_ICONS[key];
                const label = getAssetClassLabel(t, key);
                return (
                    <Button
                        key={key}
                        type="button"
                        variant="outline"
                        onClick={() => onSelect(key, defaultProviderFor(key))}
                        className="h-auto flex-col items-start gap-2 whitespace-normal rounded-card corner-continuous p-4 text-left hover:border-primary/60 hover:bg-primary/[0.06]"
                    >
                        <span className="flex h-10 w-10 items-center justify-center rounded-control corner-continuous bg-primary/12 text-primary">
                            <Icon className="h-5 w-5" aria-hidden />
                        </span>
                        <span className="flex min-w-0 flex-col items-start">
                            <span className="type-body font-medium text-foreground">
                                {label}
                            </span>
                            <span className="mt-0.5 line-clamp-2 type-caption font-normal text-label-secondary">
                                {assetDescriptions[key]}
                            </span>
                        </span>
                    </Button>
                );
            })}
        </div>
    );
}
