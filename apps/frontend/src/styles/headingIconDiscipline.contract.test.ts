import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("heading icon discipline", () => {
    it("keeps the shared chart header icon-free", () => {
        const chartCard = source("components/charts/ChartCard.tsx");
        expect(chartCard).not.toContain("readonly icon?");
        expect(chartCard).not.toContain("icon: Icon");
        expect(chartCard).not.toContain("{Icon ?");
    });

    it("does not restore known decorative heading icons", () => {
        const residues: Array<[string, RegExp]> = [
            [
                "pages/DashboardPage.tsx",
                /TrendingDown className="h-5 w-5"|Tags className="h-5 w-5"/,
            ],
            [
                "features/dashboard/CashFlowForecastChart.tsx",
                /<Activity className="h-6 w-6"/,
            ],
            [
                "features/dashboard/MonthlyTrendsChart.tsx",
                /<TrendingUp className="h-6 w-6"/,
            ],
            [
                "features/dashboard/BankBalancesWidget.tsx",
                /<Landmark className="h-5 w-5 text-primary"/,
            ],
            [
                "pages/research/MarketLookupPage.tsx",
                /<BarChart3 className="h-4 w-4"/,
            ],
            [
                "features/tax/MultiYearTrendStrip.tsx",
                /<TrendingUp[^>]*>.*tax\.trendStrip/s,
            ],
            ["features/tax/YearComparisonCard.tsx", /<GitCompare/],
            ["features/imports/ImportHistoryCard.tsx", /<History/],
            ["features/planned/NextSevenDaysStrip.tsx", /<CalendarClock/],
        ];
        for (const [path, pattern] of residues) {
            expect(source(path), path).not.toMatch(pattern);
        }
    });
});
