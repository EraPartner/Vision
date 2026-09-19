/**
 * Category color identity — ONE deterministic category → color assignment
 * shared by badge chips and every chart.
 *
 * Colors key on the root category via a stable string hash into the eight
 * --chart-N tokens, so FOOD:GROCERIES keeps the same hue
 * on the dashboard donut, the statistics donut, the Sankey, and the
 * transaction chips — regardless of spend rank, list order, or month.
 * Collisions are expected past eight generals; identity (same category =
 * same color everywhere) is the goal, not uniqueness.
 */

const CHART_TOKEN_COUNT = 8;

// Literal class strings so Tailwind's content scan generates them — a
// template literal built at runtime would never be seen by the scanner.
const BADGE_CLASSES = [
    "bg-chart-1/15 text-chart-1 border-chart-1/30",
    "bg-chart-2/15 text-chart-2 border-chart-2/30",
    "bg-chart-3/15 text-chart-3 border-chart-3/30",
    "bg-chart-4/15 text-chart-4 border-chart-4/30",
    "bg-chart-5/15 text-chart-5 border-chart-5/30",
    "bg-chart-6/15 text-chart-6 border-chart-6/30",
    "bg-chart-7/15 text-chart-7 border-chart-7/30",
    "bg-chart-8/15 text-chart-8 border-chart-8/30",
] as const;

type CategoryColorIdentity = string | readonly string[];

function categoryRoot(category: CategoryColorIdentity): string {
    // Ordered segments are authoritative. A display name alone cannot
    // distinguish a literal colon in a name from the legacy separator.
    if (Array.isArray(category))
        return (category[0] ?? "").trim().toUpperCase();
    return (String(category).split(":")[0] ?? "").trim().toUpperCase();
}

/** Stable 0-based chart-token index. Pass ordered segments when available. */
export function categoryColorIndex(category: CategoryColorIdentity): number {
    const general = categoryRoot(category);
    let hash = 0;
    for (let i = 0; i < general.length; i++) {
        hash = (hash * 31 + general.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % CHART_TOKEN_COUNT;
}

/** Chart fill for a category — `hsl(var(--chart-N))`, theme-adaptive. */
export function getCategoryChartColor(category: CategoryColorIdentity): string {
    if (!categoryRoot(category)) return "hsl(var(--muted-foreground))";
    return `hsl(var(--chart-${categoryColorIndex(category) + 1}))`;
}

/** Badge chip classes for a category; muted for uncategorized. */
export const getCategoryColor = (category: CategoryColorIdentity): string => {
    if (!categoryRoot(category))
        return "bg-muted/15 text-muted-foreground border-muted/30";
    return BADGE_CLASSES[categoryColorIndex(category)];
};
