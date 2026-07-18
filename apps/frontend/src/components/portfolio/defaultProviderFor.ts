import type { AssetClass } from '@/types/portfolio';
import type { PriceProvider } from '@/types/api';

/**
 * Default price provider for a newly picked asset class. Shared by
 * AssetTypeSelector and AddInvestmentDialog's single-asset-class shortcut.
 * (Lives outside AssetTypeSelector.tsx so that file only exports components,
 * keeping fast refresh intact.)
 */
export function defaultProviderFor(key: AssetClass): PriceProvider {
    if (key === 'crypto') return 'binance';
    if (['stock', 'etf', 'metals'].includes(key)) return 'yahoo';
    return 'manual';
}
