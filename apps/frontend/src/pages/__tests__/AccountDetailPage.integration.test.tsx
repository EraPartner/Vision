// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, ACCOUNT_STUB } from "@/test/msw/handlers";
import { toYmd } from "@/lib/dateUtils";
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

const WALLET = {
    ...ACCOUNT_STUB,
    id: 7,
    name: "Cold storage",
    display_name: "Cold storage",
    type: "wallet",
    computed_balance: 1234,
    has_transactions: true,
    multi_currency_cash: true,
    drift: 25,
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
    planned = [],
}: {
    accounts?: unknown[];
    rows?: typeof LEDGER_ROWS;
    planned?: unknown[];
} = {}) {
    const captured: URLSearchParams[] = [];
    const closeBodies: Array<Record<string, unknown>> = [];
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
        http.get(`${API_BASE}/api/planned-transactions`, ({ request }) => {
            captured.push(new URL(request.url).searchParams);
            return ok({
                items: planned,
                total: planned.length,
                limit: 100,
                offset: 0,
                links: [],
            });
        }),
        http.get(`${API_BASE}/api/info/portfolio-summary`, () =>
            ok({
                currency: "EUR",
                computed_at: "2026-09-08T00:00:00Z",
                totals: {},
                summaries: [],
                byAccount: [],
            }),
        ),
        http.post(`${API_BASE}/api/accounts/:id/close`, async ({ request }) => {
            closeBodies.push((await request.json()) as Record<string, unknown>);
            return ok({
                account_id: 1,
                balance_handling: "adjustment",
                already_closed: false,
                adjustments: [],
            });
        }),
    );
    return Object.assign(captured, { closeBodies });
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
    it("keeps Reconcile reachable for a multi-currency account with no primary drift", async () => {
        mockApi({
            accounts: [
                {
                    ...CHECKING,
                    multi_currency_cash: true,
                    drift: 0,
                    statement_balances: [
                        {
                            currency: "USD",
                            balance: 20,
                            balance_date: "2026-09-02",
                        },
                    ],
                },
            ],
        });
        renderDetail("/accounts/1");

        expect(
            await screen.findByRole("button", { name: "Reconcile balance" }),
        ).toBeInTheDocument();
    });

    it("treats a NULL-currency ledger row as EUR on a USD account", async () => {
        const usdAccount = {
            ...CHECKING,
            id: 4,
            name: "USD account",
            display_name: "USD account",
            currency: "USD",
        };
        mockApi({
            accounts: [usdAccount],
            rows: [
                {
                    ...LEDGER_ROWS[0],
                    id: 41,
                    recipient_name: "Legacy null row",
                    currency: null as never,
                    amount: 25,
                    running_balance: 25,
                },
                {
                    ...LEDGER_ROWS[1],
                    id: 42,
                    recipient_name: "Dollar row",
                    currency: "USD",
                    amount: 10,
                    running_balance: 10,
                },
            ],
        });
        renderDetail("/accounts/4");

        const table = await screen.findByRole("table");
        const legacyRow = within(table)
            .getByText("Legacy null row")
            .closest("tr") as HTMLElement;
        expect(legacyRow).toHaveTextContent("€");
        // Only one USD point remains, so the compact sparkline does not join
        // it to the legacy row's separate EUR series.
        expect(
            screen.queryByLabelText(/account balance trend/i),
        ).not.toBeInTheDocument();
    });

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

    it("defaults residual cash to a visible zero-out adjustment before closing", async () => {
        const captured = mockApi();
        renderDetail("/accounts/1");
        await screen.findByRole("heading", {
            name: "KBC Checking",
            level: 1,
        });

        await userEvent.click(
            screen.getByRole("button", { name: "Account actions" }),
        );
        await userEvent.click(
            screen.getByRole("menuitem", { name: /close account/i }),
        );
        const dialog = await screen.findByRole("dialog");
        expect(
            within(dialog).getByRole("checkbox", { name: /zero the account/i }),
        ).toBeChecked();
        await userEvent.click(
            within(dialog).getByRole("button", { name: /^close account$/i }),
        );

        await waitFor(() =>
            expect(captured.closeBodies).toEqual([
                { balance_handling: "adjustment" },
            ]),
        );
    });

    it("allows preserving residual cash when the user opts out of zero-out", async () => {
        const captured = mockApi();
        renderDetail("/accounts/1");
        await screen.findByRole("heading", {
            name: "KBC Checking",
            level: 1,
        });

        await userEvent.click(
            screen.getByRole("button", { name: "Account actions" }),
        );
        await userEvent.click(
            screen.getByRole("menuitem", { name: /close account/i }),
        );
        const checkbox = await screen.findByRole("checkbox", {
            name: /zero the account/i,
        });
        await userEvent.click(checkbox);
        await userEvent.click(
            within(screen.getByRole("dialog")).getByRole("button", {
                name: /^close account$/i,
            }),
        );

        await waitFor(() =>
            expect(captured.closeBodies).toEqual([
                { balance_handling: "preserve" },
            ]),
        );
    });

    it("offers zero-out when native currency partitions offset to a zero converted total", async () => {
        const offsetting = {
            ...CHECKING,
            computed_balance: 0,
            balance_parts: [
                { currency: "EUR", balance: 100 },
                { currency: "USD", balance: -100 },
            ],
        };
        mockApi({ accounts: [offsetting] });
        renderDetail("/accounts/1");
        await screen.findByRole("heading", {
            name: "KBC Checking",
            level: 1,
        });

        await userEvent.click(
            screen.getByRole("button", { name: "Account actions" }),
        );
        await userEvent.click(
            screen.getByRole("menuitem", { name: /close account/i }),
        );

        const dialog = await screen.findByRole("dialog");
        expect(
            within(dialog).getByRole("checkbox", { name: /zero the account/i }),
        ).toBeChecked();
        expect(dialog).toHaveTextContent(/100.*€.*-.*100.*\$/);
    });

    it("asks the server to zero a cash account even when the cached balance is zero", async () => {
        const captured = mockApi({ accounts: [BROKER] });
        renderDetail("/accounts/2");
        await screen.findByRole("heading", { name: "Degiro", level: 1 });

        await userEvent.click(
            screen.getByRole("button", { name: "Account actions" }),
        );
        await userEvent.click(
            screen.getByRole("menuitem", { name: /close account/i }),
        );
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
        await userEvent.click(
            within(dialog).getByRole("button", { name: /^close account$/i }),
        );

        await waitFor(() =>
            expect(captured.closeBodies).toEqual([
                { balance_handling: "adjustment" },
            ]),
        );
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

    it("shows assigned holdings, broker profit/loss, and cash consistently on broker detail", async () => {
        mockApi();
        server.use(
            http.get(`${API_BASE}/api/info/portfolio-summary`, () =>
                ok({
                    currency: "EUR",
                    computed_at: "2026-09-08T00:00:00Z",
                    totals: {},
                    summaries: [],
                    byAccount: [
                        {
                            account_id: 2,
                            assignment: "account",
                            contribution_kind: "position",
                            oversold: false,
                            currentValue: 1250,
                            totalInvested: 1000,
                            realizedGain: 20,
                            unrealizedGain: 230,
                            gainLoss: 250,
                        },
                    ],
                }),
            ),
        );
        renderDetail("/accounts/2");
        await screen.findByRole("heading", { name: "Degiro", level: 1 });

        expect(screen.getByText("Holdings")).toBeInTheDocument();
        const holdings = (await screen.findByText("Holdings value"))
            .parentElement as HTMLElement;
        const profitLoss = screen.getByText("Broker P&L")
            .parentElement as HTMLElement;
        const cash = screen.getByText("Balance").parentElement as HTMLElement;
        expect(holdings).toHaveTextContent(/1\.250,00/);
        expect(profitLoss).toHaveTextContent(/\+250,00/);
        expect(cash).toHaveTextContent(/0,00/);
        expect(
            screen.getByText(/keeps its activity in the portfolio/i),
        ).toBeInTheDocument();
    });

    it("keeps the holdings section loading until a delayed summary settles", async () => {
        mockApi();
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        server.use(
            http.get(`${API_BASE}/api/info/portfolio-summary`, async () => {
                await pending;
                return ok({
                    currency: "EUR",
                    computed_at: "2026-09-08T00:00:00Z",
                    totals: {},
                    summaries: [],
                    byAccount: [],
                });
            }),
        );
        renderDetail("/accounts/2");

        await screen.findByRole("heading", { name: "Degiro", level: 1 });
        const holdingsCard = screen
            .getByRole("heading", { name: "Holdings" })
            .closest(".glass-thin") as HTMLElement;
        expect(within(holdingsCard).getByRole("status")).toHaveAttribute(
            "aria-busy",
            "true",
        );
        expect(
            within(holdingsCard).queryByText(/no assigned holdings/i),
        ).not.toBeInTheDocument();
        release();
        expect(
            await within(holdingsCard).findByText(/no assigned holdings/i),
        ).toBeInTheDocument();
    });

    it("shows a holdings error without claiming the broker has no positions", async () => {
        mockApi();
        server.use(
            http.get(`${API_BASE}/api/info/portfolio-summary`, () =>
                HttpResponse.json(
                    { error: { message: "summary unavailable" } },
                    { status: 400 },
                ),
            ),
        );
        renderDetail("/accounts/2");

        const holdingsCard = (
            await screen.findByRole("heading", { name: "Holdings" })
        ).closest(".glass-thin") as HTMLElement;
        await waitFor(() =>
            expect(
                within(holdingsCard).queryByRole("status"),
            ).not.toBeInTheDocument(),
        );
        expect(holdingsCard).toHaveTextContent(/details weren.t accepted/i);
        expect(
            screen.queryByText(/no assigned holdings/i),
        ).not.toBeInTheDocument();
    });

    it("shows wallet holdings and oversold state while suppressing stale cash", async () => {
        mockApi({ accounts: [CHECKING, WALLET] });
        server.use(
            http.get(`${API_BASE}/api/info/portfolio-summary`, () =>
                ok({
                    currency: "EUR",
                    computed_at: "2026-09-08T00:00:00Z",
                    totals: {},
                    summaries: [],
                    byAccount: [
                        {
                            account_id: 7,
                            assignment: "account",
                            contribution_kind: "position",
                            oversold: true,
                            currentValue: 300,
                            totalInvested: 275,
                            realizedGain: 0,
                            unrealizedGain: 25,
                            gainLoss: 25,
                        },
                    ],
                }),
            ),
        );
        renderDetail("/accounts/7");

        expect(
            await screen.findByRole("status", { name: /oversold broker/i }),
        ).toBeInTheDocument();
        const holdings = screen.getByText("Holdings value")
            .parentElement as HTMLElement;
        const profitLoss = screen.getByText("Broker P&L")
            .parentElement as HTMLElement;
        expect(holdings).toHaveTextContent(/300,00/);
        expect(profitLoss).toHaveTextContent(/\+25,00/);
        expect(screen.queryByText(/1\.234,00/)).not.toBeInTheDocument();
        expect(
            screen.queryByText("Transaction ledger"),
        ).not.toBeInTheDocument();
    });

    it("does not request the portfolio summary for a non-portfolio account", async () => {
        mockApi();
        let summaryRequests = 0;
        server.use(
            http.get(`${API_BASE}/api/info/portfolio-summary`, () => {
                summaryRequests += 1;
                return ok({
                    currency: "EUR",
                    computed_at: "2026-09-08T00:00:00Z",
                    totals: {},
                    summaries: [],
                    byAccount: [],
                });
            }),
        );
        renderDetail("/accounts/1");

        await screen.findByRole("heading", { name: "KBC Checking", level: 1 });
        await waitFor(() =>
            expect(screen.getByText("Ledger")).toBeInTheDocument(),
        );
        expect(summaryRequests).toBe(0);
    });

    it("keeps wallets holdings-only even when stale cash fields are present", async () => {
        const captured = mockApi({ accounts: [CHECKING, BROKER, WALLET] });
        renderDetail("/accounts/7");
        await screen.findByRole("heading", { name: "Cold storage", level: 1 });

        expect(screen.getByText("Holdings")).toBeInTheDocument();
        expect(screen.getByText(/tracked in portfolio/i)).toBeInTheDocument();
        expect(
            await screen.findByText(/no assigned holdings/i),
        ).toBeInTheDocument();
        expect(screen.queryByText(/1\.234,00/)).not.toBeInTheDocument();
        expect(
            screen.queryByText("Transaction ledger"),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /reconcile balance/i }),
        ).not.toBeInTheDocument();
        expect(captured).toHaveLength(0);

        await userEvent.click(
            screen.getByRole("button", { name: "Account actions" }),
        );
        await screen.findByRole("menuitem", { name: /edit/i });
        expect(
            screen.queryByRole("menuitem", { name: /set opening balance/i }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("menuitem", { name: /view transactions/i }),
        ).not.toBeInTheDocument();

        await userEvent.click(
            screen.getByRole("menuitem", { name: /close account/i }),
        );
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).queryByText(/1\.234,00/)).not.toBeInTheDocument();
        await userEvent.click(
            within(dialog).getByRole("button", { name: /^close account$/i }),
        );
        await waitFor(() =>
            expect(captured.closeBodies).toEqual([
                { balance_handling: "preserve" },
            ]),
        );
    });

    it("preserves the cash ledger and Reconcile affordances for brokerage accounts", async () => {
        const brokerWithCash = {
            ...BROKER,
            has_transactions: true,
            drift: 15,
        };
        const captured = mockApi({ accounts: [CHECKING, brokerWithCash] });
        renderDetail("/accounts/2");
        await screen.findByRole("heading", { name: "Degiro", level: 1 });

        expect(await screen.findByRole("table")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /reconcile balance/i }),
        ).toBeInTheDocument();
        expect(
            captured.some((params) => params.get("account_id") === "2"),
        ).toBe(true);

        await userEvent.click(
            screen.getByRole("button", { name: "Account actions" }),
        );
        expect(
            await screen.findByRole("menuitem", {
                name: /set opening balance/i,
            }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("menuitem", { name: /view transactions/i }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("menuitem", { name: /transfer portfolio lots/i }),
        ).toBeInTheDocument();
    });

    it.each([
        ["a non-portfolio account", CHECKING],
        ["an inactive portfolio account", { ...BROKER, is_active: false }],
    ])("hides portfolio lot transfer for %s", async (_label, account) => {
        mockApi({ accounts: [account] });
        renderDetail(`/accounts/${account.id}`);
        await screen.findByRole("heading", {
            name: account.display_name,
            level: 1,
        });

        await userEvent.click(
            screen.getByRole("button", { name: "Account actions" }),
        );
        await screen.findByRole("menuitem", { name: /edit/i });
        expect(
            screen.queryByRole("menuitem", {
                name: /transfer portfolio lots/i,
            }),
        ).not.toBeInTheDocument();
    });

    it("shows account plans separately without changing ledger balances", async () => {
        const planned = {
            id: 81,
            planned_date: "2025-04-01",
            bank_account: "KBC Checking",
            recipient_name: "Landlord",
            memo: "Rent",
            amount: -700,
            currency: "EUR",
            is_recurring: true,
            is_executed: false,
            execution_count: 0,
            is_active: true,
            created_at: "2025-03-01T10:00:00.000Z",
            links: [],
        };
        const captured = mockApi({ planned: [planned] });
        renderDetail("/accounts/1");

        const heading = await screen.findByRole("heading", {
            name: "Upcoming planned transactions",
        });
        const plannedCard = heading.closest(
            "[class*='premium-frame']",
        ) as HTMLElement;
        expect(plannedCard).not.toBeNull();
        expect(await screen.findByText("Landlord")).toBeInTheDocument();
        expect(
            within(plannedCard!).getByText(
                /not included in the current balance/i,
            ),
        ).toBeInTheDocument();
        expect(screen.getAllByText(/950/).length).toBeGreaterThan(0);

        const plannedCall = captured.find(
            (params) =>
                params.get("account_id") === "1" &&
                params.get("limit") === "5000",
        );
        expect(plannedCall?.has("bank_account")).toBe(false);
        expect(plannedCall?.get("active")).toBe("true");
        expect(plannedCall?.get("is_executed")).toBe("false");
    });

    it("keeps the posted ledger visible when the planned forecast fails", async () => {
        mockApi();
        server.use(
            http.get(`${API_BASE}/api/planned-transactions`, () =>
                HttpResponse.json(
                    { ok: false, error: { message: "forecast unavailable" } },
                    { status: 503 },
                ),
            ),
        );
        renderDetail("/accounts/3");

        const heading = await screen.findByRole("heading", {
            name: "Upcoming planned transactions",
        });
        const plannedCard = heading.closest(
            "[class*='premium-frame']",
        ) as HTMLElement;
        await waitFor(() =>
            expect(
                plannedCard.querySelector(".text-destructive"),
            ).toBeInTheDocument(),
        );
        expect(await screen.findByText("Albert Heijn")).toBeInTheDocument();
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
