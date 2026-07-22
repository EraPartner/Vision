import type { AssetClass } from '@/types/portfolio';
import {
  ASSET_CLASSES,
  UNIT_BASED_ASSET_CLASSES,
  FIXED_INCOME_ASSET_CLASSES,
} from '@vision/types/assetClasses';

// Full set of supported asset classes, in display order. Single-sourced in
// @vision/types so the backend copy cannot drift (SIMP-11); the AssetClass
// union itself now derives from the shared array (types/portfolio.ts
// re-exports it), so no separate parity check is needed.

export { ASSET_CLASSES, UNIT_BASED_ASSET_CLASSES, FIXED_INCOME_ASSET_CLASSES };

export function isUnitBased(assetClass: AssetClass): boolean {
  return (UNIT_BASED_ASSET_CLASSES as readonly string[]).includes(assetClass);
}

export function isFixedIncome(assetClass: AssetClass): boolean {
  return (FIXED_INCOME_ASSET_CLASSES as readonly string[]).includes(assetClass);
}

export function isRealEstate(assetClass: AssetClass): boolean {
  return assetClass === 'real_estate';
}
