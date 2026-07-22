/**
 * Compatibility shim — the canonical asset-class lists moved to
 * @vision/types/assetClasses (runtime constants + derived unions). This
 * subpath re-exports them so existing `@vision/shared-utils/assetClasses`
 * imports keep resolving.
 */
export {
  ASSET_CLASSES,
  UNIT_BASED_ASSET_CLASSES,
  FIXED_INCOME_ASSET_CLASSES,
  REAL_ESTATE_ASSET_CLASS,
} from '@vision/types/assetClasses';
