// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, aggOk, ACCOUNT_STUB } from "@/test/msw/handlers";
import { toYmd } from "@/components/shared/dateUtils";
import { BankBalancesWidget } from "@/features/dashboard/BankBalancesWidget";

const API_BASE = "http://localhost:3002";

/** A YYYY-MM-DD calendar day `n` days before today, in the LOCAL calendar. */
function ymdDaysAgo(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return toYmd(d);
}

// The bank-balances payload: `total_net_position` is the server's sum over
// exactly these rows (non-liability, in_net_worth, with ledger activity) —
// including one whose CURRENT balance nets to zero, which is precisely why the
// widget's card list is not the same population.
const PAYLOAD_ACCOUNTS = [
    { account_id: 1, bank_account: "KBC Checking", display_name: "KBC Checking", balance: 2450.75, transaction_count: 120 },
    { account_id: 2, bank_account: "Argenta Savings", display_name: "Argenta Savings", balance: 8100.2, transaction_count: 14 },
    { account_id: 3, bank_account: "Old Joint", display_name: "Old Joint", balance: 0, transaction_count: 31 },
];
const TOTAL = 2450.75 + 8100.2 + 0; // 10.550,95 €

// The entity population behind the CARDS: active accounts only, and the widget
// drops zero-balance ones — deliberately a different (smaller) set than above.
const ENTITY_ACCOUNTS = [
    {
        ...ACCOUNT_STUB,
        id: 1,
        name: "KBC Checking",
        display_name: "KBC Checking",
        computed_balance: 2450.75,
        // Fresh statement (10 days old) that disagrees with the ledger by -49,25.
        statement_balance: 2401.5,
        statement_balance_date: ymdDaysAgo(10),
        drift: -49.25,
        anchor_date: ymdDaysAgo(10),
        post_anchor_count: 3,
    },
    {
        ...ACCOUNT_STUB,
        id: 2,
        name: "Argenta Savings",
        display_name: "Argenta Savings",
        computed_balance: 8100.2,
        drift: null,
    },
    {
        ...ACCOUNT_STUB,
        id: 3,
        name: "Old Joint",
        display_name: "Old Joint",
        computed_balance: 0,
        drift: null,
    },
];

function mockWidgetApi({
    payloadAccounts = PAYLOAD_ACCOUNTS,
    total = TOTAL,
    entityAccounts = ENTITY_ACCOUNTS,
    history = {},
    totalHistory = [],
}: {
    payloadAccounts?: typeof PAYLOAD_ACCOUNTS;
    total?: number;
    entityAccounts?: unknown[];
    history?: Record<string, Array<{ date: string; balance: number }>>;
    totalHistory?: Array<{ date: string; balance: number }>;
} = {}) {
    server.use(
        http.get(`${API_BASE}/api/aggregations/bank-balances`, () =>
            aggOk({
                accounts: payloadAccounts,
                total_net_position: total,
                history,
                total_history: totalHistory,
            }),
        ),
        http.get(`${API_BASE}/api/accounts`, () =>
            ok({ items: entityAccounts, total: entityAccounts.length, links: [] }),
        ),
    );
}

