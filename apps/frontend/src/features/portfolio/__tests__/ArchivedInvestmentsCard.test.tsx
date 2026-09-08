// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { ArchivedInvestmentsCard } from "@/features/portfolio/ArchivedInvestmentsCard";
import type { InvestmentSummary } from "@/types/portfolio";

const ARCHIVED_INVESTMENT = {
    id: 9,
    name: "Former holding",
    symbol: "OLD",
    asset_class: "stock",
    assetClass: "stock",
    currency: "EUR",
    originalCurrency: "EUR",
    current_price: 10,
    currentPrice: 10,
    is_active: false,
    totalUnits: 0,
    totalInvested: 0,
    totalFees: 0,
    totalTaxes: 0,
    totalDividends: 0,
    totalIncome: 0,
    currentValue: 0,
    avgCostBasis: 0,
    realizedGain: 5,
    unrealizedGain: 0,
    totalGain: 5,
    gainLoss: 5,
    gainLossPercent: 0,
    accruedInterest: 0,
    projectedAnnualInterest: 0,
    totalAppreciation: 0,
    totalBuyCost: 0,
    totalSellProceeds: 0,
    transactions: [{ id: 1 }, { id: 2 }],
} as InvestmentSummary;

const t = (key: string, params?: Record<string, string | number>) => {
    const values: Record<string, string> = {
        "portfolio.archivedInvestments": "Archived investments",
        "portfolio.archivedInvestmentsDesc": "Review past holdings",
        "portfolio.archived": "Archived",
        "portfolio.archivedHistory": `History entries: ${params?.count}`,
        "portfolio.restoreInvestment": "Restore",
    };
    return values[key] ?? key;
};

it("discovers archived investments and restores the selected holding", async () => {
    const onRestore = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithApp(
        <ArchivedInvestmentsCard
            investments={[ARCHIVED_INVESTMENT]}
            onRestore={onRestore}
            t={t}
        />,
    );

    expect(screen.queryByText("Former holding")).not.toBeInTheDocument();
    await user.click(
        screen.getByRole("button", { name: /archived investments/i }),
    );
    expect(screen.getByText("Former holding")).toBeInTheDocument();
    expect(screen.getByText("History entries: 2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^restore$/i }));
    expect(onRestore).toHaveBeenCalledWith(9);
});

it("uses count-neutral history wording for one entry", async () => {
    const user = userEvent.setup();
    renderWithApp(
        <ArchivedInvestmentsCard
            investments={[
                {
                    ...ARCHIVED_INVESTMENT,
                    transactions: [ARCHIVED_INVESTMENT.transactions[0]],
                },
            ]}
            onRestore={vi.fn()}
            t={t}
        />,
    );

    await user.click(
        screen.getByRole("button", { name: /archived investments/i }),
    );
    expect(screen.getByText("History entries: 1")).toBeInTheDocument();
});

it("does not render an empty archived section", () => {
    const { container } = renderWithApp(
        <ArchivedInvestmentsCard investments={[]} onRestore={vi.fn()} t={t} />,
    );
    expect(container).toBeEmptyDOMElement();
});
