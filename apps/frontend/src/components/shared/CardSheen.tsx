import { cn } from "@/lib/utils";

interface CardSheenProps {
    /** Subtle grow-on-hover, matching the KPI-tile treatment (needs a `group` parent). */
    animated?: boolean;
    className?: string;
}

/**
 * Decorative corner sheen for hero/KPI cards (ADR-105 elevation tier).
 *
 * One motif, one rule: a soft highlight bleeding from the top-right corner,
 * driven by the `--glass-highlight` token (see `.card-sheen` in index.css) so it
 * adapts to light/dark and every theme variant instead of hard-coding raw white.
 * Purely decorative — aria-hidden and non-interactive. Reserve it for hero/KPI
 * cards, never plain content cards.
 */
export function CardSheen({ animated = false, className }: CardSheenProps) {
    return (
        <div
            aria-hidden
            className={cn(
                "card-sheen",
                animated && "transition-transform duration-500 group-hover:scale-110",
                className,
            )}
        />
    );
}
