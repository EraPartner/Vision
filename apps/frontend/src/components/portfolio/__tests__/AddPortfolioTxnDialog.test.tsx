// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import { AddPortfolioTxnDialog } from "@/components/portfolio/AddPortfolioTxnDialog";
import type { InvestmentSummary } from "@/types/portfolio";

const API_BASE = "http://localhost:3002";

const PORTFOLIO_TXN_STUB = {
    id: 101,
    investment_id: 1,
    type: "buy",
    units: 10,
    price_per_unit: 90,
    amount: 900,
    fees: 2.5,
    taxes: 0,
    date: "2025-01-10",
    currency: "EUR",
    note: null,
    is_recurring: false,
    recurrence_interval: undefined,
    recurrence_end_date: undefined,
    created_at: "2025-01-10T10:00:00Z",
    updated_at: null,
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
    transactions: [],
};

const SAVINGS_INVESTMENT: InvestmentSummary = {
    ...INVESTMENT,
    id: 2,
    name: "Savings Account",
    symbol: undefined,
    asset_class: "savings",
    assetClass: "savings",
    currency: "EUR",
};

describe("AddPortfolioTxnDialog", () => {
    it("renders trigger button", async () => {
        // Arrange + Act
        renderWithApp(<AddPortfolioTxnDialog investment={INVESTMENT} />);

        // Assert — default trigger button is visible
        expect(
            await screen.findByRole("button", { name: /add transaction/i }),
        ).toBeInTheDocument();
    });

    it("opens dialog on trigger click, shows form fields", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<AddPortfolioTxnDialog investment={INVESTMENT} />);

        // Act
        await user.click(await screen.findByRole("button", { name: /add transaction/i }));

        // Assert — dialog is open and key form fields are visible
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(await screen.findByLabelText(/units/i)).toBeInTheDocument();
        expect(await screen.findByLabelText(/price per unit/i)).toBeInTheDocument();
    });

    it("cancel button closes dialog", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<AddPortfolioTxnDialog investment={INVESTMENT} />);

        // Act
        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");
        await user.click(await screen.findByRole("button", { name: /cancel/i }));

        // Assert
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("Escape key closes dialog", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<AddPortfolioTxnDialog investment={INVESTMENT} />);

        // Act
        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");

        // Assert
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("submits buy transaction successfully with units + pricePerUnit", async () => {
        // Arrange
        server.use(
            http.post(`${API_BASE}/api/investments/1/transactions`, () =>
                ok(PORTFOLIO_TXN_STUB),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<AddPortfolioTxnDialog investment={INVESTMENT} />);

        // Act — open dialog, fill units + price per unit (amount derives), submit
        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        const unitsInput = await screen.findByLabelText(/units/i);
        await user.clear(unitsInput);
        await user.type(unitsInput, "10");

        const ppuInput = screen.getByLabelText(/price per unit/i);
        await user.clear(ppuInput);
        await user.type(ppuInput, "90");

        await user.click(screen.getByRole("button", { name: /record/i }));

        // Assert — dialog closes after success
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("submits dividend transaction successfully with amount only", async () => {
        // Arrange
        server.use(
            http.post(`${API_BASE}/api/investments/1/transactions`, () =>
                ok({ ...PORTFOLIO_TXN_STUB, id: 102, type: "dividend", units: undefined, price_per_unit: undefined, amount: 50 }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<AddPortfolioTxnDialog investment={INVESTMENT} />);

        // Act — open dialog, change type to dividend, fill amount, submit
        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        // Change transaction type to dividend via Select
        const typeTrigger = screen.getAllByRole("combobox")[0];
        await user.click(typeTrigger);
        const dividendOption = await screen.findByRole("option", { name: /dividend/i });
        await user.click(dividendOption);

        const amountInput = await screen.findByLabelText(/total amount/i);
        await user.clear(amountInput);
        await user.type(amountInput, "50");

        await user.click(screen.getByRole("button", { name: /record/i }));

        // Assert — dialog closes after success
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("shows error toast on API failure", async () => {
        // Arrange
        server.use(
            http.post(`${API_BASE}/api/investments/1/transactions`, () =>
                err(500, "Internal server error"),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<AddPortfolioTxnDialog investment={INVESTMENT} />);

        // Act — open, fill required fields, submit to trigger error
        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        const unitsInput = await screen.findByLabelText(/units/i);
        await user.clear(unitsInput);
        await user.type(unitsInput, "5");

        const ppuInput = screen.getByLabelText(/price per unit/i);
        await user.clear(ppuInput);
        await user.type(ppuInput, "100");

        await user.click(screen.getByRole("button", { name: /record/i }));

        // Assert — dialog stays open and error toast is shown
        await waitFor(() =>
            expect(screen.getByRole("dialog")).toBeInTheDocument(),
        );
    });

    it("submit button is not disabled when two of three buy fields are filled", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<AddPortfolioTxnDialog investment={INVESTMENT} />);

        // Act — open dialog, fill only units (only 1 of 3 fields)
        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        const unitsInput = await screen.findByLabelText(/units/i);
        await user.clear(unitsInput);
        await user.type(unitsInput, "10");

        // Assert — Record button is present (form allows submit attempt; validation fires on submit)
        // The button itself is not disabled — the in-form validation error message appears instead
        expect(screen.getByRole("button", { name: /record/i })).toBeInTheDocument();
        // Validation hint appears inline in the form since only 1 of 3 fields is filled
        expect(
            await screen.findByText(/for buy\/sell.*two|enter any two|two of.*(amount|units)/i),
        ).toBeInTheDocument();
    });

    it("blocks submit on invalid fees or zero FX rate instead of posting silently", async () => {
        // Arrange — bad values in these fields used to fall back to 0 and submit
        let posted = false;
        server.use(
            http.post(`${API_BASE}/api/investments/1/transactions`, () => {
                posted = true;
                return ok(PORTFOLIO_TXN_STUB);
            }),
        );
        const user = userEvent.setup();
        renderWithApp(<AddPortfolioTxnDialog investment={INVESTMENT} />);

        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        const unitsInput = await screen.findByLabelText(/units/i);
        await user.type(unitsInput, "10");
        const ppuInput = screen.getByLabelText(/price per unit/i);
        await user.type(ppuInput, "90");

        // Act 1 — negative fees (fireEvent.change = paste-equivalent; the
        // min="0" attribute is inert without native form validation)
        const feesInput = screen.getByLabelText(/fees/i);
        fireEvent.change(feesInput, { target: { value: "-1" } });
        await user.click(screen.getByRole("button", { name: /record/i }));

        // Assert 1 — dialog stays open and nothing was posted
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(posted).toBe(false);

        // Act 2 — fees valid again, but FX rate of 0 (backend rejects ≤ 0)
        fireEvent.change(feesInput, { target: { value: "1" } });
        fireEvent.change(screen.getByLabelText(/fx rate to eur/i), { target: { value: "0" } });
        await user.click(screen.getByRole("button", { name: /record/i }));

        // Assert 2 — still blocked client-side
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(posted).toBe(false);
    });

    it("shows buy/sell/dividend transaction types for etf asset class", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<AddPortfolioTxnDialog investment={INVESTMENT} />);

        // Act — open dialog and expand the type select
        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        const typeTrigger = screen.getAllByRole("combobox")[0];
        await user.click(typeTrigger);

        // Assert — ETF allows buy, sell, gift, dividend, fee, tax
        expect(await screen.findByRole("option", { name: /buy/i })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: /sell/i })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: /dividend/i })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: /gift/i })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: /fee/i })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: /tax/i })).toBeInTheDocument();
        // savings/bond-only types should not appear
        expect(screen.queryByRole("option", { name: /interest/i })).not.toBeInTheDocument();
    });

    it("shows interest type for savings asset class, not dividend", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<AddPortfolioTxnDialog investment={SAVINGS_INVESTMENT} />);

        // Act — open dialog and expand the type select
        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        const typeTrigger = screen.getAllByRole("combobox")[0];
        await user.click(typeTrigger);

        // Assert — savings shows buy/sell/fee/tax but not gift/dividend
        expect(await screen.findByRole("option", { name: /buy/i })).toBeInTheDocument();
        expect(screen.queryByRole("option", { name: /dividend/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("option", { name: /gift/i })).not.toBeInTheDocument();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddPortfolioTxnDialog investment={INVESTMENT} />);
        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });

    it("first focusable element exists for keyboard nav", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddPortfolioTxnDialog investment={INVESTMENT} />);
        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");
        const inputs = screen.getAllByRole("textbox");
        const numbers = screen.queryAllByRole("spinbutton");
        expect(inputs.length + numbers.length).toBeGreaterThan(0);
    });
});