describe("BankBalancesWidget (integration, WP-B2/B3 §3 F3)", () => {
    it("counts the population actually summed into the total beside it, not the card list", async () => {
        mockWidgetApi();
        renderWithApp(<BankBalancesWidget />);

        const heading = await screen.findByText("Total Net Liquid Position");
        const totalCard = heading.closest(".glass-regular") as HTMLElement;

        // The headline figure is the server's sum over its three payload rows
        // (compacted for display, full value in the title)…
        expect(within(totalCard).getByTitle(/10\.550,95/)).toBeInTheDocument();
        // …so the count beside it must be 3, NOT the 2 balance cards rendered
        // below (the zero-balance account is summed but has no card).
        expect(within(totalCard).getByText("Across 3 account(s)")).toBeInTheDocument();
        expect(within(totalCard).queryByText("Across 2 account(s)")).not.toBeInTheDocument();

        const cards = screen.getAllByRole("button", { name: /open details for/i });
        expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual([
            "Open details for KBC Checking",
            "Open details for Argenta Savings",
        ]);
    });

    it("keeps count and total consistent when the summed population changes", async () => {
        mockWidgetApi({
            payloadAccounts: PAYLOAD_ACCOUNTS.slice(0, 1),
            total: 2450.75,
        });
        renderWithApp(<BankBalancesWidget />);

        const heading = await screen.findByText("Total Net Liquid Position");
        const totalCard = heading.closest(".glass-regular") as HTMLElement;
        expect(within(totalCard).getByTitle(/2\.450,75/)).toBeInTheDocument();
        expect(within(totalCard).getByText("Across 1 account(s)")).toBeInTheDocument();
    });

    it("keeps the transaction count visible when aggregation and entity names diverge", async () => {
        mockWidgetApi({
            payloadAccounts: [
                {
                    ...PAYLOAD_ACCOUNTS[0],
                    bank_account: "STALE IMPORT LABEL",
                    transaction_count: 73,
                },
            ],
            total: 2450.75,
            entityAccounts: [ENTITY_ACCOUNTS[0]],
        });
        renderWithApp(<BankBalancesWidget />);

        const card = await screen.findByRole("button", { name: "Open details for KBC Checking" });
        expect(within(card).getByText("73 transactions")).toBeInTheDocument();
    });

    it("renders a drift chip on the card whose account carries drift, and none on the others", async () => {
        mockWidgetApi();
        renderWithApp(<BankBalancesWidget />);

        const drifting = await screen.findByRole("button", { name: "Open details for KBC Checking" });
        // Same wording + statement date as the Accounts hub badge.
        const chip = within(drifting).getByText(/^Drift/);
        expect(chip.textContent).toMatch(/-49,25/);
        expect(chip.textContent).toMatch(/statement/);
        // Fresh statement (10 days) → destructive tone, not the stale amber.
        expect(chip.className).toMatch(/text-destructive/);
        expect(chip.className).not.toMatch(/amber/);

        const clean = screen.getByRole("button", { name: "Open details for Argenta Savings" });
        expect(within(clean).queryByText(/^Drift/)).not.toBeInTheDocument();
    });

    // `computed_balance` is denominated in the ACCOUNT's currency (ADR-094), not
    // in the app's default — the same contract the Accounts hub card and
    // groupAccounts' converted subtotals honour. The card used to hard-code the
    // default currency, putting a € sign on a US$ figure.
    it("labels each card's computed balance in the account's own currency, not the app default", async () => {
        mockWidgetApi({
            entityAccounts: [
                { ...ENTITY_ACCOUNTS[0], id: 4, name: "Wise USD", display_name: "Wise USD", currency: "USD", computed_balance: 1234.5, statement_balance: null, statement_balance_date: null, drift: null },
                ENTITY_ACCOUNTS[1],
            ],
        });
        renderWithApp(<BankBalancesWidget />);

        // Compacted for display, full figure in the title (same as the total card).
        const usdCard = await screen.findByRole("button", { name: "Open details for Wise USD" });
        expect(within(usdCard).getByTitle(/1\.234,50/).textContent).toMatch(/\$/);
        expect(usdCard.textContent).not.toMatch(/€/);

        // The EUR account beside it still reads in euro — nothing global changed.
        const eurCard = screen.getByRole("button", { name: "Open details for Argenta Savings" });
        expect(eurCard.textContent).toMatch(/€/);
        expect(eurCard.textContent).not.toMatch(/\$/);
    });

    it("labels chart series from account entities and preserves the name and unmatched fallbacks", async () => {
        const friendlyIban = "BE68539007547034";
        const nameOnlyIban = "BE71096123456769";
        const unmatchedIban = "BE30001234567890";
        const friendlyHistory = [
            { date: "2026-08-20", balance: 1000 },
            { date: "2026-08-21", balance: 1100 },
        ];
        const nameOnlyHistory = [
            { date: "2026-08-20", balance: 200 },
            { date: "2026-08-21", balance: 250 },
        ];
        const unmatchedHistory = [
            { date: "2026-08-20", balance: 50 },
            { date: "2026-08-21", balance: 75 },
        ];
        mockWidgetApi({
            payloadAccounts: [
                {
                    account_id: 1,
                    bank_account: friendlyIban,
                    display_name: "Aggregation label must not win",
                    balance: 1100,
                    transaction_count: 2,
                },
                {
                    account_id: 2,
                    bank_account: nameOnlyIban,
                    display_name: "Another aggregation label",
                    balance: 250,
                    transaction_count: 1,
                },
                {
                    account_id: 99,
                    bank_account: unmatchedIban,
                    display_name: "Unmatched aggregation label",
                    balance: 75,
                    transaction_count: 1,
                },
            ],
            total: 1425,
            entityAccounts: [
                {
                    ...ENTITY_ACCOUNTS[0],
                    name: friendlyIban,
                    display_name: "KBC Daily",
                    computed_balance: 1100,
                    is_active: false,
                    in_net_worth: true,
                },
                {
                    ...ENTITY_ACCOUNTS[1],
                    name: nameOnlyIban,
                    display_name: undefined,
                    computed_balance: 250,
                    is_active: false,
                    in_net_worth: true,
                },
            ],
            history: {
                [friendlyIban]: friendlyHistory,
                [nameOnlyIban]: nameOnlyHistory,
                [unmatchedIban]: unmatchedHistory,
            },
            totalHistory: [
                { date: "2026-08-20", balance: 1250 },
                { date: "2026-08-21", balance: 1425 },
            ],
        });
        renderWithApp(<BankBalancesWidget />);

        const heading = await screen.findByText("Balance History");
        const historyCard = heading.closest(".glass-regular") as HTMLElement;
        expect(within(historyCard).getByText("KBC Daily")).toBeInTheDocument();
        expect(within(historyCard).queryByText("Aggregation label must not win")).not.toBeInTheDocument();
        expect(within(historyCard).queryByText("···07547034")).not.toBeInTheDocument();
        expect(within(historyCard).getByText(nameOnlyIban)).toBeInTheDocument();
        expect(within(historyCard).getByText("···34567890")).toBeInTheDocument();
        expect(within(historyCard).queryByText(unmatchedIban)).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Open details for KBC Daily" })).not.toBeInTheDocument();
    });

    it("renders a stale drift chip in warning tone once the statement reading ages past the threshold", async () => {
        mockWidgetApi({
            entityAccounts: [
                {
                    ...ENTITY_ACCOUNTS[0],
                    statement_balance_date: ymdDaysAgo(90),
                    anchor_date: ymdDaysAgo(90),
                },
            ],
        });
        renderWithApp(<BankBalancesWidget />);

        const card = await screen.findByRole("button", { name: "Open details for KBC Checking" });
        const chip = within(card).getByText(/^Drift/);
        expect(chip.className).toMatch(/amber/);
        expect(chip.className).not.toMatch(/text-destructive/);
    });
});
