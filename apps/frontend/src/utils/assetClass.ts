import type { AssetClass } from '@/types/portfolio';
import {
  ASSET_CLASSES,
  UNIT_BASED_ASSET_CLASSES,
  FIXED_INCOME_ASSET_CLASSES,
} from '@vision/shared-utils/assetClasses';

// Full set of supported asset classes, in display order. Single-sourced in
// @vision/shared-utils so the backend copy cannot drift (SIMP-11). The parity
// check below fails typecheck if the shared list and the OpenAPI-generated
// AssetClass union ever diverge.
type SharedAssetClass = (typeof ASSET_CLASSES)[number];
type _AssetClassParity = [SharedAssetClass] extends [AssetClass]
  ? [AssetClass] extends [SharedAssetClass]
    ? true
    : never
  : never;
const _assetClassParity: _AssetClassParity = true;
void _assetClassParity;

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
