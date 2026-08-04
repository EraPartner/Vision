// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, ACCOUNT_STUB } from "@/test/msw/handlers";
import { OpeningBalanceDialog } from "@/features/accounts/OpeningBalanceDialog";
import type { Account } from "@/types/api";

vi.mock("sonner", () => ({
    toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const API_BASE = "http://localhost:3002";

// The anchor is stamped per (account, currency) and is a NATIVE figure. On this
// multi-currency account (100 EUR + 100 USD, USD at 0,5) `computed_balance` is
// the whole account converted into its own currency (150 €) and moves with FX,
// while the EUR partition — the one an anchor would be stamped for — holds 100 €
// and ships as `reconcilable_balance`. Offering 150 as the opening figure would
// seed the partition with a cross-currency total.
const MULTI_CURRENCY = {
    ...ACCOUNT_STUB,
    id: 9,
    name: "Wise",
    display_name: "Wise",
    currency: "EUR",
    computed_balance: 150,
    reconcilable_balance: 100,
    reconcilable_currency: "EUR",
} as unknown as Account;

// A mislabelled single-currency account: the ledger is USD, the account is still
// declared EUR. The anchor belongs to the USD partition, so both the prefilled
// figure and the stamped currency are that partition's.
const MISLABELLED = {
    ...ACCOUNT_STUB,
    id: 10,
    name: "Wise USD",
    display_name: "Wise USD",
    currency: "EUR",
    computed_balance: 500,
    reconcilable_balance: 1000,
    reconcilable_currency: "USD",
} as unknown as Account;

// The overwhelmingly common case, and the payload shape of any server/endpoint
// that does not return the reconcilable fields: behaviour must be unchanged.
const SINGLE_CURRENCY = {
    ...ACCOUNT_STUB,
    id: 11,
    name: "KBC Checking",
    display_name: "KBC Checking",
    currency: "EUR",
    computed_balance: 2450.75,
} as unknown as Account;

function mockOpeningBalanceApi() {
    const calls: Array<{ id: string; body: Record<string, unknown> }> = [];
    server.use(
        http.post(`${API_BASE}/api/accounts/:id/opening-balance`, async ({ request, params }) => {
            calls.push({
                id: String(params.id),
                body: (await request.json()) as Record<string, unknown>,
            });
            return ok({ transaction: { id: 1, balance: 0, transfer_source: "opening" }, warning: null });
        }),
    );
    return calls;
}

async function renderDialog(account: Account) {
    const result = renderWithApp(
        <OpeningBalanceDialog account={account} open onOpenChange={() => {}} />,
    );
    // The locale dictionary is a lazy dynamic import — wait for the first
    // translated string before querying by label.
    await screen.findByRole("heading", { name: "Set opening balance" });
    return result;
}

/** The amount field, whose label carries the currency the anchor is stamped in. */
function balanceInput() {
    return screen.getByLabelText(/^Opening balance/) as HTMLInputElement;
}

describe("OpeningBalanceDialog (integration) — anchors in the partition's own currency", () => {
    it("prefills the reconciliation base, not the FX-converted computed total", async () => {
        mockOpeningBalanceApi();
        await renderDialog(MULTI_CURRENCY);

        // 100 (the EUR partition) — NOT 150 (every partition converted into EUR).
        expect(balanceInput().value).toBe("100");
        expect(screen.getByText(/^Opening balance \(EUR\)$/)).toBeInTheDocument();
    });

    it("prefills and stamps in reconcilable_currency when it differs from the declared one", async () => {
        const calls = mockOpeningBalanceApi();
        const user = userEvent.setup();
        await renderDialog(MISLABELLED);

        expect(balanceInput().value).toBe("1000");
        expect(screen.getByText(/^Opening balance \(USD\)$/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Set opening balance" }));

        await vi.waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0].id).toBe("10");
        // The stamped figure and its currency are one native pair: 1000 US$,
        // never 500 (the same money converted into the declared EUR).
        expect(calls[0].body).toMatchObject({ balance: 1000, currency: "USD" });
    });

    it("falls back to the computed balance and the account currency without the reconcilable fields", async () => {
        const calls = mockOpeningBalanceApi();
        const user = userEvent.setup();
        await renderDialog(SINGLE_CURRENCY);

        expect(balanceInput().value).toBe("2450.75");
        expect(screen.getByText(/^Opening balance \(EUR\)$/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Set opening balance" }));

        await vi.waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0].body).toMatchObject({ balance: 2450.75, currency: "EUR" });
    });

    it("still prefers a stored statement reading over either computed figure", async () => {
        mockOpeningBalanceApi();
        await renderDialog({ ...MULTI_CURRENCY, statement_balance: 120 } as Account);

        expect(balanceInput().value).toBe("120");
    });
});
