// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err, ACCOUNT_STUB } from "@/test/msw/handlers";
import { EditPortfolioTxnDialog } from "@/components/portfolio/EditPortfolioTxnDialog";
import type { InvestmentSummary } from "@/types/portfolio";
import type { PortfolioTransaction } from "@/types/api";

const API_BASE = "http://localhost:3002";

const PORTFOLIO_TXN_STUB = {
    id: 101,
    investment_id: 1,
    type: "buy" as const,
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

const TRANSACTION: PortfolioTransaction = {
    id: 101,
    investment_id: 1,
    type: "buy",
    date: "2025-01-10",
    amount: 900,
    units: 10,
    price_per_unit: 90,
    fees: 2.5,
    taxes: 0,
    currency: "EUR",
    note: "Initial purchase",
    is_recurring: false,
    created_at: "2025-01-10T10:00:00Z",
    updated_at: "2025-01-10T10:00:00Z",
};

describe("EditPortfolioTxnDialog", () => {
    it("renders trigger button", async () => {
        // Arrange + Act
        renderWithApp(
            <EditPortfolioTxnDialog investment={INVESTMENT} transaction={TRANSACTION} />,
        );

        // Assert — default trigger shows "Edit" text
        expect(
            await screen.findByRole("button", { name: /^edit$/i }),
        ).toBeInTheDocument();
    });

    it("opens dialog and form is pre-populated with transaction data", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(
            <EditPortfolioTxnDialog investment={INVESTMENT} transaction={TRANSACTION} />,
        );

        // Act
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");

        // Assert — pre-populated numeric fields
        const unitsInput = await screen.findByLabelText(/units/i);
        expect(unitsInput).toHaveValue("10");

        const ppuInput = screen.getByLabelText(/price per unit/i);
        expect(ppuInput).toHaveValue("90");

        const amountInput = screen.getByLabelText(/total amount/i);
        expect(amountInput).toHaveValue("900");
    });

    it("cancel button closes dialog", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(
            <EditPortfolioTxnDialog investment={INVESTMENT} transaction={TRANSACTION} />,
        );

        // Act
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
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
        renderWithApp(
            <EditPortfolioTxnDialog investment={INVESTMENT} transaction={TRANSACTION} />,
        );

        // Act
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");

        // Assert
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("submits updated transaction successfully and closes dialog", async () => {
        // Arrange
        server.use(
            http.patch(`${API_BASE}/api/investments/transactions/101`, () =>
                ok({ ...PORTFOLIO_TXN_STUB, units: 12, price_per_unit: 90, amount: 1080 }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(
            <EditPortfolioTxnDialog investment={INVESTMENT} transaction={TRANSACTION} />,
        );

        // Act — open, update units, submit
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");

        const unitsInput = await screen.findByLabelText(/units/i);
        await user.clear(unitsInput);
        await user.type(unitsInput, "12");

        // Clear amount so it derives from units * pricePerUnit
        const amountInput = screen.getByLabelText(/total amount/i);
        await user.clear(amountInput);

        await user.click(screen.getByRole("button", { name: /save/i }));

        // Assert — dialog closes after success
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("blocks submit when FX rate is 0 instead of sending a doomed PATCH", async () => {
        // Arrange — the backend rejects fx_rate_to_eur ≤ 0 with a raw 400;
        // min="0" on the input permits typing 0, so the dialog must catch it.
        let patched = false;
        server.use(
            http.patch(`${API_BASE}/api/investments/transactions/101`, () => {
                patched = true;
                return ok(PORTFOLIO_TXN_STUB);
            }),
        );
        const user = userEvent.setup();
        renderWithApp(
            <EditPortfolioTxnDialog investment={INVESTMENT} transaction={TRANSACTION} />,
        );

        // Act — open, set FX rate to 0, submit
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");
        fireEvent.change(screen.getByLabelText(/fx rate to eur/i), { target: { value: "0" } });
        await user.click(screen.getByRole("button", { name: /save/i }));

        // Assert — dialog stays open and nothing was sent
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(patched).toBe(false);
    });

    it("shows error toast on API failure and keeps dialog open", async () => {
        // Arrange
        server.use(
            http.patch(`${API_BASE}/api/investments/transactions/101`, () =>
                err(500, "Update failed"),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(
            <EditPortfolioTxnDialog investment={INVESTMENT} transaction={TRANSACTION} />,
        );

        // Act — open, keep existing valid values, submit
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");

        await user.click(screen.getByRole("button", { name: /save/i }));

        // Assert — dialog remains open
        await waitFor(() =>
            expect(screen.getByRole("dialog")).toBeInTheDocument(),
        );
    });

    it("pre-populates fees and taxes from transaction prop", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(
            <EditPortfolioTxnDialog investment={INVESTMENT} transaction={TRANSACTION} />,
        );

        // Act
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");

        // Assert — fees and taxes are populated (buy type shows fee/tax fields)
        const feesInput = await screen.findByLabelText(/fees/i);
        expect(feesInput).toHaveValue("2.5");

        const taxesInput = screen.getByLabelText(/taxes/i);
        expect(taxesInput).toHaveValue("0");
    });

    it("pre-populates note field from transaction prop", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(
            <EditPortfolioTxnDialog investment={INVESTMENT} transaction={TRANSACTION} />,
        );

        // Act
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");

        // Assert — note textarea has the value from the transaction
        const noteInput = await screen.findByLabelText(/note/i);
        expect(noteInput).toHaveValue("Initial purchase");
    });

    it("transaction type field is read-only (disabled input showing current type)", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(
            <EditPortfolioTxnDialog investment={INVESTMENT} transaction={TRANSACTION} />,
        );

        // Act
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");

        // Assert — type is displayed as a disabled input, not an editable select
        const typeInputs = screen.getAllByRole("textbox");
        const disabledTypeInput = typeInputs.find(
            (el) => el.getAttribute("disabled") !== null && /buy/i.test((el as HTMLInputElement).value),
        );
        expect(disabledTypeInput).toBeDefined();
        expect(disabledTypeInput).toBeDisabled();
    });

    it("submits dividend transaction with amount-only fields populated", async () => {
        // Arrange
        const dividendTxn: PortfolioTransaction = {
            ...TRANSACTION,
            id: 102,
            type: "dividend",
            amount: 25,
            units: undefined,
            price_per_unit: undefined,
            fees: 0,
            taxes: 0,
            note: undefined,
        };
        server.use(
            http.patch(`${API_BASE}/api/investments/transactions/102`, () =>
                ok({ ...dividendTxn, amount: 30 }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(
            <EditPortfolioTxnDialog investment={INVESTMENT} transaction={dividendTxn} />,
        );

        // Act — open, update amount, submit
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");

        const amountInput = await screen.findByLabelText(/total amount/i);
        await user.clear(amountInput);
        await user.type(amountInput, "30");

        await user.click(screen.getByRole("button", { name: /save/i }));

        // Assert — dialog closes
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("includes the lot's account_id in the PATCH payload (ADR-091)", async () => {
        // Arrange — a lot already assigned to account 5, surfaced by the picker.
        const assignedTxn: PortfolioTransaction = { ...TRANSACTION, account_id: 5 };
        let capturedBody: Record<string, unknown> | undefined;
        server.use(
            http.get(`${API_BASE}/api/accounts`, () =>
                ok({ items: [{ ...ACCOUNT_STUB, id: 5, name: "IBKR", display_name: "IBKR" }], total: 1 }),
            ),
            http.patch(`${API_BASE}/api/investments/transactions/101`, async ({ request }) => {
                capturedBody = (await request.json()) as Record<string, unknown>;
                return ok({ ...PORTFOLIO_TXN_STUB, account_id: 5 });
            }),
        );
        const user = userEvent.setup();
        renderWithApp(
            <EditPortfolioTxnDialog investment={INVESTMENT} transaction={assignedTxn} />,
        );

        // Act — open and save without touching the account selector.
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("button", { name: /save/i }));

        // Assert — the pre-populated account_id is sent through.
        await waitFor(() => expect(capturedBody).toBeDefined());
        expect(capturedBody?.account_id).toBe(5);
    });

    // ─── Unsaved edits survive dismissal ───────────────────────────────────

    /** The Radix overlay — clicking it is the "stray click next to the dialog". */
    const overlay = () =>
        document.querySelector<HTMLElement>(".fixed.inset-0.backdrop-blur-md")!;

    it("keeps unsaved edits when dismissed by an outside click", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(
            <EditPortfolioTxnDialog investment={INVESTMENT} transaction={TRANSACTION} />,
        );

        // Act — retype the units, then lose the dialog to a stray click
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");
        const unitsInput = await screen.findByLabelText(/units/i);
        await user.clear(unitsInput);
        await user.type(unitsInput, "42");
        await user.click(overlay());
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        await user.click(screen.getByRole("button", { name: /^edit$/i }));

        // Assert — the edit is still there, not reverted to the stored 10
        await screen.findByRole("dialog");
        expect(await screen.findByLabelText(/units/i)).toHaveValue("42");
    });

    it("re-seeds from the transaction when opened for a different one", async () => {
        // Arrange
        const user = userEvent.setup();
        const { rerender } = renderWithApp(
            <EditPortfolioTxnDialog investment={INVESTMENT} transaction={TRANSACTION} />,
        );

        // Act — dirty the form, dismiss, then point this instance at another txn
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");
        const unitsInput = await screen.findByLabelText(/units/i);
        await user.clear(unitsInput);
        await user.type(unitsInput, "42");
        await user.click(overlay());
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

        const otherTxn = { ...TRANSACTION, id: 202, units: 7, price_per_unit: 30, amount: 210 };
        rerender(<EditPortfolioTxnDialog investment={INVESTMENT} transaction={otherTxn} />);
        await user.click(screen.getByRole("button", { name: /^edit$/i }));

        // Assert — keeping input must never mean showing the previous txn's values
        await screen.findByRole("dialog");
        expect(await screen.findByLabelText(/units/i)).toHaveValue("7");
        expect(screen.getByLabelText(/total amount/i)).toHaveValue("210");
    });

    it("re-seeds a pristine dialog from the latest transaction data", async () => {
        // Arrange — same id, values changed underneath (a refetch after a save)
        const user = userEvent.setup();
        const { rerender } = renderWithApp(
            <EditPortfolioTxnDialog investment={INVESTMENT} transaction={TRANSACTION} />,
        );

        // Act
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");
        await user.click(overlay());
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

        rerender(
            <EditPortfolioTxnDialog
                investment={INVESTMENT}
                transaction={{ ...TRANSACTION, units: 15, price_per_unit: 60, amount: 900 }}
            />,
        );
        await user.click(screen.getByRole("button", { name: /^edit$/i }));

        // Assert — nothing was typed, so the fresh server values win
        await screen.findByRole("dialog");
        expect(await screen.findByLabelText(/units/i)).toHaveValue("15");
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        const user = userEvent.setup();
        renderWithApp(
            <EditPortfolioTxnDialog investment={INVESTMENT} transaction={TRANSACTION} />,
        );
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });

    it("first focusable element exists for keyboard nav", async () => {
        const user = userEvent.setup();
        renderWithApp(
            <EditPortfolioTxnDialog investment={INVESTMENT} transaction={TRANSACTION} />,
        );
        await user.click(await screen.findByRole("button", { name: /^edit$/i }));
        await screen.findByRole("dialog");
        const inputs = screen.getAllByRole("textbox");
        const numbers = screen.queryAllByRole("spinbutton");
        expect(inputs.length + numbers.length).toBeGreaterThan(0);
    });
});
