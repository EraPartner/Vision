// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, ACCOUNT_STUB } from "@/test/msw/handlers";
import { toYmd } from "@/components/shared/dateUtils";
import { AddAccountDialog } from "@/features/accounts/AddAccountDialog";

const API_BASE = "http://localhost:3002";

function mockCreate() {
    const calls: { create: unknown[]; opening: Array<{ id: string; body: unknown }> } = {
        create: [],
        opening: [],
    };
    server.use(
        http.post(`${API_BASE}/api/accounts`, async ({ request }) => {
            calls.create.push(await request.json());
            return ok({ ...ACCOUNT_STUB, id: 77, name: "KBC Checking" });
        }),
        http.post(`${API_BASE}/api/accounts/:id/opening-balance`, async ({ request, params }) => {
            calls.opening.push({ id: String(params.id), body: await request.json() });
            return ok({
                transaction: { id: 1, balance: 123.45, transfer_source: "opening" },
                warning: null,
            });
        }),
    );
    return calls;
}

async function openCreateDialog(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /add account/i }));
    await screen.findByRole("dialog");
}

describe("AddAccountDialog (integration, WP-B5 §3 F4+F7)", () => {
    it("stamps the opening balance on the new account after create (§3 F4)", async () => {
        const calls = mockCreate();
        const user = userEvent.setup();
        renderWithApp(<AddAccountDialog />);

        await openCreateDialog(user);
        await user.type(screen.getByLabelText(/^name$/i), "KBC Checking");
        await user.type(screen.getByLabelText(/opening balance/i), "123,45");
        await user.click(screen.getByRole("button", { name: /create/i }));

        await waitFor(() => expect(calls.opening).toHaveLength(1));
        expect(calls.opening[0].id).toBe("77");
        expect(calls.opening[0].body).toEqual({
            balance: 123.45,
            date: toYmd(new Date()),
            currency: "EUR",
        });
        // The account payload itself does NOT carry the opening balance — it
        // lands as the visible 'opening' ledger row via the dedicated endpoint.
        expect(calls.create[0]).not.toHaveProperty("opening_balance");
    });

    it("creates without touching the opening-balance endpoint when the field is left empty", async () => {
        const calls = mockCreate();
        const user = userEvent.setup();
        renderWithApp(<AddAccountDialog />);

        await openCreateDialog(user);
        await user.type(screen.getByLabelText(/^name$/i), "KBC Checking");
        await user.click(screen.getByRole("button", { name: /create/i }));

        await waitFor(() => expect(calls.create).toHaveLength(1));
        expect(calls.opening).toHaveLength(0);
    });

    it("relabels the opening balance to 'Outstanding debt' for liability accounts (§3 F4)", async () => {
        mockCreate();
        const user = userEvent.setup();
        renderWithApp(<AddAccountDialog />);

        await openCreateDialog(user);
        expect(screen.getByLabelText(/opening balance/i)).toBeInTheDocument();

        await user.click(screen.getByRole("combobox", { name: /^type$/i }));
        await user.click(await screen.findByRole("option", { name: "Liability" }));

        expect(screen.getByLabelText(/outstanding debt/i)).toBeInTheDocument();
        expect(screen.queryByLabelText(/opening balance/i)).not.toBeInTheDocument();
    });

    it("auto-suggests display_name from name until the user edits it (§3 F7)", async () => {
        mockCreate();
        const user = userEvent.setup();
        renderWithApp(<AddAccountDialog />);

        await openCreateDialog(user);
        await user.type(screen.getByLabelText(/^name$/i), "BE68 IBAN");
        expect(screen.getByLabelText(/display name/i)).toHaveValue("BE68 IBAN");

        // Hand-editing the display name detaches it from the mirror…
        await user.clear(screen.getByLabelText(/display name/i));
        await user.type(screen.getByLabelText(/display name/i), "Daily");
        await user.type(screen.getByLabelText(/^name$/i), " 2");
        expect(screen.getByLabelText(/display name/i)).toHaveValue("Daily");
    });

    it("shows the name helper text and no longer renders the consumer-less fields (§3 F7)", async () => {
        mockCreate();
        const user = userEvent.setup();
        renderWithApp(<AddAccountDialog />);

        await openCreateDialog(user);
        expect(screen.getByText(/must match your bank import label/i)).toBeInTheDocument();

        // Open Advanced: owner/liquidity/spendable carry one-line hints; the
        // three consumer-less inputs are gone.
        await user.click(screen.getByRole("button", { name: /advanced/i }));
        expect(await screen.findByText(/whose money this is/i)).toBeInTheDocument();
        expect(screen.getByText(/how quickly this money could be spent/i)).toBeInTheDocument();
        expect(screen.getByText(/counts toward day-to-day spendable cash/i)).toBeInTheDocument();
        expect(screen.queryByText(/tax wrapper/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/holds a cash balance/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/multi-currency cash/i)).not.toBeInTheDocument();
    });

    // ── WP-B5 §3 F1: the statement fields are an EDIT-only concern ───────────

    it("does not offer the statement-balance fields on create (they only mint instant drift)", async () => {
        const calls = mockCreate();
        const user = userEvent.setup();
        renderWithApp(<AddAccountDialog />);

        await openCreateDialog(user);
        await user.click(screen.getByRole("button", { name: /advanced/i }));
        // Advanced is open (owner/liquidity are there)…
        expect(await screen.findByLabelText(/owner/i)).toBeInTheDocument();
        // …but the statement reading is not, on create.
        expect(screen.queryByLabelText(/statement balance/i)).not.toBeInTheDocument();
        expect(screen.queryByLabelText(/^as of$/i)).not.toBeInTheDocument();

        await user.type(screen.getByLabelText(/^name$/i), "KBC Checking");
        await user.click(screen.getByRole("button", { name: /create/i }));

        await waitFor(() => expect(calls.create).toHaveLength(1));
        const body = calls.create[0] as Record<string, unknown>;
        // A create payload must never carry a statement reading.
        expect(body.statement_balance).toBeUndefined();
        expect(body.statement_balance_date).toBeUndefined();
    });

    it("still offers (and validates) the statement-balance fields in edit mode", async () => {
        const user = userEvent.setup();
        const saved: unknown[] = [];
        const initialValues = {
            name: "KBC Checking", display_name: "KBC Checking", institution: "KBC",
            currency: "EUR", type: "checking" as const, owner: "me" as const,
            liquidity_class: "liquid" as const, tax_wrapper: "none" as const,
            spendable: true, in_net_worth: true, multi_currency_cash: false,
            has_cash_sleeve: true,
            // accountRepository.js emits the DATE as a bare YYYY-MM-DD (to_char),
            // which is what <input type="date"> wants; accountToFormValues also
            // slices defensively for any other source.
            statementBalance: "1284.4", statementBalanceDate: "2026-06-03",
        };
        renderWithApp(
            <AddAccountDialog
                mode="edit"
                open
                onOpenChange={() => {}}
                initialValues={initialValues}
                onSave={(v) => saved.push(v)}
            />,
        );

        // Advanced starts expanded in edit mode, statement fields populated.
        expect(await screen.findByLabelText(/statement balance/i)).toHaveValue("1284.4");
        expect(screen.getByLabelText(/^as of$/i)).toHaveValue("2026-06-03");

        // Clearing the date while a balance is set is still blocked (ADR-094).
        await user.clear(screen.getByLabelText(/^as of$/i));
        await user.click(screen.getByRole("button", { name: /^save$/i }));
        expect(saved).toHaveLength(0);

        await user.type(screen.getByLabelText(/^as of$/i), "2026-07-20");
        await user.click(screen.getByRole("button", { name: /^save$/i }));
        await waitFor(() => expect(saved).toHaveLength(1));
        expect(saved[0]).toMatchObject({
            statementBalance: "1284.4",
            statementBalanceDate: "2026-07-20",
        });
    });
});
