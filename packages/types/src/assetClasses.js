/**
 * Canonical list of supported portfolio asset classes, in display order.
 * Single source shared by the backend (lib/assetClasses, portfolio repos) and
 * frontend (utils/assetClass, types/portfolio, types/api) so the hand-mirrored
 * copies can no longer drift. Must stay in lockstep with the PG enum and
 * TRANSACTION_TABLE_BY_ASSET_CLASS.
 */
export const ASSET_CLASSES = ['stock', 'etf', 'crypto', 'metals', 'real_estate', 'savings', 'bond'];
export const UNIT_BASED_ASSET_CLASSES = ['stock', 'etf', 'crypto', 'metals'];
export const FIXED_INCOME_ASSET_CLASSES = ['savings', 'bond'];
export const REAL_ESTATE_ASSET_CLASS = 'real_estate';
