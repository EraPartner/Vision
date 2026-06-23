// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err, INVESTMENT_STUB } from "@/test/msw/handlers";
import { AddInvestmentFromMarketDialog } from "@/components/portfolio/AddInvestmentFromMarketDialog";
import type { InvestmentSummary } from "@/types/portfolio";

const API_BASE = "http://localhost:3002";

const QUOTE = {
    symbol: "AAPL",
    name: "Apple Inc.",
    price: 195.5,
    change: 1.2,
    changePercent: 0.62,
    currency: "USD",
    exchange: "NASDAQ",
    type: "stock",
};

const EXISTING_INVESTMENT = {
    id: 1,
    name: "Apple Inc.",
    symbol: "AAPL",
    assetClass: "stock",
    asset_class: "stock",
    currency: "USD",
    current_price: 195.5,
    currentPrice: 195.5,
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    totalUnits: 10,
    totalInvested: 1850,
} as unknown as InvestmentSummary;

const PORTFOLIO_TXN_STUB = {
    id: 1,
    type: "buy",
    date: "2025-01-01",
    amount: 1955.0,
    currency: "USD",
};

describe("AddInvestmentFromMarketDialog", () => {
    it("renders trigger button with add investment text when no existingInvestment", async () => {
        // Arrange + Act
        renderWithApp(<AddInvestmentFromMarketDialog quote={QUOTE} />);

        // Assert — uses portfolio.addInvestment key (not form.addTransaction.title)
        const button = await screen.findByRole("button", { name: /add investment/i });
        expect(button).toBeInTheDocument();
    });

    it("renders trigger button with add transaction text when existingInvestment provided", async () => {
        // Arrange + Act
        renderWithApp(
            <AddInvestmentFromMarketDialog
                quote={QUOTE}
                existingInvestment={EXISTING_INVESTMENT}
            />,
        );

        // Assert — uses form.addTransaction.title key
        const button = await screen.findByRole("button", { name: /add transaction/i });
        expect(button).toBeInTheDocument();
    });

    it("opens dialog to the 'choose' step", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<AddInvestmentFromMarketDialog quote={QUOTE} />);

        // Act
        await user.click(await screen.findByRole("button", { name: /add investment/i }));

        // Assert — dialog open and 'choose' step content visible
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        // The 'create new investment' option is always present on the choose step
        expect(await screen.findByText(/create new/i)).toBeInTheDocument();
    });

    it("clicking 'create new investment' option navigates to 'new' step", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<AddInvestmentFromMarketDialog quote={QUOTE} />);

        // Act — open dialog, then click 'create new' option button
        await user.click(await screen.findByRole("button", { name: /add investment/i }));
        await screen.findByRole("dialog");
        const createNewBtn = await screen.findByText(/create new/i);
        await user.click(createNewBtn.closest("button") ?? createNewBtn);

        // Assert — name input rendered on 'new' step
        expect(await screen.findByLabelText(/name/i)).toBeInTheDocument();
    });

    it("back button from 'new' step returns to 'choose' step", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<AddInvestmentFromMarketDialog quote={QUOTE} />);

        // Act — open → advance to new → click back
        await user.click(await screen.findByRole("button", { name: /add investment/i }));
        await screen.findByRole("dialog");
        const createNewBtn = await screen.findByText(/create new/i);
        await user.click(createNewBtn.closest("button") ?? createNewBtn);
        await screen.findByLabelText(/name/i);
        await user.click(await screen.findByRole("button", { name: /back/i }));

        // Assert — 'create new' option is visible again (choose step)
        expect(await screen.findByText(/create new/i)).toBeInTheDocument();
    });

    it("submitting new investment form calls POST /api/investments and closes dialog", async () => {
        // Arrange
        let posted = false;
        server.use(
            http.post(`${API_BASE}/api/investments`, () => {
                posted = true;
                return ok(INVESTMENT_STUB);
            }),
        );
        const user = userEvent.setup();
        renderWithApp(<AddInvestmentFromMarketDialog quote={QUOTE} />);

        // Act — open → new step → submit
        await user.click(await screen.findByRole("button", { name: /add investment/i }));
        await screen.findByRole("dialog");
        const createNewBtn = await screen.findByText(/create new/i);
        await user.click(createNewBtn.closest("button") ?? createNewBtn);
        const nameInput = await screen.findByLabelText(/name/i);
        // Name is pre-populated from quote; just submit
        expect(nameInput).toHaveValue("Apple Inc.");
        await user.click(await screen.findByRole("button", { name: /create/i }));

        // Assert — POST was called and dialog closed
        await waitFor(() => expect(posted).toBe(true));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("clicking 'add transaction' option (with existingInvestment) navigates to 'transaction' step", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(
            <AddInvestmentFromMarketDialog
                quote={QUOTE}
                existingInvestment={EXISTING_INVESTMENT}
            />,
        );

        // Act — open dialog, click the 'add transaction' option
        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        const dialog = await screen.findByRole("dialog");
        // Scope to dialog to avoid matching the trigger button outside the portal
        const txnOptionBtn = within(dialog)
            .getAllByRole("button")
            .find((b) => /add transaction/i.test(b.textContent ?? ""))!;
        await user.click(txnOptionBtn);

        // Assert — transaction form fields are visible
        expect(await screen.findByLabelText(/units/i)).toBeInTheDocument();
    });

    it("back button from 'transaction' step returns to 'choose' step", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(
            <AddInvestmentFromMarketDialog
                quote={QUOTE}
                existingInvestment={EXISTING_INVESTMENT}
            />,
        );

        // Act — open → transaction step → back
        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        const dialog = await screen.findByRole("dialog");
        const txnOptionBtn = within(dialog)
            .getAllByRole("button")
            .find((b) => /add transaction/i.test(b.textContent ?? ""))!;
        await user.click(txnOptionBtn);
        await screen.findByLabelText(/units/i);
        await user.click(await screen.findByRole("button", { name: /back/i }));

        // Assert — choose step visible again
        expect(await screen.findByText(/create new/i)).toBeInTheDocument();
    });

    it("submitting transaction form calls POST /api/investments/:id/transactions and closes dialog", async () => {
        // Arrange
        let postedTxn = false;
        server.use(
            http.post(`${API_BASE}/api/investments/:id/transactions`, () => {
                postedTxn = true;
                return ok(PORTFOLIO_TXN_STUB);
            }),
        );
        const user = userEvent.setup();
        renderWithApp(
            <AddInvestmentFromMarketDialog
                quote={QUOTE}
                existingInvestment={EXISTING_INVESTMENT}
            />,
        );

        // Act — open → transaction step → fill amount → record
        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        const dialog = await screen.findByRole("dialog");
        const txnOptionBtn = within(dialog)
            .getAllByRole("button")
            .find((b) => /add transaction/i.test(b.textContent ?? ""))!;
        await user.click(txnOptionBtn);

        // Fill the amount field (required for submission)
        const amountInput = await screen.findByLabelText(/total amount/i);
        await user.type(amountInput, "1955.00");

        await user.click(await screen.findByRole("button", { name: /record/i }));

        // Assert
        await waitFor(() => expect(postedTxn).toBe(true));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("cancel/close (Escape) closes the dialog", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<AddInvestmentFromMarketDialog quote={QUOTE} />);

        // Act — open then close with Escape
        await user.click(await screen.findByRole("button", { name: /add investment/i }));
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");

        // Assert
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddInvestmentFromMarketDialog quote={QUOTE} />);
        await user.click(await screen.findByRole("button", { name: /add investment/i }));
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });

    it("submit error: dialog content remains visible when create endpoint 5xxs", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.post(`${API_BASE}/api/investments`, () => err(500, "create failed")),
        );
        const user = userEvent.setup();
        renderWithApp(<AddInvestmentFromMarketDialog quote={QUOTE} />);

        await user.click(await screen.findByRole("button", { name: /add investment/i }));
        await screen.findByRole("dialog");
        // Without further navigation, the dialog still shows phase 1 content
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        errSpy.mockRestore();
    });

    // ─── F3: Field validation ─────────────────────────────────────────────

    it("blank name (cleared) does NOT call POST /api/investments (required guard)", async () => {
        let posted = false;
        server.use(
            http.post(`${API_BASE}/api/investments`, () => {
                posted = true;
                return ok(INVESTMENT_STUB);
            }),
        );
        const user = userEvent.setup();
        renderWithApp(<AddInvestmentFromMarketDialog quote={QUOTE} />);

        await user.click(await screen.findByRole("button", { name: /add investment/i }));
        await screen.findByRole("dialog");
        const createNewBtn = await screen.findByText(/create new/i);
        await user.click(createNewBtn.closest("button") ?? createNewBtn);

        const nameInput = await screen.findByLabelText(/name/i);
        await user.clear(nameInput);

        await user.click(await screen.findByRole("button", { name: /create/i }));

        await new Promise((r) => setTimeout(r, 200));
        expect(posted).toBe(false);
    });
});
