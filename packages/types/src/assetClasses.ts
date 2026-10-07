/**
 * Canonical list of supported portfolio asset classes, in display order.
 * Single source shared by the backend (lib/assetClasses, portfolio repos) and
 * frontend (utils/assetClass, types/portfolio, types/api) so the hand-mirrored
 * copies can no longer drift. Must stay in lockstep with the PG enum and
 * TRANSACTION_TABLE_BY_ASSET_CLASS. The AssetClass union derives from the
 * const tuple so the type and the runtime array cannot drift apart.
 */
export const ASSET_CLASSES = [
  "stock",
  "etf",
  "crypto",
  "metals",
  "real_estate",
  "savings",
  "bond",
] as const;

export type AssetClass = (typeof ASSET_CLASSES)[number];

export const UNIT_BASED_ASSET_CLASSES = [
  "stock",
  "etf",
  "crypto",
  "metals",
] as const;
export const FIXED_INCOME_ASSET_CLASSES = ["savings", "bond"] as const;
export const REAL_ESTATE_ASSET_CLASS = "real_estate";
