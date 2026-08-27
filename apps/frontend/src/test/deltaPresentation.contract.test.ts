// @vitest-environment node

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("shared delta presentation", () => {
    it("uses DeltaPill on the quote and comparison surfaces", () => {
        for (const file of [
            "src/pages/research/ResearchHomePage.tsx",
            "src/pages/research/MarketLookupPage.tsx",
            "src/pages/research/WatchlistPage.tsx",
            "src/pages/research/ResearchComparePage.tsx",
            "src/features/statistics/InsightsDigestPanel.tsx",
        ]) {
            expect(read(file), file).toContain("<DeltaPill");
        }
        expect(
            read("src/pages/research/ResearchHomePage.tsx").match(
                /<DeltaPill/g,
            ),
        ).toHaveLength(2);
        const watchlist = read("src/pages/research/WatchlistPage.tsx");
        expect(watchlist).toMatch(/value=\{priceDiff!\}\s+invert/);
        expect(watchlist).toMatch(/value=\{sinceAddedPct\}/);
        const digest = read("src/features/statistics/InsightsDigestPanel.tsx");
        expect(digest).toMatch(
            /value=\{\s*finding\.percentChange\s*\}\s+invert/,
        );
    });

    it("keeps signed percent formatting on the shared locale-aware formatter", () => {
        const files = [
            "src/pages/research/ResearchHomePage.tsx",
            "src/pages/research/MarketLookupPage.tsx",
            "src/pages/research/WatchlistPage.tsx",
            "src/features/statistics/InsightsDigestPanel.tsx",
            "src/pages/portfolio/StocksPage.tsx",
            "src/features/portfolio/AddToWatchlistDialog.tsx",
            "src/features/statistics/RecipientInsightsTab.tsx",
            "src/pages/portfolio/net-worth/NetWorthPage.tsx",
            "src/pages/admin/AdminOverviewPage.tsx",
            "src/components/devtools/MetricsPanel.tsx",
        ];
        for (const file of files) {
            const source = read(file);
            expect(source, file).toContain("formatPercent");
        }
        expect(existsSync(join(process.cwd(), "src/utils/percent.ts"))).toBe(
            false,
        );
    });
});
