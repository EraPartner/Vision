// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, ACCOUNT_STUB } from "@/test/msw/handlers";
import AccountsPage from "@/pages/AccountsPage";

const API_BASE = "http://localhost:3002";

// Same-currency (EUR) fixture so FX conversion is identity — the grouped hub's
// Net cash reconciliation under test is population + sign (WP-A1 definition).
const FIXTURE = [
    { ...ACCOUNT_STUB, id: 1, name: "KBC Checking", display_name: "KBC Checking", type: "checking", computed_balance: 1000 },
    { ...ACCOUNT_STUB, id: 2, name: "Argenta Savings", display_name: "Argenta Savings", type: "savings", computed_balance: 500 },
    { ...ACCOUNT_STUB, id: 3, name: "Mortgage", display_name: "Mortgage", type: "liability", computed_balance: -300 },
    { ...ACCOUNT_STUB, id: 4, name: "Degiro", display_name: "Degiro", type: "brokerage", computed_balance: 0 },
    { ...ACCOUNT_STUB, id: 5, name: "Partner Checking", display_name: "Partner Checking", type: "checking", in_net_worth: false, computed_balance: 999 },
    { ...ACCOUNT_STUB, id: 6, name: "Old Savings", display_name: "Old Savings", type: "savings", is_active: false, computed_balance: 555 },
];

function mockAccounts(items = FIXTURE) {
    server.use(
        http.get(`${API_BASE}/api/accounts`, () =>
            ok({ items, total: items.length, links: [] }),
        ),
    );
}

describe("AccountsPage (integration, WP-B3 grouped hub)", () => {
    it("renders the four groups in deterministic order with label-sorted cards", async () => {
        mockAccounts();
        renderWithApp(<AccountsPage />);

        const cash = await screen.findByRole("region", { name: "Cash & Savings" });
        expect(screen.getByRole("region", { name: "Portfolio accounts" })).toBeInTheDocument();
        expect(screen.getByRole("region", { name: "Liabilities" })).toBeInTheDocument();
        expect(screen.getByRole("region", { name: "Archived" })).toBeInTheDocument();

        // Within Cash & Savings: sorted by display label (Argenta before KBC);
        // the not-in-net-worth checking account still renders in its type group.
        const cashCards = within(cash).getAllByRole("button", { name: /open details for/i });
        expect(cashCards.map((c) => c.getAttribute("aria-label"))).toEqual([
            "Open details for Argenta Savings",
            "Open details for KBC Checking",
            "Open details for Partner Checking",
        ]);
    });

    it("replaces the Show-archived toggle with a collapsed Archived group", async () => {
        mockAccounts();
        renderWithApp(<AccountsPage />);
        await screen.findByRole("region", { name: "Cash & Savings" });

        // The old toggle is gone.
        expect(screen.queryByRole("button", { name: /show archived/i })).not.toBeInTheDocument();

        // Collapsed by default: header shows the count, the card is hidden.
        const trigger = screen.getByRole("button", { name: /archived\s*\(1\)/i });
        expect(trigger).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByText("Old Savings")).not.toBeInTheDocument();

        // Expanding reveals the archived card.
        await userEvent.click(trigger);
        expect(trigger).toHaveAttribute("aria-expanded", "true");
        expect(await screen.findByText("Old Savings")).toBeInTheDocument();
    });

    it("shows per-group subtotals and a Net cash grand line matching the WP-A1 population", async () => {
        mockAccounts();
        renderWithApp(<AccountsPage />);

        const cash = await screen.findByRole("region", { name: "Cash & Savings" });
        // Default settings: EUR, 'eu' number format → de-DE (1.234,56 €).
        // Cash & Savings subtotal is the FULL group: 1000 + 500 + 999 = 2499.
        expect(within(cash).getByText(/subtotal/i).textContent).toMatch(/2\.499,00/);

        // Liabilities subtotal is naturally negative.
        const liabilities = screen.getByRole("region", { name: "Liabilities" });
        expect(within(liabilities).getByText(/subtotal/i).textContent).toMatch(/-300,00/);

        // Net cash = in_net_worth-only Cash&Savings + Liabilities
        // (1000 + 500 − 300 = 1200) — excludes the not-in-net-worth account,
        // the archived account, and the portfolio-type ledger balance.
        const netCashLabel = screen.getByText("Net cash");
        const grandLine = netCashLabel.closest("div")?.parentElement as HTMLElement;
        expect(within(grandLine).getByText(/1\.200,00/)).toBeInTheDocument();
    });

    it("renders the Tracked-in-Portfolio placeholder instead of a misleading zero balance on portfolio-type cards", async () => {
        mockAccounts();
        renderWithApp(<AccountsPage />);

        const portfolio = await screen.findByRole("region", { name: "Portfolio accounts" });
        const brokerCard = within(portfolio).getByRole("button", { name: "Open details for Degiro" });
        expect(within(brokerCard).getByText(/tracked in portfolio/i)).toBeInTheDocument();
        // The card must NOT show the €0,00 computed ledger balance.
        expect(within(brokerCard).queryByText(/0,00/)).not.toBeInTheDocument();
    });

    it("shows the not-in-net-worth chip only on excluded accounts", async () => {
        mockAccounts();
        renderWithApp(<AccountsPage />);

        const cash = await screen.findByRole("region", { name: "Cash & Savings" });
        const excluded = within(cash).getByRole("button", { name: "Open details for Partner Checking" });
        expect(within(excluded).getByText("not in net worth")).toBeInTheDocument();

        const included = within(cash).getByRole("button", { name: "Open details for KBC Checking" });
        expect(within(included).queryByText("not in net worth")).not.toBeInTheDocument();
    });

    it("still renders the empty state when there are no accounts at all", async () => {
        mockAccounts([]);
        renderWithApp(<AccountsPage />);
        expect(await screen.findByText(/no accounts yet/i)).toBeInTheDocument();
    });
});
