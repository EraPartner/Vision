/**
 * TypeScript declarations for ./assetClasses.js — the canonical asset-class
 * value lists. The AssetClass union derives from the const tuple so the type
 * and the runtime array cannot drift apart.
 */

export declare const ASSET_CLASSES: readonly [
  'stock', 'etf', 'crypto', 'metals', 'real_estate', 'savings', 'bond',
];

export type AssetClass = (typeof ASSET_CLASSES)[number];

export declare const UNIT_BASED_ASSET_CLASSES: readonly ['stock', 'etf', 'crypto', 'metals'];
export declare const FIXED_INCOME_ASSET_CLASSES: readonly ['savings', 'bond'];
export declare const REAL_ESTATE_ASSET_CLASS: 'real_estate';
