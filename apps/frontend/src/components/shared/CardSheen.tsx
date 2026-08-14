import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Two tiers of one motif (see the `.card-sheen` block in index.css for the
 * paint). Mirrors `Card`'s cva variant idiom: the tier is a named place in the
 * hierarchy, not a bag of size/colour knobs at the call site.
 *
 * - `default` — the KPI/widget tier: 8rem, `--glass-highlight`, a light sheen
 *   in both modes. Every stat tile, chart card and panel header.
 * - `hero` — a page's single hero tile (today only the dashboard's
 *   NetSummaryCard): 12rem, `--background`, which inverts the tone by mode —
 *   pale wash in light, dark vignette in dark. Deliberate, not drift.
 *
 * Plain content cards get neither.
 */
const cardSheenVariants = cva("", {
    variants: {
        tier: {
            default: "card-sheen",
            hero: "card-sheen-hero",
        },
    },
    defaultVariants: {
        tier: "default",
    },
});

interface CardSheenProps extends VariantProps<typeof cardSheenVariants> {
    /** Subtle grow-on-hover, matching the KPI-tile treatment (needs a `group` parent). */
    animated?: boolean;
    className?: string;
}

/**
 * Decorative corner sheen for hero/KPI cards (ADR-105 elevation tier).
 *
 * One motif, one rule: a soft highlight bleeding from the top-right corner,
 * driven by theme tokens (see `.card-sheen` in index.css) so it adapts to
 * light/dark and every theme variant instead of hard-coding raw white. Purely
 * decorative — aria-hidden and non-interactive. Reserve it for hero/KPI cards,
 * never plain content cards; pick the tier with `tier` (see above).
 */
export function CardSheen({ animated = false, tier, className }: CardSheenProps) {
    return (
        <div
            aria-hidden
            className={cn(
                cardSheenVariants({ tier }),
                animated && "transition-transform duration-500 group-hover:scale-110",
                className,
            )}
        />
    );
}
