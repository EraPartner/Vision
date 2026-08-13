import { TrendingUp, Bitcoin, Building2, PiggyBank, BarChart3, Gem } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getAssetClassLabel } from '@/types/portfolio';
import type { AssetClass } from '@/types/portfolio';
import type { PriceProvider } from '@/types/api';
import { defaultProviderFor } from './defaultProviderFor';

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

export function AssetTypeSelector({ visibleAssetClasses, assetDescriptions, onSelect, t }: AssetTypeSelectorProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {visibleAssetClasses.map((key) => {
        const Icon = ASSET_ICONS[key];
        const label = getAssetClassLabel(t, key);
        return (
          <button
            key={key}
            onClick={() => onSelect(key, defaultProviderFor(key))}
            className={cn(
              'flex flex-col items-start gap-2 p-4 rounded-lg border border-border text-left',
              'hover:border-primary hover:bg-primary/5 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            )}
          >
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Icon className="h-5 w-5 text-primary" />
            </div>
            <div>
              <span className="text-sm font-medium text-foreground">{label}</span>
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                {assetDescriptions[key]}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
