// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { Route, Routes } from "react-router";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, ACCOUNT_STUB } from "@/test/msw/handlers";
import { toYmd } from "@/components/shared/dateUtils";
import AccountDetailPage from "@/pages/AccountDetailPage";

const API_BASE = "http://localhost:3002";

const CHECKING = {
    ...ACCOUNT_STUB,
    id: 1,
    name: "KBC Checking",
    display_name: "KBC Checking",
    type: "checking",
    computed_balance: 950,
    // WP-B2 provenance fields (list endpoint only).
    anchor_date: "2025-01-31",
    post_anchor_count: 2,
    has_transactions: true,
};

const BROKER = {
    ...ACCOUNT_STUB,
    id: 2,
    name: "Degiro",
    display_name: "Degiro",
    type: "brokerage",
    computed_balance: 0,
    has_transactions: false,
};

const DRIFTING = {
    ...CHECKING,
    id: 3,
    name: "Drifty",
    display_name: "Drifty",
    statement_balance: 965.5,
    statement_balance_date: "2025-03-01",
    drift: 15.5,
};

// Newest-first rows, the way the ledger queries them; running_balance is the
// backend's per-account window (include_balance=true).
const LEDGER_ROWS = [
    {
        id: 11,
        transaction_date: "2025-03-10",
        date: "2025-03-10",
        bank_account: "KBC Checking",
        recipient_id: 5,
        recipient_name: "Albert Heijn",
        memo: "Groceries",
        amount: -50,
        currency: "EUR",
        balance: null,
        running_balance: 950,
        category_id: 1,
        category_name: "FOOD:GROCERIES",
        comment: null,
        tags: [],
        is_active: true,
        created_at: "2025-03-10T10:00:00.000Z",
        updated_at: null,
        links: [],
    },
    {
        id: 12,
        transaction_date: "2025-02-01",
        date: "2025-02-01",
        bank_account: "KBC Checking",
        recipient_id: 6,
        recipient_name: "Employer BV",
        memo: "Salary",
        amount: 1000,
        currency: "EUR",
        balance: null,
        running_balance: 1000,
        category_id: 2,
        category_name: "INCOME:SALARY",
        comment: null,
        tags: [],
        is_active: true,
        created_at: "2025-02-01T10:00:00.000Z",
        updated_at: null,
        links: [],
    },
];

function mockApi({
    accounts = [CHECKING, BROKER, DRIFTING],
    rows = LEDGER_ROWS,
} = {}) {
    const captured: URLSearchParams[] = [];
    server.use(
        http.get(`${API_BASE}/api/accounts`, () =>
            ok({ items: accounts, total: accounts.length, links: [] }),
        ),
        http.get(`${API_BASE}/api/transactions`, ({ request }) => {
            captured.push(new URL(request.url).searchParams);
            return ok({
                items: rows,
                total: rows.length,
                limit: 100,
                offset: 0,
                links: [],
            });
        }),
    );
    return captured;
}

function renderDetail(path: string) {
    return renderWithApp(
        <Routes>
            <Route path="/accounts/:id" element={<AccountDetailPage />} />
            <Route path="/accounts" element={<div>hub page</div>} />
        </Routes>,
        { initialEntries: [path] },
    );
}

