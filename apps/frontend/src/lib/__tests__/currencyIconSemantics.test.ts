// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const VALUE_SURFACES = [
    "src/pages/portfolio/StocksPage.tsx",
    "src/pages/portfolio/RealEstatePage.tsx",
    "src/pages/portfolio/SavingsPage.tsx",
    "src/features/dashboard/NetSummaryCard.tsx",
    "src/features/portfolio/InvestmentDetailDialog.tsx",
    "src/features/portfolio/TotalValueCard.tsx",
    "src/features/statistics/RecipientInsightsTab.tsx",
] as const;

function read(relativePath: string): string {
    return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("currency icon semantics", () => {
    it("uses a currency-neutral banknote for value metrics", () => {
        for (const file of VALUE_SURFACES) {
            const source = read(file);
            expect(source, file).not.toContain("DollarSign");
            expect(source, file).toContain("Banknote");
        }

        const performance = read("src/pages/portfolio/PerformancePage.tsx");
        expect(performance).not.toContain("DollarSign");
        expect(performance).toContain("<TotalValueCard");
    });

    it("uses the payment-specific icon for the owes action", () => {
        const source = read("src/features/splits/owes/RecipientOwesDetail.tsx");
        expect(source).not.toContain("DollarSign");
        expect(source).toContain("BanknoteCheck");
    });
});
