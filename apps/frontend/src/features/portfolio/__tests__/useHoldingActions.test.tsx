// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { useHoldingActions } from "../useHoldingActions";
import type { InvestmentSummary } from "@/types/portfolio";

const portfolio = vi.hoisted(() => ({ holdings: [] as InvestmentSummary[] }));
vi.mock("@/hooks/usePortfolio", () => ({
    usePortfolio: () => ({
        allSummaries: portfolio.holdings,
        transactions: portfolio.holdings.flatMap(
            (holding) => holding.transactions,
        ),
        deleteInvestment: vi.fn(),
        updateInvestment: vi.fn(),
        addTransaction: vi.fn(),
        updateTransaction: vi.fn(),
        deleteTransaction: vi.fn(),
    }),
}));

const virtualWindow = vi.hoisted(() => ({ measured: true }));

// jsdom has no layout: the transactions list's scroll box measures 0px tall, so
// the real virtualizer mounts no rows at all. Render every item instead, the
// same stand-in VirtualDataTable's tests use, so these keep asserting the row
// markup and behaviour rather than the virtual window.
vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({
        count,
        estimateSize,
    }: {
        count: number;
        estimateSize: () => number;
    }) => ({
        getVirtualItems: () =>
            Array.from(
                { length: virtualWindow.measured ? count : 0 },
                (_, i) => ({
                    key: i,
                    index: i,
                    start: i * estimateSize(),
                    end: (i + 1) * estimateSize(),
                    size: estimateSize(),
                }),
            ),
        getTotalSize: () => count * estimateSize(),
        measureElement: vi.fn(),
        scrollToIndex: vi.fn(),
    }),
}));

const TXN = {
    id: 101,
    investment_id: 1,
    type: "buy" as const,
    date: "2025-01-10",
    amount: 900,
    units: 10,
    price_per_unit: 90,
    fees: 2.5,
    taxes: 0,
    currency: "EUR",
    fx_rate_to_eur: 1,
    note: "Initial buy",
    is_recurring: false,
    created_at: "2025-01-10T10:00:00Z",
    updated_at: "2025-01-10T10:00:00Z",
};

const INVESTMENT: InvestmentSummary = {
    id: 1,
    name: "MSCI World ETF",
    symbol: "IWDA",
    asset_class: "etf",
    assetClass: "etf",
    currency: "EUR",
    current_price: 95.5,
    currentPrice: 95.5,
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-15T10:00:00.000Z",
    totalUnits: 10,
    totalInvested: 900,
    totalFees: 2.5,
    totalTaxes: 0,
    totalDividends: 0,
    totalIncome: 0,
    currentValue: 955,
    avgCostBasis: 90,
    realizedGain: 0,
    unrealizedGain: 55,
    totalGain: 55,
    gainLoss: 55,
    gainLossPercent: 6.1,
    accruedInterest: 0,
    projectedAnnualInterest: 0,
    totalAppreciation: 0,
    totalBuyCost: 902.5,
    totalSellProceeds: 0,
    transactions: [TXN],
};

function Harness() {
    const { dialogs, renderMenu } = useHoldingActions({
        deleteTitleKey: "common.delete",
        deleteDescriptionKey: "common.delete",
    });
    return (
        <>
            {portfolio.holdings.map((holding) => (
                <div key={holding.id}>{renderMenu(holding)}</div>
            ))}
            {dialogs}
        </>
    );
}

beforeEach(() => {
    portfolio.holdings = [INVESTMENT];
});

async function openDetails(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
        await screen.findByRole("button", {
            name: "Actions for MSCI World ETF",
        }),
    );
    await user.click(
        await screen.findByRole("menuitem", { name: /^details$/i }),
    );
    return screen.findByRole("dialog", { name: "MSCI World ETF" });
}

describe("holding detail refresh", () => {
    it("refreshes totals and edited, added, and deleted transactions while keeping the detail window open", async () => {
        const user = userEvent.setup();
        const view = renderWithApp(<Harness />);
        const dialog = await openDetails(user);
        const units = () =>
            within(dialog).getByText("Units held").closest("div");
        expect(units()).toHaveTextContent("10");
        portfolio.holdings = [
            {
                ...INVESTMENT,
                totalUnits: 20,
                transactions: [{ ...TXN, units: 20, note: "Updated buy" }],
            },
        ];
        view.rerender(<Harness />);
        expect(units()).toHaveTextContent("20");
        await user.click(
            within(dialog).getByRole("tab", { name: /transactions/i }),
        );
        expect(
            await within(dialog).findByText("Updated buy"),
        ).toBeInTheDocument();
        expect(
            within(dialog).queryByText("Initial buy"),
        ).not.toBeInTheDocument();
        portfolio.holdings = [
            {
                ...portfolio.holdings[0],
                transactions: [
                    ...portfolio.holdings[0].transactions,
                    { ...TXN, id: 102, note: "Added buy" },
                ],
            },
        ];
        view.rerender(<Harness />);
        expect(
            await within(dialog).findByText("Added buy"),
        ).toBeInTheDocument();
        portfolio.holdings = [
            {
                ...portfolio.holdings[0],
                transactions: [{ ...TXN, id: 102, note: "Added buy" }],
            },
        ];
        view.rerender(<Harness />);
        expect(
            within(dialog).queryByText("Updated buy"),
        ).not.toBeInTheDocument();
        expect(within(dialog).getByText("Added buy")).toBeInTheDocument();
    });

    it("keeps the selected holding when summaries reorder and removes a deleted holding's dialog", async () => {
        const user = userEvent.setup();
        const view = renderWithApp(<Harness />);
        await openDetails(user);
        portfolio.holdings = [
            { ...INVESTMENT, id: 2, name: "Other holding" },
            { ...INVESTMENT, name: "Renamed holding", is_active: false },
        ];
        view.rerender(<Harness />);
        expect(
            await screen.findByRole("dialog", { name: "Renamed holding" }),
        ).toBeInTheDocument();
        portfolio.holdings = [portfolio.holdings[0]];
        view.rerender(<Harness />);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
});