describe("AccountDetailPage (integration, WP-B4 ledger route)", () => {
    it("renders header (name, balance, provenance) over the running-balance ledger", async () => {
        const captured = mockApi();
        renderDetail("/accounts/1");

        // Header: display name + computed balance + WP-B2 provenance subline.
        expect(
            await screen.findByRole("heading", {
                name: "KBC Checking",
                level: 1,
            }),
        ).toBeInTheDocument();
        const balanceCard = screen.getByText("Balance").closest("div")
            ?.parentElement as HTMLElement;
        expect(balanceCard).toHaveTextContent(/950,00/);
        expect(balanceCard).toHaveTextContent(
            /bank statement \+ 2 entries since/i,
        );

        // Ledger table: rows carry the running-balance column.
        const table = await screen.findByRole("table");
        expect(
            within(table).getByRole("columnheader", { name: "Balance" }),
        ).toBeInTheDocument();
        const groceries = within(table)
            .getByText("Albert Heijn")
            .closest("tr") as HTMLElement;
        expect(groceries).toHaveTextContent(/-50,00/);
        expect(groceries).toHaveTextContent(/950,00/);
        const salary = within(table)
            .getByText("Employer BV")
            .closest("tr") as HTMLElement;
        // Amount and running balance are both 1.000,00 € on this row.
        const salaryCells = within(salary).getAllByRole("cell");
        expect(salaryCells.at(-2)).toHaveTextContent(/1\.000,00/);
        expect(salaryCells.at(-1)).toHaveTextContent(/1\.000,00/);

        // First frontend consumer of include_balance=true — assert the wire params.
        const ledgerCall = captured.find(
            (p) => p.get("include_balance") === "true",
        );
        expect(ledgerCall).toBeDefined();
        expect(ledgerCall!.get("account_id")).toBe("1");
        expect(ledgerCall!.get("sort_dir")).toBe("desc");
    });

    it("shows the Edit / Merge / Close actions in the header menu", async () => {
        mockApi();
        renderDetail("/accounts/1");
        await screen.findByRole("heading", { name: "KBC Checking", level: 1 });

        await userEvent.click(
            screen.getByRole("button", { name: "Account actions" }),
        );
        expect(
            await screen.findByRole("menuitem", { name: /edit/i }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("menuitem", { name: /merge into/i }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("menuitem", { name: /close account/i }),
        ).toBeInTheDocument();
    });

    // ── WP-B5 §3 F5: ONE Close verb; Delete gated on has_transactions ────────

    it("offers a single Close verb (no separate Archive) and disables Delete with an explanation when the account has transactions", async () => {
        mockApi();
        renderDetail("/accounts/1"); // CHECKING: has_transactions: true, active
        await screen.findByRole("heading", { name: "KBC Checking", level: 1 });

        await userEvent.click(
            screen.getByRole("button", { name: "Account actions" }),
        );
        await screen.findByRole("menuitem", { name: /edit/i });

        // One lifecycle verb: Close. The old Archive item is folded into it.
        expect(
            screen.getByRole("menuitem", { name: /close account/i }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("menuitem", { name: /^archive$/i }),
        ).not.toBeInTheDocument();

        // Delete is present but disabled, with the close-instead explanation.
        const del = screen.getByRole("menuitem", { name: /delete/i });
        expect(del).toHaveAttribute("aria-disabled", "true");
        expect(del).toHaveTextContent(/has transactions — close instead/i);
    });

    it("enables Delete for an account without transactions", async () => {
        mockApi();
        renderDetail("/accounts/2"); // BROKER: has_transactions: false
        await screen.findByRole("heading", { name: "Degiro", level: 1 });

        await userEvent.click(
            screen.getByRole("button", { name: "Account actions" }),
        );
        const del = await screen.findByRole("menuitem", { name: /delete/i });
        expect(del).not.toHaveAttribute("aria-disabled", "true");

        await userEvent.click(del);
        // The confirm dialog opens instead of a dead disabled row.
        expect(await screen.findByText("Delete account?")).toBeInTheDocument();
    });

    it("shows Reopen (not Close/Archive) for a closed account", async () => {
        mockApi({
            accounts: [
                {
                    ...CHECKING,
                    id: 4,
                    name: "Shut",
                    display_name: "Shut",
                    is_active: false,
                },
            ],
        });
        renderDetail("/accounts/4");
        await screen.findByRole("heading", { name: "Shut", level: 1 });

        await userEvent.click(
            screen.getByRole("button", { name: "Account actions" }),
        );
        expect(
            await screen.findByRole("menuitem", { name: /reopen/i }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("menuitem", { name: /close account/i }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("menuitem", { name: /^archive$/i }),
        ).not.toBeInTheDocument();
    });

    it("renders the drift chip and opens the Reconcile dialog from it", async () => {
        mockApi();
        renderDetail("/accounts/3");
        await screen.findByRole("heading", { name: "Drifty", level: 1 });

        const chip = screen.getByRole("button", { name: "Reconcile balance" });
        expect(chip.textContent).toMatch(/\+.*15,50/);
        await userEvent.click(chip);
        expect(
            await screen.findByRole("dialog", { name: "Reconcile balance" }),
        ).toBeInTheDocument();
    });

    // ── WP-B5 §3 F1: chip carries the statement date + a stale tone; the
    //    Reconcile dialog's second exit lands on this page's ?since= view ─────

    it("carries the statement date on the chip and reports a long-stale reading in warning tone", async () => {
        // DRIFTING's statement is dated 2025-03-01 — far past the ~45-day window.
        mockApi();
        renderDetail("/accounts/3");
        await screen.findByRole("heading", { name: "Drifty", level: 1 });

        const chip = screen.getByRole("button", { name: "Reconcile balance" });
        expect(chip.textContent).toContain("statement 01/03/2025");
        expect(chip.className).toMatch(/text-warning/);
        expect(chip.className).not.toMatch(/text-destructive/);
    });

    it("keeps a recent statement's drift in destructive tone", async () => {
        const recent = new Date();
        recent.setDate(recent.getDate() - 5);
        const recentYmd = toYmd(recent);
        mockApi({
            accounts: [
                {
                    ...DRIFTING,
                    // Bare YYYY-MM-DD — accountRepository.js emits the DATE via to_char.
                    statement_balance_date: recentYmd,
                },
            ],
        });
        renderDetail("/accounts/3");
        await screen.findByRole("heading", { name: "Drifty", level: 1 });

        const chip = screen.getByRole("button", { name: "Reconcile balance" });
        expect(chip.className).toMatch(/text-destructive/);
        expect(chip.className).not.toMatch(/amber/);
    });

    it("narrows this page to ?since= when the Reconcile dialog's 'show transactions since' exit is taken", async () => {
        mockApi();
        renderDetail("/accounts/3");
        await screen.findByRole("heading", { name: "Drifty", level: 1 });

        await userEvent.click(
            screen.getByRole("button", { name: "Reconcile balance" }),
        );
        await screen.findByRole("dialog", { name: "Reconcile balance" });

        // The stored statement day (2025-03-01) drives the deep-link…
        await userEvent.click(
            await screen.findByRole("button", {
                name: /show transactions since 01\/03\/2025/i,
            }),
        );

        // …and the ledger below narrows to it, banner and all.
        expect(
            await screen.findByText(/showing transactions since/i),
        ).toBeInTheDocument();
        const table = screen.getByRole("table");
        expect(within(table).getByText("Albert Heijn")).toBeInTheDocument();
        expect(
            within(table).queryByText("Employer BV"),
        ).not.toBeInTheDocument();
    });

    it("shows the Holdings placeholder (and no cash balance) for portfolio-type accounts", async () => {
        mockApi();
        renderDetail("/accounts/2");
        await screen.findByRole("heading", { name: "Degiro", level: 1 });

        expect(screen.getByText("Holdings")).toBeInTheDocument();
        expect(
            screen.getByText(/holdings arrive in a later release/i),
        ).toBeInTheDocument();
        // The misleading €0,00 ledger balance is replaced by the placeholder…
        expect(screen.getByText(/tracked in portfolio/i)).toBeInTheDocument();
        // …and a has_transactions=false account explains its missing ledger.
        expect(
            screen.getByText(/keeps its activity in the portfolio/i),
        ).toBeInTheDocument();
    });

    it("narrows the ledger to rows on/after ?since= and clears back to the full view", async () => {
        mockApi();
        renderDetail("/accounts/1?since=2025-03-01");

        const table = await screen.findByRole("table");
        expect(within(table).getByText("Albert Heijn")).toBeInTheDocument();
        // The 2025-02-01 salary row predates the since-date and is hidden.
        expect(
            within(table).queryByText("Employer BV"),
        ).not.toBeInTheDocument();
        expect(
            screen.getByText(/showing transactions since/i),
        ).toBeInTheDocument();

        await userEvent.click(
            screen.getByRole("button", { name: "Clear filter" }),
        );
        expect(await screen.findByText("Employer BV")).toBeInTheDocument();
        expect(
            screen.queryByText(/showing transactions since/i),
        ).not.toBeInTheDocument();
    });

    it("shows a not-found state (with a way back) for an unknown account id", async () => {
        mockApi();
        renderDetail("/accounts/999");

        expect(
            await screen.findByText("Account not found"),
        ).toBeInTheDocument();
        await userEvent.click(
            screen.getByRole("button", { name: /all accounts/i }),
        );
        expect(await screen.findByText("hub page")).toBeInTheDocument();
    });
});
