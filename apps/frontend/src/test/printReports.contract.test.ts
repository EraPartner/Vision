// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("route-scoped print reports", () => {
    it("enables shell print mode for exactly the three decided report routes", () => {
        const layout = read("src/components/layout/AppLayout.tsx");
        expect(layout).toContain('pathname === "/tax"');
        expect(layout).toContain('pathname === "/statistics"');
        expect(layout).toContain('pathname === "/portfolio/net-worth"');
        expect(layout).toContain(
            "data-print-report={isPrintReport || undefined}",
        );
        expect(layout.match(/pathname === "\/[^"]+"/g)).toEqual([
            'pathname === "/tax"',
            'pathname === "/statistics"',
            'pathname === "/portfolio/net-worth"',
        ]);
    });

    it("pins stable page and action hooks on each report", () => {
        const pages = [
            ["src/pages/TaxOverviewPage.tsx", 'data-print-page="tax"'],
            ["src/pages/StatisticsPage.tsx", 'data-print-page="statistics"'],
            [
                "src/pages/portfolio/net-worth/NetWorthPage.tsx",
                'data-print-page="net-worth"',
            ],
        ] as const;
        for (const [file, hook] of pages) {
            const source = read(file);
            expect(source, file).toContain(hook);
            expect(source, file).toContain("data-print-actions");
        }
    });

    it("hides shell chrome and flattens report materials only under print media", () => {
        const css = read("src/index.css");
        expect(css).toContain("@media print");
        expect(css).toContain("[data-print-report] .app-sidebar");
        expect(css).toContain("[data-print-page] .premium-frame");
        expect(css).toContain('html[data-print-report="true"] [role="dialog"]');
        expect(css).toContain("[data-print-page] .cv-auto");
        expect(css).toContain("content-visibility: visible !important");
        expect(css).toContain("contain-intrinsic-size: none !important");
    });
});
