// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { toast } from "sonner";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import { AddTransactionDialog } from "@/components/forms/AddTransactionDialog";

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

    it("shows invalid amount toast when non-numeric amount is submitted", async () => {
        const user = userEvent.setup();
        const toastSpy = vi.spyOn(toast, "error");

        server.use(
            http.get(`${API_BASE}/api/recipients`, () => ok(testRecipientsList)),
        );

        renderWithApp(<AddTransactionDialog />);

        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        await user.type(screen.getByLabelText(/amount/i), "abc");
        await pickBankAccount(user, "Main");
        // Select recipient so the guard passes
        await pickRecipient(user, "Test Supermarket");

        // fireEvent.submit bypasses JSDOM pattern constraint checking so handleSubmit runs
        const formEl = screen.getByRole("dialog").querySelector("form")!;
        fireEvent.submit(formEl);

        await waitFor(() =>
            expect(toastSpy).toHaveBeenCalledWith(
                expect.stringMatching(/invalid amount/i),
            ),
        );
        // Dialog must remain open after validation error
        expect(screen.queryByRole("dialog")).toBeInTheDocument();
    });
});
