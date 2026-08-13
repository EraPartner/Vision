// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { toast } from "sonner";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import { AddTransactionDialog } from "@/features/transactions/components/AddTransactionDialog";
import { todayYmd } from "@/lib/timezone";

const API_BASE = "http://localhost:3002";

const testRecipient = {
    id: 7,
    name: "Test Supermarket",
    is_active: true,
    created_at: "2025-01-01T00:00:00Z",
    links: [],
};

const testRecipientsList = {
    items: [testRecipient],
    total: 1,
    limit: 200,
    offset: 0,
    links: [],
};


// The bank-account field is an AccountCombobox (Phase B2, ADR-088 addendum D1):
// open it, type the label, and take the explicit-create escape hatch (the MSW
// accounts list is empty, so every label is "new").
async function pickBankAccount(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(screen.getByLabelText(/bank account/i));
    await user.type(screen.getByPlaceholderText(/search or type a new account/i), name);
    await user.click(await screen.findByText(new RegExp(`create account "${name}"`, "i")));
}

async function pickRecipient(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(screen.getByRole("combobox", { name: /recipient/i }));
    await user.click(await screen.findByRole("option", { name }));
}

describe("AddTransactionDialog (integration)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("opens dialog and shows required form fields", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddTransactionDialog />);

        await user.click(await screen.findByRole("button", { name: /add transaction/i }));

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(screen.getByLabelText(/amount/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/bank account/i)).toBeInTheDocument();
    });

    it("closes the dialog when Cancel is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddTransactionDialog />);

        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        expect(await screen.findByRole("dialog")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /cancel/i }));
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("submits POST /api/transactions and closes dialog on success", async () => {
        const user = userEvent.setup();
        let capturedBody: unknown;

        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(testRecipientsList)),
            http.post(`${API_BASE}/api/transactions`, async ({ request }) => {
                capturedBody = await request.json();
                return ok({
                    id: 42,
                    transaction_date: "2026-04-29",
                    bank_account: "Main",
                    amount: 12.5,
                    currency: "EUR",
                    recipient_id: 7,
                });
            }),
        );

        renderWithApp(<AddTransactionDialog />);

        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        await user.type(screen.getByLabelText(/amount/i), "12.50");
        await pickBankAccount(user, "Main");
        await pickRecipient(user, "Test Supermarket");

        await user.click(screen.getByRole("button", { name: /create/i }));

        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
        expect((capturedBody as Record<string, unknown>).recipient_id).toBe(7);
    });

    it("closes dialog when Escape is pressed", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddTransactionDialog />);

        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        expect(await screen.findByRole("dialog")).toBeInTheDocument();

        await user.keyboard("{Escape}");

        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("shows currency and recipient comboboxes in the open dialog", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddTransactionDialog />);

        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        // Dialog contains comboboxes for currency and recipient (both Radix Select triggers)
        const comboboxes = screen.getAllByRole("combobox");
        expect(comboboxes.length).toBeGreaterThanOrEqual(2);
    });

    it("shows Date, Memo, Category, and Comment fields in dialog", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddTransactionDialog />);

        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        // form.addTransaction.date = "Date" — label text (DatePicker, no form control assoc)
        expect(screen.getByText(/^date$/i)).toBeInTheDocument();
        // addTxn.descMemo = "Description / Memo" — id="tx_memo"
        expect(screen.getByLabelText(/description.*memo/i)).toBeInTheDocument();
        // addTxn.categoryOptional = "Category (optional)"
        expect(screen.getByText(/category \(optional\)/i)).toBeInTheDocument();
        // addTxn.commentOptional = "Comment (optional)" — id="tx_comment"
        expect(screen.getByLabelText(/comment \(optional\)/i)).toBeInTheDocument();
    });

    it("shows the backdated note when the chosen account's anchor is on/after the entered date (WP-B2)", async () => {
        const user = userEvent.setup();

        // Anchored account: the stamped statement date is far in the future, so
        // the dialog's default date (today) is always on/before the anchor.
        server.use(
            http.get(`${API_BASE}/api/accounts`, () =>
                ok({
                    items: [
                        {
                            id: 3,
                            name: "Main",
                            currency: "EUR",
                            type: "checking",
                            liquidity_class: "liquid",
                            spendable: true,
                            in_net_worth: true,
                            tax_wrapper: "none",
                            owner: "me",
                            multi_currency_cash: false,
                            has_cash_sleeve: false,
                            is_active: true,
                            created_at: "2025-01-01T00:00:00Z",
                            updated_at: "2025-01-01T00:00:00Z",
                            computed_balance: 100,
                            anchor_date: "2099-12-31",
                            post_anchor_count: 0,
                        },
                    ],
                    total: 1,
                    links: [],
                }),
            ),
        );

        renderWithApp(<AddTransactionDialog />);

        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        // No account chosen yet → no note.
        expect(screen.queryByText(/balance won't change/i)).not.toBeInTheDocument();

        // Pick the anchored account from the combobox.
        await user.click(screen.getByLabelText(/bank account/i));
        await user.click(await screen.findByText("Main"));

        expect(
            await screen.findByText(/dated before the .* bank statement/i),
        ).toBeInTheDocument();
    });

    it("shows duplicate error toast when server returns 409", async () => {
        const user = userEvent.setup();
        const toastSpy = vi.spyOn(toast, "error");

        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(testRecipientsList)),
            http.post(`${API_BASE}/api/transactions`, () =>
                err(409, "Duplicate transaction detected"),
            ),
        );

        renderWithApp(<AddTransactionDialog />);

        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        await user.type(screen.getByLabelText(/amount/i), "12.50");
        await pickBankAccount(user, "Main");
        await pickRecipient(user, "Test Supermarket");

        await user.click(screen.getByRole("button", { name: /create/i }));

        await waitFor(() =>
            expect(toastSpy).toHaveBeenCalledWith(
                expect.stringMatching(/duplicate transaction detected/i),
            ),
        );
    });

    it("keeps dialog open when server returns 500 error", async () => {
        const user = userEvent.setup();
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        let postCalled = false;

        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(testRecipientsList)),
            http.post(`${API_BASE}/api/transactions`, () => {
                postCalled = true;
                return err(500, "server error");
            }),
        );

        renderWithApp(<AddTransactionDialog />);

        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        await user.type(screen.getByLabelText(/amount/i), "12.50");
        await pickBankAccount(user, "Main");
        await pickRecipient(user, "Test Supermarket");

        await user.click(screen.getByRole("button", { name: /create/i }));

        // Wait for POST to actually fire, then confirm dialog stays open
        await waitFor(() => expect(postCalled).toBe(true), { timeout: 5000 });
        expect(screen.queryByRole("dialog")).toBeInTheDocument();

        consoleSpy.mockRestore();
    });

    it("shows error toast when server returns 422 validation error", async () => {
        const user = userEvent.setup();
        const toastSpy = vi.spyOn(toast, "error");

        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(testRecipientsList)),
            http.post(`${API_BASE}/api/transactions`, () =>
                err(422, "amount must be positive"),
            ),
        );

        renderWithApp(<AddTransactionDialog />);

        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        await user.type(screen.getByLabelText(/amount/i), "12.50");
        await pickBankAccount(user, "Main");
        await pickRecipient(user, "Test Supermarket");

        await user.click(screen.getByRole("button", { name: /create/i }));

        await waitFor(() =>
            expect(toastSpy).toHaveBeenCalledWith(
                expect.stringMatching(/failed to create transaction/i),
                expect.anything(),
            ),
        );
    });

    // ─── Inline field validation (ARIA-associated, replaces the old toasts) ──
    //
    // Field validation used to be announced only through `toast.error(...)`:
    // transient, and detached from the control that failed. It now renders on
    // the field, linked by `aria-describedby`, with `aria-invalid` on the
    // control — so these assert the linkage, not just the text. Server errors
    // still toast (covered by the 409/422/500 tests above).

    /** The message element the control points at — the whole a11y contract. */
    function describedError(control: HTMLElement): HTMLElement {
        const describedBy = control.getAttribute("aria-describedby");
        expect(describedBy).toBeTruthy();
        const message = document.getElementById(describedBy!);
        expect(message).toBeInTheDocument();
        return message!;
    }

    it("renders an inline error associated to the amount field for a non-numeric amount", async () => {
        const user = userEvent.setup();
        const toastSpy = vi.spyOn(toast, "error");
        let postCalled = false;

        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(testRecipientsList)),
            http.post(`${API_BASE}/api/transactions`, () => {
                postCalled = true;
                return ok({});
            }),
        );

        renderWithApp(<AddTransactionDialog />);

        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        const amount = screen.getByLabelText(/amount/i);
        await user.type(amount, "abc");
        await pickBankAccount(user, "Main");
        // Select recipient so the guard passes
        await pickRecipient(user, "Test Supermarket");

        // fireEvent.submit bypasses JSDOM pattern constraint checking so handleSubmit runs
        const formEl = screen.getByRole("dialog").querySelector("form")!;
        fireEvent.submit(formEl);

        await waitFor(() => expect(amount).toHaveAttribute("aria-invalid", "true"));
        expect(describedError(amount)).toHaveTextContent(/invalid amount/i);
        // Submit is blocked exactly as before, and the dialog stays open.
        expect(postCalled).toBe(false);
        expect(screen.queryByRole("dialog")).toBeInTheDocument();
        // The inline message fully replaces the transient toast.
        expect(toastSpy).not.toHaveBeenCalled();
    });

    it("renders an inline error associated to the amount field for a zero amount", async () => {
        const user = userEvent.setup();
        let postCalled = false;

        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(testRecipientsList)),
            http.post(`${API_BASE}/api/transactions`, () => {
                postCalled = true;
                return ok({});
            }),
        );

        renderWithApp(<AddTransactionDialog />);

        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        const amount = screen.getByLabelText(/amount/i);
        await user.type(amount, "0");
        await pickBankAccount(user, "Main");
        await pickRecipient(user, "Test Supermarket");

        await user.click(screen.getByRole("button", { name: /create/i }));

        await waitFor(() => expect(amount).toHaveAttribute("aria-invalid", "true"));
        expect(describedError(amount)).toHaveTextContent(/cannot be zero/i);
        expect(postCalled).toBe(false);
    });

    it("clears the inline error once the field is corrected", async () => {
        const user = userEvent.setup();

        server.use(http.get(`${API_BASE}/api/recipients`, () => ok(testRecipientsList)));

        renderWithApp(<AddTransactionDialog />);

        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        const amount = screen.getByLabelText(/amount/i);
        await user.type(amount, "0");
        await pickBankAccount(user, "Main");
        await pickRecipient(user, "Test Supermarket");
        await user.click(screen.getByRole("button", { name: /create/i }));

        await waitFor(() => expect(amount).toHaveAttribute("aria-invalid", "true"));

        await user.clear(amount);
        await user.type(amount, "12.50");

        await waitFor(() => expect(amount).not.toHaveAttribute("aria-invalid"));
        expect(amount).not.toHaveAttribute("aria-describedby");
        expect(screen.queryByText(/cannot be zero/i)).not.toBeInTheDocument();
    });

    it("moves focus to the first invalid field on a blocked submit", async () => {
        const user = userEvent.setup();

        server.use(http.get(`${API_BASE}/api/recipients`, () => ok(testRecipientsList)));

        renderWithApp(<AddTransactionDialog />);

        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        // Amount is left empty and no recipient is picked: amount comes first in
        // visual order, so it is the one that must receive focus.
        await pickBankAccount(user, "Main");

        const formEl = screen.getByRole("dialog").querySelector("form")!;
        fireEvent.submit(formEl);

        const amount = screen.getByLabelText(/amount/i);
        await waitFor(() => expect(amount).toHaveFocus());
        expect(describedError(amount)).toHaveTextContent(/required/i);
        // The still-empty recipient is flagged too, not just the focused field.
        const recipient = screen.getByRole("combobox", { name: /recipient/i });
        expect(recipient).toHaveAttribute("aria-invalid", "true");
    });

    it("reveals the required-field errors on a plain mouse click of the submit button", async () => {
        const user = userEvent.setup();
        let postCalled = false;

        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(testRecipientsList)),
            http.post(`${API_BASE}/api/transactions`, () => {
                postCalled = true;
                return ok({});
            }),
        );

        renderWithApp(<AddTransactionDialog />);

        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        // The button used to be disabled on exactly the empty required fields,
        // so a mouse user hit a dead control and was never told what was
        // missing — the inline errors could only be reached by pressing Enter.
        const submit = screen.getByRole("button", { name: /^create$/i });
        expect(submit).toBeEnabled();
        await user.click(submit);

        // Date defaults to today, so amount is the first field in FIELD_ORDER
        // that is actually empty.
        const amount = screen.getByLabelText(/amount/i);
        await waitFor(() => expect(amount).toHaveFocus());
        expect(describedError(amount)).toHaveTextContent(/required/i);

        // Every other empty required field is flagged too, not just the focused one.
        const bank = screen.getByLabelText(/bank account/i);
        expect(bank).toHaveAttribute("aria-invalid", "true");
        expect(describedError(bank)).toHaveTextContent(/select account/i);
        const recipient = screen.getByRole("combobox", { name: /recipient/i });
        expect(recipient).toHaveAttribute("aria-invalid", "true");
        expect(describedError(recipient)).toHaveTextContent(/required/i);

        // Still blocked, and the dialog stays open.
        expect(postCalled).toBe(false);
        expect(screen.queryByRole("dialog")).toBeInTheDocument();
    });

    it("sends an unchanged request body on a valid submit", async () => {
        const user = userEvent.setup();
        let rawBody = "";

        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(testRecipientsList)),
            http.post(`${API_BASE}/api/transactions`, async ({ request }) => {
                rawBody = await request.text();
                return ok({
                    id: 42,
                    transaction_date: todayYmd(),
                    bank_account: "Main",
                    amount: 12.5,
                    currency: "EUR",
                    recipient_id: 7,
                });
            }),
        );

        renderWithApp(<AddTransactionDialog />);

        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        await user.type(screen.getByLabelText(/amount/i), "12.50");
        await pickBankAccount(user, "Main");
        await pickRecipient(user, "Test Supermarket");

        await user.click(screen.getByRole("button", { name: /create/i }));

        await waitFor(() => expect(rawBody).not.toBe(""));
        // Byte-for-byte: same keys, same order, same JSON.stringify omission of
        // the untouched optional fields. Routing validation through inline
        // errors must not have moved a single character of this.
        expect(rawBody).toBe(
            `{"transaction_date":"${todayYmd()}","bank_account":"Main","recipient_id":7,"amount":12.5,"currency":"EUR"}`,
        );
    });
});
