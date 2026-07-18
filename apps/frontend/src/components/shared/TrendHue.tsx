import { cn } from "@/lib/utils";

type TrendTone = "gain" | "loss" | "neutral";

const TREND_HUE: Record<TrendTone, string> = {
    gain: "from-gain/10 to-gain/5",
    loss: "from-loss/10 to-loss/5",
    neutral: "from-primary/10 to-primary/5",
};

/**
 * Faint diagonal gain/loss/neutral wash for summary cards — the single source of
 * truth for the card tint shared across the dashboard, net-worth, portfolio
 * overview and performance surfaces. Render as the first child of a
 * `relative overflow-hidden` Card.
 */
export function TrendHue({ tone }: { tone: TrendTone }) {
    return (
        <div
            aria-hidden
            className={cn("absolute inset-0 pointer-events-none rounded-[inherit] bg-gradient-to-br", TREND_HUE[tone])}
        />
    );
}

export type { TrendTone };
