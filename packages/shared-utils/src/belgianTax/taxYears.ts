import type { BelgianRegion } from "./types.ts";

/**
 * The income years that have a tax table in `constants.ts` and the latest table's default
 * communal surcharges. They live apart from the tables so the browser can read them without
 * loading the engine's parameters (ADR-217). `constants.ts` throws at load when its tables
 * disagree with these values.
 */
export const SUPPORTED_TAX_YEARS: number[] = [2024, 2025, 2026];
export const EARLIEST_TAX_YEAR = 2024;
export const LATEST_TAX_YEAR = 2026;
export const DEFAULT_COMMUNAL_SURCHARGE: Record<BelgianRegion, number> = {
    flanders: 7,
    wallonia: 7.5,
    brussels: 7,
};
