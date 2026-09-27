/** Compact axis labels; full timestamps remain available in chart tooltips. */
export function formatMarketChartTick(
    timestamp: number,
    range: string,
    locale: string,
): string {
    const date = new Date(timestamp);
    if (range === "1d") {
        return date.toLocaleTimeString(locale, {
            hour: "2-digit",
            minute: "2-digit",
        });
    }
    return date.toLocaleDateString(
        locale,
        range === "1y" || range === "5y" || range === "max"
            ? { month: "short", year: "2-digit" }
            : { day: "numeric", month: "short" },
    );
}
