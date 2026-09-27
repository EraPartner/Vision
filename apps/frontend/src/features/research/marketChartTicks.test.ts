import { describe, expect, it } from "vitest";
import { formatMarketChartTick } from "./marketChartTicks";

describe("market chart axis dates", () => {
    const time = new Date(2026, 8, 26, 14, 30).getTime();
    it.each(["5d", "1mo", "3mo", "6mo"])(
        "keeps %s ticks short without losing the day",
        (range) => {
            expect(formatMarketChartTick(time, range, "en-GB")).toBe("26 Sept");
        },
    );
    it.each(["1y", "5y", "max"])("keeps the year for %s charts", (range) => {
        expect(formatMarketChartTick(time, range, "en-GB")).toBe("Sept 26");
    });
    it("uses time for intraday ticks and localized month labels", () => {
        expect(formatMarketChartTick(time, "1d", "en-GB")).toBe("14:30");
        expect(formatMarketChartTick(time, "1mo", "nl-BE")).toBe(
            new Date(time).toLocaleDateString("nl-BE", {
                day: "numeric",
                month: "short",
            }),
        );
    });
});
