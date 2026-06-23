import type { AssetClass } from '@/types/portfolio';

// Full set of supported asset classes, in display order. Single source for the
// import mapper's options and any other client-side asset-class enumeration.
export const ASSET_CLASSES = ['stock', 'etf', 'crypto', 'metals', 'real_estate', 'savings', 'bond'] as const satisfies AssetClass[];

export const UNIT_BASED_ASSET_CLASSES = ['stock', 'etf', 'crypto', 'metals'] as const satisfies AssetClass[];
export const FIXED_INCOME_ASSET_CLASSES = ['savings', 'bond'] as const satisfies AssetClass[];

export function isUnitBased(assetClass: AssetClass): boolean {
  return (UNIT_BASED_ASSET_CLASSES as readonly string[]).includes(assetClass);
}

export function isFixedIncome(assetClass: AssetClass): boolean {
  return (FIXED_INCOME_ASSET_CLASSES as readonly string[]).includes(assetClass);
}

export function isRealEstate(assetClass: AssetClass): boolean {
  return assetClass === 'real_estate';
}
