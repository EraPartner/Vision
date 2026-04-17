import type { AssetClass } from '@/types/portfolio';

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
