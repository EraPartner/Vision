/**
 * Chart palette — token-only colors for series cycling.
 * Always reference via `hsl(var(--chart-N))` so light/dark themes switch automatically.
 */
export const CHART_TOKEN_COLORS = [
    "hsl(var(--chart-1))",
    "hsl(var(--chart-2))",
    "hsl(var(--chart-3))",
    "hsl(var(--chart-4))",
    "hsl(var(--chart-5))",
    "hsl(var(--chart-6))",
    "hsl(var(--chart-7))",
    "hsl(var(--chart-8))",
] as const;

export function getChartColor(index: number): string {
    return CHART_TOKEN_COLORS[index % CHART_TOKEN_COLORS.length];
}

export const CHART_NEUTRAL = {
    grid: "hsl(var(--border))",
    axis: "hsl(var(--border))",
    label: "hsl(var(--muted-foreground))",
    foreground: "hsl(var(--foreground))",
    primary: "hsl(var(--primary))",
    accent: "hsl(var(--accent))",
    destructive: "hsl(var(--destructive))",
    background: "hsl(var(--background))",
    card: "hsl(var(--card))",
} as const;
