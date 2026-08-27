// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithApp } from "@/test/renderWithApp";
import { TotalValueCard, type TotalValueCardProps } from "@/features/portfolio/TotalValueCard";

const baseProps: TotalValueCardProps = {
    formattedTotal: "€12,345",
    totalValue: 12_345,
    labels: {
        title: "Portfolio Value",
        investments: "3 investments",
        assetSplit: "Allocation",
        bestPerformer: "Best performer",
        worstPerformer: "Worst performer",
        sparkline: "Last 30 days",
    },
    allocation: [],
    formatCurrency: (value) => `€${value}`,
};

describe("TotalValueCard", () => {
    it("renders the canonical headline with optional page-specific details", () => {
        renderWithApp(
            <TotalValueCard
                {...baseProps}
                headlineDetails={<p>Invested and FX details</p>}
            />,
        );

        expect(screen.getByText("Portfolio Value")).toBeInTheDocument();
        expect(screen.getByText("€12,345")).toBeInTheDocument();
        expect(screen.getByText("3 investments")).toBeInTheDocument();
        expect(screen.getByText("Invested and FX details")).toBeInTheDocument();
    });

    it("renders allocation, sparkline, and performer slots when supplied", () => {
        renderWithApp(
            <TotalValueCard
                {...baseProps}
                allocation={[
                    { name: "Stocks", value: 9_000 },
                    { name: "Crypto", value: 3_345 },
                ]}
                allocationTotal={12_345}
                showAllocationValues
                allocationFractionDigits={1}
                sparkline={[
                    { t: 1, v: 11_000 },
                    { t: 2, v: 12_345 },
                ]}
                bestPerformer={{
                    id: 1,
                    name: "World ETF",
                    symbol: "IWDA",
                    gainLossPercent: 12,
                    gainLossInTarget: 120,
                }}
                worstPerformer={{
                    id: 2,
                    name: "Bond Fund",
                    gainLossPercent: -2,
                    gainLossInTarget: -20,
                }}
            />,
        );

        expect(screen.getByText("Allocation")).toBeInTheDocument();
        expect(screen.getByText("Stocks")).toBeInTheDocument();
        expect(screen.getByText("Crypto")).toBeInTheDocument();
        expect(screen.getByText("€9000 (72.9%)")).toBeInTheDocument();
        expect(screen.getByText("Last 30 days")).toBeInTheDocument();
        expect(screen.getByText("Best performer")).toBeInTheDocument();
        expect(screen.getByText("Worst performer")).toBeInTheDocument();
        expect(screen.getByText("IWDA")).toBeInTheDocument();
        expect(screen.getByText("Bond Fund")).toBeInTheDocument();
    });

    it("keeps PerformancePage from defining a second TotalValueCard", () => {
        const source = readFileSync(join(
            process.cwd(),
            "src/pages/portfolio/PerformancePage.tsx",
        ), "utf8");
        expect(source).not.toMatch(/function TotalValueCard\s*\(/);
        expect(source).toContain('from "@/features/portfolio/TotalValueCard"');
    });

    it("keeps the Net Worth hero intrinsic instead of matching the breakdown height", () => {
        const source = readFileSync(join(
            process.cwd(),
            "src/pages/portfolio/net-worth/NetWorthPage.tsx",
        ), "utf8");
        expect(source).not.toContain("[&>*]:h-full");
        expect(source).not.toMatch(/lg:row-span-[23]/);
        expect(source).toContain('className="grid items-start gap-4 lg:grid-cols-2 animate-stagger"');
    });
});
