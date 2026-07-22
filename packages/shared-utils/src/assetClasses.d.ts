/**
 * Compatibility shim — canonical declarations live in
 * @vision/types/assetClasses; re-exported so existing imports keep resolving.
 */
export {
  ASSET_CLASSES,
  UNIT_BASED_ASSET_CLASSES,
  FIXED_INCOME_ASSET_CLASSES,
  REAL_ESTATE_ASSET_CLASS,
} from '@vision/types/assetClasses';
export type { AssetClass } from '@vision/types/assetClasses';
