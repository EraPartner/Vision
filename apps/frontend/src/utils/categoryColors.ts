/**
 * Category color identity.
 *
 * A category must keep the *same* color everywhere it appears — chip, pie slice,
 * Sankey node — regardless of its spend rank or which list it is in. Positional
 * (by-loop-index) coloring gives FOOD:GROCERIES a different hue on every surface,
 * which reads as machine-generated and defeats the point of color.
 *
 * So color is derived deterministically from the category's GENERAL part
 * (`GENERAL:DETAIL` → `GENERAL`) via a stable hash into the 8 chart tokens. Both
 * the chart color and the chip classes resolve to the SAME `--chart-N` token, so
 * the two never drift.
 */

import { CHART_TOKEN_COLORS } from "@/components/charts/palette";

/** Number of chart tokens (`--chart-1..8`). */
const TOKEN_COUNT = CHART_TOKEN_COLORS.length;

/**
 * Chip class triplets, one per chart token. Kept as complete literal strings so
 * Tailwind's JIT scanner emits `bg-chart-N/15 text-chart-N border-chart-N/30`;
 * a computed `bg-chart-${n}` template would never be generated.
 */
const CHIP_CLASSES = [
    "bg-chart-1/15 text-chart-1 border-chart-1/30",
    "bg-chart-2/15 text-chart-2 border-chart-2/30",
    "bg-chart-3/15 text-chart-3 border-chart-3/30",
    "bg-chart-4/15 text-chart-4 border-chart-4/30",
    "bg-chart-5/15 text-chart-5 border-chart-5/30",
    "bg-chart-6/15 text-chart-6 border-chart-6/30",
    "bg-chart-7/15 text-chart-7 border-chart-7/30",
    "bg-chart-8/15 text-chart-8 border-chart-8/30",
] as const;

const MUTED_CHIP = "bg-muted/15 text-muted-foreground border-muted/30";

/** The GENERAL part of a `GENERAL:DETAIL` category, trimmed and upper-cased. */
function generalKey(category: string): string {
    return (category.split(":")[0] || category).trim().toUpperCase();
}

/** Stable non-negative djb2 hash — deterministic across sessions and reloads. */
function hashString(value: string): number {
    let hash = 5381;
    for (let i = 0; i < value.length; i++) {
        hash = (hash * 33 + value.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

/**
 * Deterministic chart-token index (0-based) for a category's GENERAL part.
 * Empty categories map to index 0 but callers should special-case them (charts
 * use a neutral tone, chips use the muted fallback).
 */
export function getCategoryColorIndex(category: string): number {
    if (!category) return 0;
    return hashString(generalKey(category)) % TOKEN_COUNT;
}

/**
 * Deterministic chart color (`hsl(var(--chart-N))`) for a category. Use this for
 * every chart — pie slices, Sankey nodes, bars — so a category holds one hue.
 */
export function getCategoryChartColor(category: string): string {
    if (!category) return "hsl(var(--muted-foreground))";
    return CHART_TOKEN_COLORS[getCategoryColorIndex(category)];
}

/**
 * Tailwind chip classes (bg/text/border) for a category, tied to the SAME token
 * as {@link getCategoryChartColor}. Uncategorized/empty falls back to muted.
 */
export const getCategoryColor = (category: string): string => {
    if (!category) return MUTED_CHIP;
    return CHIP_CLASSES[getCategoryColorIndex(category)];
};
