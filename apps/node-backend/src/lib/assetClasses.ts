/**
 * Canonical list of supported portfolio asset classes, in display order. Lives
 * in lib/ (not the repository layer) so routes can import it without crossing
 * layers.
 * The array is single-sourced in @vision/types to stay in lockstep with the
 * frontend copy (SIMP-11).
 */
import { ASSET_CLASSES } from '@vision/types/assetClasses';

export { ASSET_CLASSES };
export const VALID_ASSET_CLASSES = new Set(ASSET_CLASSES);
