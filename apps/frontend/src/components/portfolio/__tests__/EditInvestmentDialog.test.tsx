// @vitest-environment jsdom
import { describe, expect, it, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { toast } from "sonner";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err } from "@/test/msw/handlers";
import { EditInvestmentDialog } from "@/components/portfolio/EditInvestmentDialog";
import type { InvestmentSummary } from "@/types/portfolio";

const API_BASE = "http://localhost:3002";

const INVESTMENT: InvestmentSummary = {
    id: 1,
    name: "MSCI World ETF",
    symbol: "IWDA",
    asset_class: "etf",
    assetClass: "etf",
    currency: "EUR",
    current_price: 95.5,
    currentPrice: 95.5,
    price_provider: "yahoo",
    price_provider_id: "IWDA.AS",
    price_provider_url: undefined,
    price_provider_latest_url: undefined,
    price_provider_latest_path: undefined,
    price_provider_history_url: undefined,
    price_provider_history_path: "points",
    price_provider_history_ts_path: "timestamp_ms",
    price_provider_history_price_path: "price",
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

afterEach(() => vi.restoreAllMocks());

describe("EditInvestmentDialog", () => {
    it("renders trigger button", async () => {
        // Arrange + Act
        renderWithApp(<EditInvestmentDialog investment={INVESTMENT} />);

        // Assert — default trigger shows translated "Edit" text
        expect(
            await screen.findByRole("button", { name: /^edit$/i }),
        ).toBeInTheDocument();
    });

    it("pre-fills the NATIVE currency (originalCurrency), not the display currency", async () => {
        // On an InvestmentSummary `currency` is the app's display/target currency
        // (all amounts converted to it); the native currency is `originalCurrency`.
        // The editor must show/save the native one — otherwise a save overwrites
        // the real currency with the display currency.
        const user = userEvent.setup();
        const foreign: InvestmentSummary = { ...INVESTMENT, currency: "EUR", originalCurrency: "USD" };
        renderWithApp(<EditInvestmentDialog investment={foreign} />);

        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");

        // The currency field's displayed value is the native USD, not the EUR
        // display currency.
        const currencyField = screen.getByRole("combobox", { name: /currency/i });
        expect(currencyField).toHaveTextContent("USD");
        expect(currencyField).not.toHaveTextContent("EUR");
    });

    it("clicking trigger opens dialog", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<EditInvestmentDialog investment={INVESTMENT} />);

        // Act
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));

        // Assert
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    it("pre-populates name field with investment name", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<EditInvestmentDialog investment={INVESTMENT} />);

        // Act
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");

        // Assert
        expect(screen.getByDisplayValue("MSCI World ETF")).toBeInTheDocument();
    });

    it("pre-populates symbol field for unit-based asset", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<EditInvestmentDialog investment={INVESTMENT} />);

        // Act
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");

        // Assert — symbol field is pre-populated for ETF (unit-based)
        expect(screen.getByDisplayValue("IWDA")).toBeInTheDocument();
    });

    it("submitting valid form closes dialog", async () => {
        // Arrange — defaultHandlers stubs PATCH /api/investments/:id
        const user = userEvent.setup();
        renderWithApp(<EditInvestmentDialog investment={INVESTMENT} />);

        // Act
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("button", { name: /^save$/i }));

        // Assert
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("clearing symbol on unit-based asset shows error and keeps dialog open", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<EditInvestmentDialog investment={INVESTMENT} />);

        // Act — open, clear symbol, submit
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");

        const symbolInput = screen.getByDisplayValue("IWDA");
        await user.clear(symbolInput);

        await user.click(screen.getByRole("button", { name: /^save$/i }));

        // Assert — dialog stays open; symbol is required for unit-based assets
        await waitFor(() =>
            expect(screen.getByRole("dialog")).toBeInTheDocument(),
        );
    });

    it("whitespace-only name shows an error toast instead of silently no-oping the Save", async () => {
        const toastError = vi.spyOn(toast, "error");
        const user = userEvent.setup();
        renderWithApp(<EditInvestmentDialog investment={INVESTMENT} />);

        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");

        // `required` on the input blocks a truly EMPTY submit natively, but
        // whitespace passed it and the guard used to bare-return silently.
        const nameInput = screen.getByDisplayValue("MSCI World ETF");
        await user.clear(nameInput);
        await user.type(nameInput, "   ");

        await user.click(screen.getByRole("button", { name: /^save$/i }));

        // Dialog stays open and the user gets explicit feedback.
        await waitFor(() => expect(toastError).toHaveBeenCalledWith("Name is required"));
        expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("Cancel button closes dialog", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<EditInvestmentDialog investment={INVESTMENT} />);

        // Act
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("button", { name: /^cancel$/i }));

        // Assert
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("submit error keeps dialog open", async () => {
        // Arrange
        server.use(
            http.patch(`${API_BASE}/api/investments/:id`, () => err(500, "fail")),
        );
        const user = userEvent.setup();
        renderWithApp(<EditInvestmentDialog investment={INVESTMENT} />);

        // Act
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("button", { name: /^save$/i }));

        // Assert — dialog stays open because the PATCH errored
        await waitFor(() =>
            expect(screen.getByRole("dialog")).toBeInTheDocument(),
        );
    });

    it("Escape key closes dialog", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<EditInvestmentDialog investment={INVESTMENT} />);

        // Act
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");

        // Assert
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    // ─── Unsaved edits survive dismissal ───────────────────────────────────

    /** The Radix overlay — clicking it is the "stray click next to the dialog". */
    const overlay = () =>
        document.querySelector<HTMLElement>(".fixed.inset-0.modal-overlay")!;

    it("keeps unsaved edits when dismissed by an outside click", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<EditInvestmentDialog investment={INVESTMENT} />);

        // Act — rename, then lose the dialog to a stray click
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");
        const nameInput = screen.getByDisplayValue("MSCI World ETF");
        await user.clear(nameInput);
        await user.type(nameInput, "World Equity");
        await user.click(overlay());
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        await user.click(screen.getByRole("button", { name: /^edit$/i }));

        // Assert — the rename survived
        await screen.findByRole("dialog");
        expect(screen.getByDisplayValue("World Equity")).toBeInTheDocument();
    });

    it("re-seeds from the investment when opened for a different one", async () => {
        // Arrange
        const user = userEvent.setup();
        const { rerender } = renderWithApp(<EditInvestmentDialog investment={INVESTMENT} />);

        // Act — dirty the form, dismiss, then point this instance at another holding
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");
        const nameInput = screen.getByDisplayValue("MSCI World ETF");
        await user.clear(nameInput);
        await user.type(nameInput, "World Equity");
        await user.click(overlay());
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

        const other: InvestmentSummary = { ...INVESTMENT, id: 99, name: "Gold ETC", symbol: "SGLN" };
        rerender(<EditInvestmentDialog investment={other} />);
        await user.click(screen.getByRole("button", { name: /^edit$/i }));

        // Assert — keeping input must never mean editing the wrong holding
        await screen.findByRole("dialog");
        expect(screen.getByDisplayValue("Gold ETC")).toBeInTheDocument();
        expect(screen.queryByDisplayValue("World Equity")).not.toBeInTheDocument();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        const user = userEvent.setup();
        renderWithApp(<EditInvestmentDialog investment={INVESTMENT} />);
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });

    it("first focusable element exists for keyboard nav", async () => {
        const user = userEvent.setup();
        renderWithApp(<EditInvestmentDialog investment={INVESTMENT} />);
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");
        const inputs = screen.getAllByRole("textbox");
        expect(inputs.length).toBeGreaterThan(0);
    });
});
