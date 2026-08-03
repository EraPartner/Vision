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
import AccountsPage from "@/pages/AccountsPage";

const API_BASE = "http://localhost:3002";

/** A YYYY-MM-DD calendar day `n` days before today, in the LOCAL calendar. */
function ymdDaysAgo(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return toYmd(d);
}

/** Independent DD/MM/YYYY formatter (the app default) — not the app's helper. */
function ddmmyyyy(ymd: string): string {
    const [y, m, d] = ymd.split("-");
    return `${d}/${m}/${y}`;
}

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

// `unknown[]`: fixtures below deliberately vary in shape (drift/statement
// fields present or null), which a FIXTURE-inferred parameter type would reject.
function mockAccounts(items: unknown[] = FIXTURE) {
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

    // ── WP-B4: card click → /accounts/:id; lifecycle verbs moved off the hub ──

    function renderWithDetailRoute(initialEntries = ["/accounts"]) {
        return renderWithApp(
            <Routes>
                <Route path="/accounts" element={<AccountsPage />} />
                <Route path="/accounts/:id" element={<div>detail route</div>} />
            </Routes>,
            { initialEntries },
        );
    }

    it("navigates to the /accounts/:id ledger route on a single card click", async () => {
        mockAccounts();
        renderWithDetailRoute();

        const card = await screen.findByRole("button", { name: "Open details for KBC Checking" });
        await userEvent.click(card);
        expect(await screen.findByText("detail route")).toBeInTheDocument();
    });

    it("keeps the a11y dropdown with open + transactions, but without Edit/Merge/Close (moved to the detail header)", async () => {
        mockAccounts();
        renderWithDetailRoute();

        const cash = await screen.findByRole("region", { name: "Cash & Savings" });
        const card = within(cash).getByRole("button", { name: "Open details for KBC Checking" });
        await userEvent.click(within(card).getByRole("button", { name: "Account actions" }));

        expect(await screen.findByRole("menuitem", { name: /view details/i })).toBeInTheDocument();
        expect(screen.getByRole("menuitem", { name: /view transactions/i })).toBeInTheDocument();
        expect(screen.queryByRole("menuitem", { name: /edit/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("menuitem", { name: /merge/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("menuitem", { name: /close account/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("menuitem", { name: /delete/i })).not.toBeInTheDocument();
    });

    it("forwards the legacy ?account= deep-link to the detail route", async () => {
        mockAccounts();
        renderWithDetailRoute(["/accounts?account=2"]);
        expect(await screen.findByText("detail route")).toBeInTheDocument();
    });

    // ── WP-B5 §3 F1: drift badge carries its statement date + a stale tone ───

    // Realistic money: a positive drift on a checking account, negative ones on
    // a mortgage. `statement_balance_date` is a bare YYYY-MM-DD on the wire
    // (accountRepository.js emits it via to_char); "Day 44" keeps the ISO
    // timestamp shape as the ONE fixture covering the defensive slice. "Day 46"
    // additionally sends drift/computed_balance as NUMERIC strings — how pg
    // actually returns them — to exercise normalizeAccount in the render path.
    const FRESH_YMD = ymdDaysAgo(10);
    const DAY_44_YMD = ymdDaysAgo(44);
    const DAY_45_YMD = ymdDaysAgo(45);
    const DAY_46_YMD = ymdDaysAgo(46);

    const DRIFT_FIXTURE = [
        {
            ...ACCOUNT_STUB, id: 10, name: "Fresh Drift", display_name: "Fresh Drift",
            type: "checking", computed_balance: 1284.4, statement_balance: 1299.9,
            drift: 15.5, statement_balance_date: FRESH_YMD,
        },
        {
            ...ACCOUNT_STUB, id: 11, name: "Day 44", display_name: "Day 44",
            type: "liability", computed_balance: -8420.15, statement_balance: -8500,
            drift: -79.85, statement_balance_date: `${DAY_44_YMD}T00:00:00.000Z`,
            // (ISO-timestamp shape — the defensive slice in statementYmd.)
        },
        {
            ...ACCOUNT_STUB, id: 12, name: "Day 46", display_name: "Day 46",
            type: "liability", computed_balance: "-8420.15", statement_balance: "-8500.00",
            drift: "-79.85", statement_balance_date: DAY_46_YMD,
        },
        {
            ...ACCOUNT_STUB, id: 14, name: "Day 45", display_name: "Day 45",
            type: "liability", computed_balance: -8420.15, statement_balance: -8500,
            drift: -79.85, statement_balance_date: DAY_45_YMD,
        },
        {
            ...ACCOUNT_STUB, id: 13, name: "No Stamp", display_name: "No Stamp",
            type: "checking", computed_balance: 300, statement_balance: 312.4,
            drift: 12.4, statement_balance_date: null,
        },
    ];

    /** The drift badge inside the card for `label`. */
    function driftBadgeFor(label: string): HTMLElement {
        const card = screen.getByRole("button", { name: `Open details for ${label}` });
        return within(card).getByRole("button", { name: "Reconcile balance" });
    }

    it("puts the statement date on the drift badge, sliced off its ISO timestamp", async () => {
        mockAccounts(DRIFT_FIXTURE);
        renderWithApp(<AccountsPage />);
        await screen.findByRole("region", { name: "Cash & Savings" });

        const badge = driftBadgeFor("Fresh Drift");
        expect(badge.textContent).toMatch(/^Drift \+/);
        expect(badge.textContent).toMatch(/15,50/);
        expect(badge.textContent).toContain(`statement ${ddmmyyyy(FRESH_YMD)}`);
        // Never the raw timestamp.
        expect(badge.textContent).not.toMatch(/T00:00/);
    });

    it("omits the date (but keeps the drift) when no statement date is stamped", async () => {
        mockAccounts(DRIFT_FIXTURE);
        renderWithApp(<AccountsPage />);
        await screen.findByRole("region", { name: "Cash & Savings" });

        const badge = driftBadgeFor("No Stamp");
        expect(badge.textContent).toMatch(/12,40/);
        expect(badge.textContent).not.toMatch(/statement/);
        expect(badge.className).toMatch(/text-destructive/);
    });

    it("stays destructive at 44 days and turns warning-amber at 46 (the ~45-day staleness boundary)", async () => {
        mockAccounts(DRIFT_FIXTURE);
        renderWithApp(<AccountsPage />);
        await screen.findByRole("region", { name: "Liabilities" });

        const fresh = driftBadgeFor("Fresh Drift");
        expect(fresh.className).toMatch(/text-destructive/);
        expect(fresh.className).not.toMatch(/amber/);

        // 44 days old — inside the window, still "something is wrong" red.
        const day44 = driftBadgeFor("Day 44");
        expect(day44.className).toMatch(/text-destructive/);
        expect(day44.className).not.toMatch(/amber/);
        // Negative drift on a liability keeps its minus sign, no stray plus.
        expect(day44.textContent).toMatch(/-79,85/);
        expect(day44.textContent).not.toMatch(/\+/);

        // Exactly AT the threshold — still destructive. Pins the comparison as
        // strictly `> 45`; a `>= 45` regression fails here.
        const day45 = driftBadgeFor("Day 45");
        expect(day45.className).toMatch(/text-destructive/);
        expect(day45.className).not.toMatch(/amber/);

        // 46 days old — past the threshold, "probably just out of date" amber.
        const day46 = driftBadgeFor("Day 46");
        expect(day46.className).toMatch(/amber/);
        expect(day46.className).not.toMatch(/text-destructive/);
        // NUMERIC-string drift still renders as money (normalizeAccount coercion).
        expect(day46.textContent).toMatch(/-79,85/);
    });

    it("opens the Reconcile dialog from a stale (warning-tone) badge just like a fresh one", async () => {
        mockAccounts(DRIFT_FIXTURE);
        renderWithApp(<AccountsPage />);
        await screen.findByRole("region", { name: "Liabilities" });

        await userEvent.click(driftBadgeFor("Day 46"));
        expect(await screen.findByRole("dialog", { name: "Reconcile balance" })).toBeInTheDocument();
    });
});
