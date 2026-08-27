// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface FieldGridContract {
    file: string;
    responsiveCount: number;
    allowedFixed?: string[];
}

const FIELD_GRID_CONTRACTS: FieldGridContract[] = [
    {
        file: "src/features/transactions/components/AddTransactionDialog.tsx",
        responsiveCount: 2,
    },
    {
        file: "src/features/planned/PlannedPaymentForm.tsx",
        responsiveCount: 4,
        allowedFixed: ["grid grid-cols-2 gap-2"],
    },
    {
        file: "src/features/tax/profile-steps/IncomeStep.tsx",
        responsiveCount: 3,
    },
    { file: "src/features/accounts/AddAccountDialog.tsx", responsiveCount: 4 },
    {
        file: "src/features/portfolio/InvestmentFormFields.tsx",
        responsiveCount: 6,
    },
    {
        file: "src/features/portfolio/PriceProviderFields.tsx",
        responsiveCount: 1,
    },
    {
        file: "src/features/portfolio/PortfolioTxnFormFields.tsx",
        responsiveCount: 2,
    },
    {
        file: "src/features/reports/ExportDialog.tsx",
        responsiveCount: 1,
        allowedFixed: ["grid grid-cols-3 gap-2"],
    },
    { file: "src/features/accounts/ReconcileDialog.tsx", responsiveCount: 1 },
    {
        file: "src/features/statistics/CustomChartBuilderModal.tsx",
        responsiveCount: 1,
    },
    {
        file: "src/features/portfolio/EditInvestmentDialog.tsx",
        responsiveCount: 1,
    },
    {
        file: "src/features/portfolio/AddToWatchlistDialog.tsx",
        responsiveCount: 1,
    },
    {
        file: "src/features/portfolio/AddInvestmentFromMarketDialog.tsx",
        responsiveCount: 1,
    },
    {
        file: "src/features/settings/sections/AppearanceSection.tsx",
        responsiveCount: 1,
    },
];

function readSource(file: string): string {
    return readFileSync(join(process.cwd(), file), "utf8");
}

function literalClassNames(source: string): string[] {
    return [...source.matchAll(/className="([^"]+)"/g)].map(
        (match) => match[1],
    );
}

describe("responsive layout contract", () => {
    it.each(FIELD_GRID_CONTRACTS)(
        "keeps dialog field grids responsive in $file",
        ({ file, responsiveCount, allowedFixed = [] }) => {
            const classes = literalClassNames(readSource(file));
            const responsive = classes.filter((value) =>
                value
                    .split(/\s+/)
                    .some((token) => /^sm:grid-cols-[23]$/.test(token)),
            );
            const fixed = classes.filter((value) =>
                value
                    .split(/\s+/)
                    .some((token) => /^grid-cols-[23]$/.test(token)),
            );
            expect(responsive).toHaveLength(responsiveCount);
            expect(fixed).toEqual(allowedFixed);
        },
    );

    it("lets a lone configurable widget fill its desktop row", () => {
        expect(readSource("src/pages/DashboardPage.tsx")).toContain(
            "lg:[&>*:only-child]:col-span-5",
        );
        expect(readSource("src/pages/StatisticsPage.tsx")).toContain(
            "lg:[&>*:only-child]:col-span-2",
        );
        const portfolio = readSource(
            "src/pages/portfolio/PortfolioOverviewPage.tsx",
        );
        expect(portfolio).toContain("lg:[&>*:only-child]:col-span-2");
        expect(portfolio).toContain("lg:[&>*:only-child]:col-span-3");
    });

    it("widens the import page without changing its one-column order", () => {
        const source = readSource("src/pages/ImportPage.tsx");
        expect(source).toContain('<PageShell className="max-w-4xl mx-auto">');
        expect(source).not.toContain("max-w-2xl mx-auto");
    });
});
