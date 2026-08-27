// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { useLocation } from "react-router";
import { QueryClient } from "@tanstack/react-query";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err, ACCOUNT_STUB } from "@/test/msw/handlers";
import { toYmd } from "@/components/shared/dateUtils";
import { ReconcileDialog } from "@/features/accounts/ReconcileDialog";
import type { Account } from "@/types/api";
import { toast } from "sonner";

vi.mock("sonner", () => ({
    toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

/** A YYYY-MM-DD calendar day `n` days before today, in the LOCAL calendar. */
function ymdDaysAgo(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return toYmd(d);
}
const TODAY = toYmd(new Date());

const API_BASE = "http://localhost:3002";

// Realistic drift: the ledger says 1.000,00 €, the last statement said 980,00 €,
// so the stored drift is NEGATIVE (the statement is behind the ledger).
// `statement_balance_date` is a bare YYYY-MM-DD — accountRepository.js emits it
// through to_char, so that is the real wire shape (the ISO-timestamp defensive
// path is covered once, in the AccountsPage fixtures).
const DRIFTING = {
    ...ACCOUNT_STUB,
    id: 7,
    name: "KBC Checking",
    display_name: "KBC Checking",
    type: "checking",
    currency: "EUR",
    computed_balance: 1000,
    statement_balance: 980,
    statement_balance_date: "2026-06-03",
    drift: -20,
    anchor_date: "2026-06-03",
    post_anchor_count: 4,
} as unknown as Account;

// A liability whose balances are negative on both sides — the sign handling in
// the preview must survive that, not just happy-path positives.
const LIABILITY = {
    ...ACCOUNT_STUB,
    id: 8,
    name: "Mortgage",
    display_name: "Mortgage",
    type: "liability",
    currency: "EUR",
    computed_balance: -152_340.5,
    statement_balance: -152_000,
    statement_balance_date: "2026-07-01",
    drift: 340.5,
    anchor_date: "2026-07-01",
    post_anchor_count: 1,
} as unknown as Account;

// The multi-currency account the per-currency balance work exists for: 100 EUR
// + 100 USD with USD at 0,5. `computed_balance` is the whole account converted
// into its own currency (150 €) and moves with FX; the server reconciles against
// the EUR partition alone (100 €) and ships it as `reconcilable_balance`. The
// stored drift is 120 − 100 = +20 — NOT 120 − 150.
const MULTI_CURRENCY = {
    ...ACCOUNT_STUB,
    id: 9,
    name: "Wise",
    display_name: "Wise",
    type: "checking",
    currency: "EUR",
    computed_balance: 150,
    reconcilable_balance: 100,
    reconcilable_currency: "EUR",
    statement_balance: 120,
    statement_balance_date: "2026-06-03",
    drift: 20,
    anchor_date: "2026-06-03",
    post_anchor_count: 2,
} as unknown as Account;

// A mislabelled single-currency account: the ledger is USD, the account is still
// declared EUR. It has one partition, so it reconciles against that partition in
// ITS code — statement, base and difference are all US$, while computed_balance
// is the same money converted into the declared EUR.
const MISLABELLED = {
    ...ACCOUNT_STUB,
    id: 10,
    name: "Wise USD",
    display_name: "Wise USD",
    type: "checking",
    currency: "EUR",
    computed_balance: 500,
    reconcilable_balance: 1000,
    reconcilable_currency: "USD",
    statement_balance: 1000,
    statement_balance_date: "2026-06-03",
    drift: 0,
    anchor_date: "2026-06-03",
    post_anchor_count: 1,
} as unknown as Account;

// The statement names a currency the account holds nothing in: the base is 0,
// which is exactly what 'accept' would write. Showing that 0 is what stops the
// resolution writing a figure the user was never shown.
const EMPTY_BASE = {
    ...ACCOUNT_STUB,
    id: 11,
    name: "GBP shell",
    display_name: "GBP shell",
    type: "checking",
    currency: "GBP",
    computed_balance: 75,
    reconcilable_balance: 0,
    reconcilable_currency: "GBP",
    statement_balance: 50,
    statement_balance_date: "2026-06-03",
    drift: 50,
    anchor_date: "2026-06-03",
    post_anchor_count: 2,
} as unknown as Account;

const UNANCHORED = {
    ...DRIFTING,
    id: 12,
    anchor_date: null,
    statement_balance: 980,
    statement_balance_date: "2026-06-03",
} as unknown as Account;

function mockAccountApi({ reconcileFails = false } = {}) {
    const calls: {
        patch: Array<{ id: string; body: Record<string, unknown> }>;
        reconcile: Array<{ id: string; body: Record<string, unknown> }>;
        opening: Array<{ id: string; body: Record<string, unknown> }>;
    } = { patch: [], reconcile: [], opening: [] };
    server.use(
        http.patch(`${API_BASE}/api/accounts/:id`, async ({ request, params }) => {
            calls.patch.push({
                id: String(params.id),
                body: (await request.json()) as Record<string, unknown>,
            });
            return ok(ACCOUNT_STUB);
        }),
        http.post(`${API_BASE}/api/accounts/:id/reconcile`, async ({ request, params }) => {
            calls.reconcile.push({
                id: String(params.id),
                body: (await request.json()) as Record<string, unknown>,
            });
            if (reconcileFails) return err(500, "reconcile blew up");
            return ok({
                mode: "accept",
                drift: 0,
                statement_balance: 1000,
                computed_balance: 1000,
                transaction: null,
            });
        }),
        http.post(`${API_BASE}/api/accounts/:id/opening-balance`, async ({ request, params }) => {
            calls.opening.push({
                id: String(params.id),
                body: (await request.json()) as Record<string, unknown>,
            });
            return ok({ warning: null });
        }),
    );
    return calls;
}

function LocationProbe() {
    const loc = useLocation();
    return <div data-testid="location">{`${loc.pathname}${loc.search}`}</div>;
}

async function renderDialog(account: Account, queryClient?: QueryClient) {
    const result = renderWithApp(
        <>
            <ReconcileDialog account={account} open onOpenChange={() => {}} />
            <LocationProbe />
        </>,
        { initialEntries: ["/dashboard"], ...(queryClient ? { queryClient } : {}) },
    );
    // The locale dictionary is a lazy dynamic import — wait for the first
    // translated string before querying by label/name.
    await screen.findByRole("heading", { name: "Reconcile balance" });
    return result;
}

/** The live difference figure (stored drift, or the preview once typed into). */
function deltaText() {
    return screen.getByTestId("reconcile-delta").textContent ?? "";
}

/** The reconciliation-base row, rendered only when it differs from computed. */
function baseText() {
    return screen.queryByTestId("reconcile-base")?.textContent ?? null;
}

beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
});

describe("ReconcileDialog (integration, WP-B5 §3 F1 fresh reading + exits)", () => {
    it("uses the outline Cancel convention", async () => {
        mockAccountApi();
        await renderDialog(DRIFTING);

        expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass(
            "border",
            "border-input/70",
        );
    });

    it("previews the drift the entered reading would produce, live, as the user types", async () => {
        mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(DRIFTING);

        // Before typing: the STORED drift (statement 980 − computed 1000).
        expect(deltaText()).toMatch(/-20,00/);
        expect(deltaText()).not.toMatch(/\+/);

        // A fresh reading ABOVE the ledger → positive preview (+42,75).
        const reading = screen.getByLabelText(/new statement reading/i);
        await user.type(reading, "1042,75");
        await waitFor(() => expect(deltaText()).toMatch(/\+.*42,75/));
        expect(screen.getByText(/preview for the reading you entered/i)).toBeInTheDocument();

        // Retyping BELOW the ledger flips the sign (no stale +).
        await user.clear(reading);
        await user.type(reading, "912,40");
        await waitFor(() => expect(deltaText()).toMatch(/-87,60/));
        expect(deltaText()).not.toMatch(/\+/);

        // Clearing the input falls back to the stored drift, never blank.
        await user.clear(reading);
        await waitFor(() => expect(deltaText()).toMatch(/-20,00/));
    });

    it("previews correctly for a liability whose balances are negative on both sides", async () => {
        mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(LIABILITY);

        // Stored: statement -152.000 − computed -152.340,50 = +340,50.
        expect(deltaText()).toMatch(/\+.*340,50/);

        // A fresh (still negative) reading of -152.500,00 owes 159,50 MORE than
        // the ledger knows about → -159,50.
        await user.type(screen.getByLabelText(/new statement reading/i), "-152500");
        await waitFor(() => expect(deltaText()).toMatch(/-159,50/));
    });

    it("saves a fresh reading through the account PATCH path (no new endpoint)", async () => {
        const calls = mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(DRIFTING);

        await user.type(screen.getByLabelText(/new statement reading/i), "1042,75");
        await user.clear(screen.getByLabelText(/^as of$/i));
        await user.type(screen.getByLabelText(/^as of$/i), "2026-07-20");
        await user.click(screen.getByRole("button", { name: /save reading/i }));

        await waitFor(() => expect(calls.patch).toHaveLength(1));
        expect(calls.patch[0].id).toBe("7");
        expect(calls.patch[0].body).toEqual({
            statement_balance: 1042.75,
            statement_balance_date: "2026-07-20",
        });
        // Saving a reading alone must NOT reconcile anything.
        expect(calls.reconcile).toHaveLength(0);
    });

    it("keeps Save reading disabled until a parseable reading is entered", async () => {
        mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(DRIFTING);

        const save = screen.getByRole("button", { name: /save reading/i });
        expect(save).toBeDisabled();

        // A lone minus sign is not a reading.
        await user.type(screen.getByLabelText(/new statement reading/i), "-");
        expect(save).toBeDisabled();

        await user.type(screen.getByLabelText(/new statement reading/i), "5");
        await waitFor(() => expect(save).toBeEnabled());
    });

    it("records the fresh reading BEFORE reconciling, so the resolution follows the entered figure", async () => {
        const calls = mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(DRIFTING);

        await user.type(screen.getByLabelText(/new statement reading/i), "1042,75");
        await user.click(screen.getByRole("button", { name: /add adjustment transaction/i }));

        await waitFor(() => expect(calls.reconcile).toHaveLength(1));
        expect(calls.patch).toHaveLength(1);
        expect(calls.patch[0].body.statement_balance).toBe(1042.75);
        expect(calls.reconcile[0].body).toEqual({ mode: "adjustment" });
    });

    it("resolves against the STORED figure when no fresh reading is entered (unchanged behaviour)", async () => {
        const calls = mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(DRIFTING);

        await user.click(screen.getByRole("button", { name: /accept computed balance/i }));

        await waitFor(() => expect(calls.reconcile).toHaveLength(1));
        expect(calls.patch).toHaveLength(0);
        expect(calls.reconcile[0].body).toEqual({ mode: "accept" });
    });

    it("backfills an opening balance from the valid fresh reading and date", async () => {
        const calls = mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(UNANCHORED);

        await user.type(screen.getByLabelText(/new statement reading/i), "1042,75");
        await user.clear(screen.getByLabelText(/^as of$/i));
        await user.type(screen.getByLabelText(/^as of$/i), "2026-07-20");
        await user.click(screen.getByRole("button", { name: /opening balance/i }));

        await waitFor(() => expect(calls.opening).toHaveLength(1));
        expect(calls.opening[0]).toEqual({
            id: "12",
            body: { balance: 1042.75, date: "2026-07-20", currency: "EUR" },
        });
    });

    it("keeps the stored statement as the opening-balance fallback when no draft exists", async () => {
        const calls = mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(UNANCHORED);

        await user.click(screen.getByRole("button", { name: /opening balance/i }));

        await waitFor(() => expect(calls.opening).toHaveLength(1));
        expect(calls.opening[0].body).toEqual({
            balance: 980,
            date: "2026-06-03",
            currency: "EUR",
        });
    });

    it.each([
        ["garbage", false],
        ["1042,75", true],
    ])("does not silently backfill the stored statement for an unusable draft %#", async (draft, clearDate) => {
        const calls = mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(UNANCHORED);

        await user.type(screen.getByLabelText(/new statement reading/i), draft);
        if (clearDate) await user.clear(screen.getByLabelText(/^as of$/i));

        expect(screen.queryByRole("button", { name: /opening balance/i })).not.toBeInTheDocument();
        expect(calls.opening).toHaveLength(0);
    });

    it("stops at the PATCH when the fresh reading already matches the ledger (server rejects zero-drift reconciles)", async () => {
        const calls = mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(DRIFTING);

        // computed_balance is exactly 1000 — entering it leaves nothing to resolve.
        await user.type(screen.getByLabelText(/new statement reading/i), "1000");
        await waitFor(() => expect(deltaText()).toMatch(/0,00/));
        await user.click(screen.getByRole("button", { name: /accept computed balance/i }));

        await waitFor(() => expect(calls.patch).toHaveLength(1));
        expect(calls.reconcile).toHaveLength(0);
    });

    it("blocks resolving (and says why) when a reading is entered but its as-of date is cleared", async () => {
        const calls = mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(DRIFTING);

        await user.type(screen.getByLabelText(/new statement reading/i), "1042,75");
        await user.clear(screen.getByLabelText(/^as of$/i));

        expect(await screen.findByText(/add the as-of date for this reading/i)).toBeInTheDocument();
        // Resolving against the STORED figure while the preview shows another
        // number would be a silent money bug — both exits are closed instead.
        expect(screen.getByRole("button", { name: /accept computed balance/i })).toBeDisabled();
        expect(screen.getByRole("button", { name: /add adjustment transaction/i })).toBeDisabled();
        expect(screen.getByRole("button", { name: /save reading/i })).toBeDisabled();
        expect(calls.patch).toHaveLength(0);
        expect(calls.reconcile).toHaveLength(0);
    });

    it("deep-links 'Show transactions since' to the STORED statement day, sliced off its ISO timestamp", async () => {
        mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(DRIFTING);

        // Label carries the app-formatted day (DD/MM/YYYY default), not the timestamp.
        const exit = screen.getByRole("button", { name: /show transactions since 03\/06\/2026/i });
        await user.click(exit);

        await waitFor(() =>
            expect(screen.getByTestId("location")).toHaveTextContent("/accounts/7?since=2026-06-03"),
        );
    });

    it("deep-links to the freshly entered as-of date once a reading is being recorded", async () => {
        mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(DRIFTING);

        await user.type(screen.getByLabelText(/new statement reading/i), "1042,75");
        await user.clear(screen.getByLabelText(/^as of$/i));
        await user.type(screen.getByLabelText(/^as of$/i), "2026-07-20");

        await user.click(await screen.findByRole("button", { name: /show transactions since 20\/07\/2026/i }));
        await waitFor(() =>
            expect(screen.getByTestId("location")).toHaveTextContent("/accounts/7?since=2026-07-20"),
        );
    });
    // ── Round 2: money-safety guards ────────────────────────────────────────

    it("warns, naming the date, when the reading is backdated — and offers the ledger exit as the way out", async () => {
        mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(DRIFTING);

        await user.type(screen.getByLabelText(/new statement reading/i), "800");
        await user.clear(screen.getByLabelText(/^as of$/i));
        await user.type(screen.getByLabelText(/^as of$/i), ymdDaysAgo(26));

        // The server computes drift against the balance as of NOW and stamps any
        // adjustment TODAY, so a backdated reading can mint a bogus row.
        const warning = await screen.findByText(/anything you spent or received after that date/i);
        expect(warning.textContent).toContain(
            ymdDaysAgo(26).split("-").reverse().join("/"),
        );
        // The recommended path sits inside the same callout.
        const callout = warning.closest("div") as HTMLElement;
        expect(callout.querySelector("button")).toHaveTextContent(/show transactions since/i);

        // Warned, NOT blocked — a days-old statement with no later activity is legitimate.
        expect(screen.getByRole("button", { name: /add adjustment transaction/i })).toBeEnabled();
        expect(screen.getByRole("button", { name: /accept computed balance/i })).toBeEnabled();
    });

    it("does not warn when the reading is dated today", async () => {
        mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(DRIFTING);

        // The date input already defaults to today.
        expect(screen.getByLabelText(/^as of$/i)).toHaveValue(TODAY);
        await user.type(screen.getByLabelText(/new statement reading/i), "800");

        await waitFor(() => expect(deltaText()).toMatch(/-200,00/));
        expect(screen.queryByText(/anything you spent or received after that date/i))
            .not.toBeInTheDocument();
    });

    it.each([
        ["12,,3", "a doubled separator that parseLocaleNumber would read as 12"],
        ["1234..56", "doubled dots parseLocaleNumber would read as 123456"],
        ["-", "a lone sign"],
        ["12 34", "an embedded space"],
    ])("refuses %s as money (%s)", async (typo) => {
        const calls = mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(DRIFTING);

        await user.type(screen.getByLabelText(/new statement reading/i), typo);

        expect(await screen.findByText(/enter a plain amount/i)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /save reading/i })).toBeDisabled();
        // The preview stays on the STORED drift — it never previews a typo.
        expect(deltaText()).toMatch(/-20,00/);

        // The resolutions treat it as "no reading": stored-value path, no PATCH.
        await user.click(screen.getByRole("button", { name: /accept computed balance/i }));
        await waitFor(() => expect(calls.reconcile).toHaveLength(1));
        expect(calls.patch).toHaveLength(0);
    });

    it("rounds the reading to cents so the preview matches the PATCHed figure (input policy — storage is NUMERIC(18,4) since 0088)", async () => {
        const calls = mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(DRIFTING);

        // 1000.005 rounds AWAY from zero to 1000,01 — a real 0,01 drift against
        // the computed 1000,00. Previewing it as "no drift" and toasting success
        // would leave an unresolved difference on the account.
        await user.type(screen.getByLabelText(/new statement reading/i), "1000.005");
        await waitFor(() => expect(deltaText()).toMatch(/\+.*0,01/));

        await user.click(screen.getByRole("button", { name: /add adjustment transaction/i }));
        await waitFor(() => expect(calls.patch).toHaveLength(1));
        // The PATCH carries the ROUNDED figure, so stored == previewed.
        expect(calls.patch[0].body.statement_balance).toBe(1000.01);
        // 0,01 > the half-cent epsilon, so it is a real reconcile, not a no-op.
        expect(calls.reconcile).toHaveLength(1);
    });

    it("treats a sub-half-cent difference as already reconciled and stops at the PATCH", async () => {
        const calls = mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(DRIFTING);

        // 1000.004 rounds to 1000,00 — identical to the computed balance.
        await user.type(screen.getByLabelText(/new statement reading/i), "1000.004");
        await waitFor(() => expect(deltaText()).toMatch(/0,00/));

        await user.click(screen.getByRole("button", { name: /add adjustment transaction/i }));
        await waitFor(() => expect(calls.patch).toHaveLength(1));
        expect(calls.patch[0].body.statement_balance).toBe(1000);
        expect(calls.reconcile).toHaveLength(0);
    });

    it("re-anchors on 'accept' after recording a fresh reading (PATCH, then reconcile)", async () => {
        const calls = mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(DRIFTING);

        await user.type(screen.getByLabelText(/new statement reading/i), "1042,75");
        await waitFor(() => expect(deltaText()).toMatch(/\+.*42,75/));
        await user.click(screen.getByRole("button", { name: /accept computed balance/i }));

        await waitFor(() => expect(calls.reconcile).toHaveLength(1));
        // Order matters: the statement lands first so the server's drift (and so
        // the resolution) is computed against the figure the user just typed.
        expect(calls.patch).toHaveLength(1);
        expect(calls.patch[0].body).toEqual({
            statement_balance: 1042.75,
            statement_balance_date: TODAY,
        });
        expect(calls.reconcile[0].body).toEqual({ mode: "accept" });
        await waitFor(() =>
            expect(toast.success).toHaveBeenCalledWith(
                "Statement balance updated to the computed figure",
            ),
        );
    });

    it("refetches account-derived data when the reconcile half of a PATCH+reconcile fails", async () => {
        const calls = mockAccountApi({ reconcileFails: true });
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 }, mutations: { retry: false } },
        });
        const invalidate = vi.spyOn(queryClient, "invalidateQueries");
        const user = userEvent.setup();
        await renderDialog(DRIFTING, queryClient);

        await user.type(screen.getByLabelText(/new statement reading/i), "1042,75");
        invalidate.mockClear();
        await user.click(screen.getByRole("button", { name: /add adjustment transaction/i }));

        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        // The PATCH landed; the reconcile did not. Leaving the cache alone would
        // show the OLD drift for up to the 2-minute staleTime.
        expect(calls.patch).toHaveLength(1);
        expect(invalidate).toHaveBeenCalled();
        const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
        expect(keys.some((k) => k?.includes("accounts"))).toBe(true);
    });

    // ── Multi-currency: preview against the base the SERVER resolves against ──
    //
    // The defect: the dialog previewed `entered − computed_balance` while the
    // server stamps `entered − reconcilable_balance`. On this fixture that made
    // typing the true statement figure (120) promise −30 while the server would
    // stamp +20, and typing the partition figure (100) promise −50 before the
    // server rejected it as already reconciled.
    it("previews an entered reading against the reconciliation base, not the converted balance", async () => {
        mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(MULTI_CURRENCY);

        // Stored: 120 − 100 = +20 (the figure the badge and the server agree on).
        expect(deltaText()).toMatch(/\+.*20,00/);

        // Retyping the SAME statement figure must reproduce it, not −30.
        const reading = screen.getByLabelText(/new statement reading/i);
        await user.type(reading, "120");
        await waitFor(() => expect(deltaText()).toMatch(/\+.*20,00/));
        expect(deltaText()).not.toMatch(/30,00/);

        // Typing the base itself is a reconciled account — the server's
        // "already reconciled" case — so the preview must read zero, not −50.
        await user.clear(reading);
        await user.type(reading, "100");
        await waitFor(() => expect(deltaText()).toMatch(/0,00/));
        expect(deltaText()).not.toMatch(/50,00/);
    });

    it("shows the base as its own labelled row, and the three figures agree on screen", async () => {
        mockAccountApi();
        await renderDialog(MULTI_CURRENCY);

        // statement (120) − base (100) = difference (+20), all in euro; the
        // converted whole-account figure is shown separately as the computed
        // balance so neither number is mistaken for the other.
        expect(baseText()).toMatch(/100,00/);
        expect(screen.getByText(/reconciles against \(EUR\)/i)).toBeInTheDocument();
        expect(screen.getByText(/does not move with exchange rates/i)).toBeInTheDocument();
        expect(deltaText()).toMatch(/\+.*20,00/);
    });

    // The overwhelmingly common case must look exactly as it did before.
    it("hides the base row entirely on a single-currency account", async () => {
        mockAccountApi();
        await renderDialog(DRIFTING);

        expect(baseText()).toBeNull();
        expect(screen.queryByText(/reconciles against/i)).not.toBeInTheDocument();
    });

    // A payload without the field (older server, or the account-detail endpoint,
    // which does not return it) must behave exactly as it did before.
    it("falls back to the computed balance when the payload carries no base", async () => {
        mockAccountApi();
        const user = userEvent.setup();
        const { reconcilable_balance: _b, reconcilable_currency: _c, ...legacy } =
            MULTI_CURRENCY as Account & { reconcilable_balance?: number; reconcilable_currency?: string };
        await renderDialog(legacy as Account);

        expect(baseText()).toBeNull();
        await user.type(screen.getByLabelText(/new statement reading/i), "120");
        await waitFor(() => expect(deltaText()).toMatch(/-30,00/)); // 120 − 150
    });

    // D3: the base's currency is the ledger's, not the (wrong) declared one, so
    // every native figure on screen is labelled with the money it actually is.
    it("labels the native triple in the base currency on a mislabelled account", async () => {
        mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(MISLABELLED);

        // Base and difference in US$; the computed balance stays in the
        // account's declared EUR, since that is what it was converted into.
        expect(baseText()).toMatch(/1\.000,00/);
        expect(baseText()).toContain('$');
        expect(screen.getByText(/reconciles against \(USD\)/i)).toBeInTheDocument();
        expect(deltaText()).toContain('$');
        // …while the computed balance stays the converted, euro-denominated one.
        expect(screen.getByText(/500,00/).textContent).toContain('€');

        // …and the preview stays in that same currency and base.
        await user.type(screen.getByLabelText(/new statement reading/i), "1100");
        await waitFor(() => expect(deltaText()).toMatch(/\+.*100,00/));
        expect(deltaText()).toContain('$');
    });

    // D4: 'accept' writes the base. Rendering it means the user sees the 0 it
    // will adopt before clicking, instead of a figure that appears from nowhere.
    it("shows the zero base that 'accept' would adopt when nothing is held in the statement currency", async () => {
        const calls = mockAccountApi();
        const user = userEvent.setup();
        await renderDialog(EMPTY_BASE);

        expect(baseText()).toMatch(/0,00/);
        expect(deltaText()).toMatch(/\+.*50,00/); // 50 − 0
        await user.click(screen.getByRole("button", { name: /accept computed balance/i }));

        await waitFor(() => expect(calls.reconcile).toHaveLength(1));
        expect(calls.reconcile[0].body).toEqual({ mode: "accept" });
    });
});
