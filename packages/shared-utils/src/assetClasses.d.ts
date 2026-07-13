export type AssetClass =
  | 'stock'
  | 'etf'
  | 'crypto'
  | 'metals'
  | 'real_estate'
  | 'savings'
  | 'bond';

export const ASSET_CLASSES: readonly AssetClass[];
export const UNIT_BASED_ASSET_CLASSES: readonly AssetClass[];
export const FIXED_INCOME_ASSET_CLASSES: readonly AssetClass[];
export const REAL_ESTATE_ASSET_CLASS: 'real_estate';
