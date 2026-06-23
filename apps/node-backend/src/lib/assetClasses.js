/**
 * Canonical list of supported portfolio asset classes, in display order. Lives
 * in lib/ (not the repository layer) so routes can import it without crossing
 * layers. The repository's TRANSACTION_TABLE_BY_ASSET_CLASS keys mirror this set.
 */
export const ASSET_CLASSES = ['stock', 'etf', 'crypto', 'metals', 'real_estate', 'savings', 'bond'];
export const VALID_ASSET_CLASSES = new Set(ASSET_CLASSES);
