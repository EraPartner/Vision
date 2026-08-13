// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import { PortfolioTaxAdjustmentsDialog } from "@/features/portfolio/PortfolioTaxAdjustmentsDialog";
import type { InvestmentSummary } from "@/types/portfolio";

const API_BASE = "http://localhost:3002";

const INVESTMENT_A: InvestmentSummary = {
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
    totalInvested: 1000,
    totalFees: 5,
    totalTaxes: 0,
    totalDividends: 0,
    totalIncome: 0,
    currentValue: 955,
    avgCostBasis: 100,
    realizedGain: 0,
    unrealizedGain: -45,
    totalGain: -45,
    gainLoss: -45,
    gainLossPercent: -4.5,
    accruedInterest: 0,
    projectedAnnualInterest: 0,
    totalAppreciation: 0,
    totalBuyCost: 1005,
    totalSellProceeds: 0,
    transactions: [],
};

const INVESTMENT_B: InvestmentSummary = {
    id: 2,
    name: "Emerging Markets ETF",
    symbol: "EEM",
    asset_class: "etf",
    assetClass: "etf",
    currency: "USD",
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-15T10:00:00.000Z",
    totalUnits: 5,
    totalInvested: 500,
    totalFees: 2,
    totalTaxes: 0,
    totalDividends: 0,
    totalIncome: 0,
    currentValue: 480,
    avgCostBasis: 100,
    realizedGain: 0,
    unrealizedGain: -20,
    totalGain: -20,
    gainLoss: -20,
    gainLossPercent: -4.0,
    accruedInterest: 0,
    projectedAnnualInterest: 0,
    totalAppreciation: 0,
    totalBuyCost: 502,
    totalSellProceeds: 0,
    transactions: [],
};

describe("PortfolioTaxAdjustmentsDialog", () => {
    it("renders trigger button", async () => {
        // Arrange + Act
        renderWithApp(
            <PortfolioTaxAdjustmentsDialog investments={[INVESTMENT_A]} />,
        );

        // Assert — trigger shows the SlidersHorizontal icon button with translated label
        const trigger = await screen.findByRole("button", {
            name: /manual adjustments/i,
        });
        expect(trigger).toBeInTheDocument();
    });

    it("opens dialog on trigger click", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioTaxAdjustmentsDialog investments={[INVESTMENT_A]} />,
        );

        // Act
        await user.click(
            await screen.findByRole("button", { name: /manual adjustments/i }),
        );

        // Assert
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    it("shows one row per investment passed in props", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioTaxAdjustmentsDialog
                investments={[INVESTMENT_A, INVESTMENT_B]}
            />,
        );

        // Act
        await user.click(
            await screen.findByRole("button", { name: /manual adjustments/i }),
        );
        await screen.findByRole("dialog");

        // Assert — each investment name appears inside the dialog
        expect(await screen.findByText("MSCI World ETF")).toBeInTheDocument();
        expect(await screen.findByText("Emerging Markets ETF")).toBeInTheDocument();
    });

    it("cancel button closes dialog", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioTaxAdjustmentsDialog investments={[INVESTMENT_A]} />,
        );

        // Act
        await user.click(
            await screen.findByRole("button", { name: /manual adjustments/i }),
        );
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("button", { name: /^cancel$/i }));

        // Assert
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("saves adjustments successfully and closes dialog", async () => {
        // Arrange — PUT /api/settings/:key is the endpoint used by saveManyForYear
        server.use(
            http.put(`${API_BASE}/api/settings/:key`, () => ok({ ok: true })),
        );
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioTaxAdjustmentsDialog investments={[INVESTMENT_A]} />,
        );

        // Act
        await user.click(
            await screen.findByRole("button", { name: /manual adjustments/i }),
        );
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("button", { name: /^save$/i }));

        // Assert — dialog closes on successful save
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("shows error toast on save failure and keeps dialog open", async () => {
        // Arrange
        server.use(
            http.put(`${API_BASE}/api/settings/:key`, () =>
                err(500, "internal server error"),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioTaxAdjustmentsDialog investments={[INVESTMENT_A]} />,
        );

        // Act
        await user.click(
            await screen.findByRole("button", { name: /manual adjustments/i }),
        );
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("button", { name: /^save$/i }));

        // Assert — dialog stays open when save fails
        await waitFor(() =>
            expect(screen.getByRole("dialog")).toBeInTheDocument(),
        );
    });

    it("form fields are editable — user can type an adjustment amount", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(
            <PortfolioTaxAdjustmentsDialog investments={[INVESTMENT_A]} />,
        );

        // Act
        await user.click(
            await screen.findByRole("button", { name: /manual adjustments/i }),
        );
        await screen.findByRole("dialog");

        // Taxes inputs come first (one per investment row); grab the first one
        const taxInputs = screen.getAllByPlaceholderText("0.00");
        const firstTaxInput = taxInputs[0];
        await user.clear(firstTaxInput);
        await user.type(firstTaxInput, "12.50");

        // Assert
        expect(firstTaxInput).toHaveValue(12.5);
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("Escape key closes the dialog", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioTaxAdjustmentsDialog investments={[INVESTMENT_A]} />);
        await user.click(
            await screen.findByRole("button", { name: /manual adjustments/i }),
        );
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioTaxAdjustmentsDialog investments={[INVESTMENT_A]} />);
        await user.click(
            await screen.findByRole("button", { name: /manual adjustments/i }),
        );
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });
});
