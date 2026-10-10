// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { toast } from "sonner";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err, ACCOUNT_LIST_ITEM_STUB } from "@/test/msw/handlers";
import { AddTransactionButton } from "@/features/transactions/components/AddTransactionSheet";
import { todayYmd } from "@/lib/timezone";
import {
    accountListItem,
    accountsBody,
    categoryTreeBody,
    recipientCreated,
    recipientRow,
    transactionCreated,
} from "@/test/msw/rowFixtures";

const API_BASE = "http://localhost:3002";

const testRecipient = recipientRow({
    id: 7,
    name: "Test Supermarket",
    is_active: true,
    created_at: "2025-01-01T00:00:00Z",
    links: [],
});

const testRecipientsList = {
    items: [testRecipient],
    total: 1,
    limit: 200,
    offset: 0,
    links: [],
};

// The bank-account field accepts an existing account from the account list.
async function pickBankAccount(
    user: ReturnType<typeof userEvent.setup>,
    name: string,
) {
    await user.click(screen.getByLabelText(/bank account/i));
    await user.type(screen.getByPlaceholderText(/search accounts/i), name);
    await user.click(await screen.findByRole("option", { name }));
}

async function pickRecipient(
    user: ReturnType<typeof userEvent.setup>,
    name: string,
) {
    await user.click(screen.getByRole("combobox", { name: /payee/i }));
    await user.click(await screen.findByRole("option", { name }));
}

describe("AddTransactionSheet (integration)", () => {
    beforeEach(() => {
        server.use(
            http.get(`${API_BASE}/api/accounts`, () =>
                ok(accountsBody({
                    items: [
                        accountListItem({
                            ...ACCOUNT_LIST_ITEM_STUB,
                            name: "Main",
                            display_name: "Main",
                        }),
                    ],
                    total: 1,
                    links: [],
                })),
            ),
            http.get(`${API_BASE}/api/recipients/7`, () => ok(testRecipient)),
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("opens the sheet and shows required form fields", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddTransactionButton />);

        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(screen.getByLabelText(/amount/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/bank account/i)).toBeInTheDocument();
        // Expense is the default kind: the submit verb says what gets recorded.
        expect(
            screen.getByRole("radio", { name: /^expense$/i }),
        ).toHaveAttribute("aria-checked", "true");
        expect(
            screen.getByRole("button", { name: /^add expense$/i }),
        ).toBeInTheDocument();
    });

    it("closes the dialog when Cancel is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddTransactionButton />);

        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
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
            http.get(`${API_BASE}/api/recipients`, () =>
                ok(testRecipientsList),
            ),
            http.post(`${API_BASE}/api/transactions`, async ({ request }) => {
                capturedBody = await request.json();
                return ok(transactionCreated({
                    id: 42,
                    transaction_date: "2026-04-29",
                    bank_account: "Main",
                    amount: 12.5,
                    currency: "EUR",
                    recipient_id: 7,
                }));
            }),
        );

        renderWithApp(<AddTransactionButton />);

        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await screen.findByRole("dialog");

        await user.type(screen.getByLabelText(/amount/i), "12,50");
        await pickBankAccount(user, "Main");
        await pickRecipient(user, "Test Supermarket");

        await user.click(screen.getByRole("button", { name: /^add expense$/i }));

        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
        expect((capturedBody as Record<string, unknown>).recipient_id).toBe(7);
    });

    it("closes dialog when Escape is pressed", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddTransactionButton />);

        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        expect(await screen.findByRole("dialog")).toBeInTheDocument();

        await user.keyboard("{Escape}");

        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("shows currency and recipient comboboxes in the open dialog", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddTransactionButton />);

        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await screen.findByRole("dialog");

        // Recipient and category comboboxes, plus the account picker.
        const comboboxes = screen.getAllByRole("combobox");
        expect(comboboxes.length).toBeGreaterThanOrEqual(2);
    });

    it("shows Date, Memo, Category, and Comment fields in dialog", async () => {
        const user = userEvent.setup();
        renderWithApp(<AddTransactionButton />);

        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await screen.findByRole("dialog");

        // form.addTransaction.date = "Date" — Today / Yesterday / Other chips
        expect(screen.getByRole("radio", { name: /^today$/i })).toHaveAttribute(
            "aria-checked",
            "true",
        );
        // addTxn.descMemo = "Description / Memo" — id="tx_memo"
        expect(screen.getByLabelText(/description.*memo/i)).toBeInTheDocument();
        // addTxn.categoryOptional = "Category (optional)"
        expect(screen.getByText(/category \(optional\)/i)).toBeInTheDocument();
        // addTxn.commentOptional = "Comment (optional)" — id="tx_comment"
        expect(
            screen.getByLabelText(/comment \(optional\)/i),
        ).toBeInTheDocument();
    });

    it("shows the backdated note when the chosen account's anchor is on/after the entered date (WP-B2)", async () => {
        const user = userEvent.setup();

        // Anchored account: the stamped statement date is far in the future, so
        // the dialog's default date (today) is always on/before the anchor.
        server.use(
            http.get(`${API_BASE}/api/accounts`, () =>
                ok(accountsBody({
                    items: [
                        accountListItem({
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
                        }),
                    ],
                    total: 1,
                    links: [],
                })),
            ),
        );

        renderWithApp(<AddTransactionButton />);

        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await screen.findByRole("dialog");

        // No account chosen yet → no note.
        expect(
            screen.queryByText(/balance won't change/i),
        ).not.toBeInTheDocument();

        // Pick the anchored account from the combobox.
        await user.click(screen.getByLabelText(/bank account/i));
        await user.click(await screen.findByText("Main"));

        expect(
            await screen.findByText(/dated before the .* bank statement/i),
        ).toBeInTheDocument();
    });

    it("requires an explicit Add anyway action after a duplicate 409", async () => {
        const user = userEvent.setup();
        const toastSpy = vi.spyOn(toast, "error");
        const posted: Array<Record<string, unknown>> = [];

        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok(testRecipientsList),
            ),
            http.post(`${API_BASE}/api/transactions`, async ({ request }) => {
                posted.push((await request.json()) as Record<string, unknown>);
                if (posted.length === 1) {
                    return err(409, "Duplicate transaction detected");
                }
                return ok(transactionCreated({ id: 99, ...posted[1], links: [] }));
            }),
        );

        renderWithApp(<AddTransactionButton />);

        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await screen.findByRole("dialog");

        await user.type(screen.getByLabelText(/amount/i), "12,50");
        await pickBankAccount(user, "Main");
        await pickRecipient(user, "Test Supermarket");

        await user.click(screen.getByRole("button", { name: /^add expense$/i }));

        await waitFor(() =>
            expect(toastSpy).toHaveBeenCalledWith(
                expect.stringMatching(/matching transaction already exists/i),
            ),
        );
        expect(toastSpy).toHaveBeenCalledTimes(1);
        expect(posted).toHaveLength(1);
        expect(posted[0]).not.toHaveProperty("allow_duplicate");

        await user.click(
            await screen.findByRole("button", { name: /add anyway/i }),
        );
        await waitFor(() => expect(posted).toHaveLength(2));
        expect(posted[1]).toMatchObject({ allow_duplicate: true });
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("keeps dialog open when server returns 500 error", async () => {
        const user = userEvent.setup();
        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        let postCalled = false;

        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok(testRecipientsList),
            ),
            http.post(`${API_BASE}/api/transactions`, () => {
                postCalled = true;
                return err(500, "server error");
            }),
        );

        renderWithApp(<AddTransactionButton />);

        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await screen.findByRole("dialog");

        await user.type(screen.getByLabelText(/amount/i), "12,50");
        await pickBankAccount(user, "Main");
        await pickRecipient(user, "Test Supermarket");

        await user.click(screen.getByRole("button", { name: /^add expense$/i }));

        // Wait for POST to actually fire, then confirm dialog stays open
        await waitFor(() => expect(postCalled).toBe(true), { timeout: 5000 });
        expect(screen.queryByRole("dialog")).toBeInTheDocument();

        consoleSpy.mockRestore();
    });

    it("shows error toast when server returns 422 validation error", async () => {
        const user = userEvent.setup();
        const toastSpy = vi.spyOn(toast, "error");

        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok(testRecipientsList),
            ),
            http.post(`${API_BASE}/api/transactions`, () =>
                err(422, "amount must be positive"),
            ),
        );

        renderWithApp(<AddTransactionButton />);

        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await screen.findByRole("dialog");

        await user.type(screen.getByLabelText(/amount/i), "12,50");
        await pickBankAccount(user, "Main");
        await pickRecipient(user, "Test Supermarket");

        await user.click(screen.getByRole("button", { name: /^add expense$/i }));

        await waitFor(() =>
            expect(toastSpy).toHaveBeenCalledWith(
                expect.stringMatching(/couldn't create the transaction/i),
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
            http.get(`${API_BASE}/api/recipients`, () =>
                ok(testRecipientsList),
            ),
            http.post(`${API_BASE}/api/transactions`, () => {
                postCalled = true;
                return ok(transactionCreated({}));
            }),
        );

        renderWithApp(<AddTransactionButton />);

        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await screen.findByRole("dialog");

        const amount = screen.getByLabelText(/amount/i);
        await user.type(amount, "abc");
        await pickBankAccount(user, "Main");
        // Select recipient so the guard passes
        await pickRecipient(user, "Test Supermarket");

        // fireEvent.submit bypasses JSDOM pattern constraint checking so handleSubmit runs
        const formEl = screen.getByRole("dialog").querySelector("form")!;
        fireEvent.submit(formEl);

        await waitFor(() =>
            expect(amount).toHaveAttribute("aria-invalid", "true"),
        );
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
            http.get(`${API_BASE}/api/recipients`, () =>
                ok(testRecipientsList),
            ),
            http.post(`${API_BASE}/api/transactions`, () => {
                postCalled = true;
                return ok(transactionCreated({}));
            }),
        );

        renderWithApp(<AddTransactionButton />);

        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await screen.findByRole("dialog");

        const amount = screen.getByLabelText(/amount/i);
        await user.type(amount, "0");
        await pickBankAccount(user, "Main");
        await pickRecipient(user, "Test Supermarket");

        await user.click(screen.getByRole("button", { name: /^add expense$/i }));

        await waitFor(() =>
            expect(amount).toHaveAttribute("aria-invalid", "true"),
        );
        expect(describedError(amount)).toHaveTextContent(/cannot be zero/i);
        expect(postCalled).toBe(false);
    });

    it("clears the inline error once the field is corrected", async () => {
        const user = userEvent.setup();

        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok(testRecipientsList),
            ),
        );

        renderWithApp(<AddTransactionButton />);

        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await screen.findByRole("dialog");

        const amount = screen.getByLabelText(/amount/i);
        await user.type(amount, "0");
        await pickBankAccount(user, "Main");
        await pickRecipient(user, "Test Supermarket");
        await user.click(screen.getByRole("button", { name: /^add expense$/i }));

        await waitFor(() =>
            expect(amount).toHaveAttribute("aria-invalid", "true"),
        );

        await user.clear(amount);
        await user.type(amount, "12,50");

        await waitFor(() => expect(amount).not.toHaveAttribute("aria-invalid"));
        expect(amount).not.toHaveAttribute("aria-describedby");
        expect(screen.queryByText(/cannot be zero/i)).not.toBeInTheDocument();
    });

    it("moves focus to the first invalid field on a blocked submit", async () => {
        const user = userEvent.setup();

        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok(testRecipientsList),
            ),
        );

        renderWithApp(<AddTransactionButton />);

        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
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
        const recipient = screen.getByRole("combobox", { name: /payee/i });
        expect(recipient).toHaveAttribute("aria-invalid", "true");
    });

    it("reveals the required-field errors on a plain mouse click of the submit button", async () => {
        const user = userEvent.setup();
        let postCalled = false;

        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok(testRecipientsList),
            ),
            http.post(`${API_BASE}/api/transactions`, () => {
                postCalled = true;
                return ok(transactionCreated({}));
            }),
        );

        renderWithApp(<AddTransactionButton />);

        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await screen.findByRole("dialog");

        // The button is never disabled on empty required fields: a mouse user
        // must be told what is missing, through the inline errors.
        const submit = screen.getByRole("button", { name: /^add expense$/i });
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
        const recipient = screen.getByRole("combobox", { name: /payee/i });
        expect(recipient).toHaveAttribute("aria-invalid", "true");
        expect(describedError(recipient)).toHaveTextContent(/required/i);

        // Still blocked, and the sheet stays open.
        expect(postCalled).toBe(false);
        expect(screen.queryByRole("dialog")).toBeInTheDocument();
    });

    it("sends an unchanged request body on a valid submit", async () => {
        const user = userEvent.setup();
        let rawBody = "";

        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok(testRecipientsList),
            ),
            http.post(`${API_BASE}/api/transactions`, async ({ request }) => {
                rawBody = await request.text();
                return ok(transactionCreated({
                    id: 42,
                    transaction_date: todayYmd(),
                    bank_account: "Main",
                    amount: 12.5,
                    currency: "EUR",
                    recipient_id: 7,
                }));
            }),
        );

        renderWithApp(<AddTransactionButton />);

        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await screen.findByRole("dialog");

        await user.type(screen.getByLabelText(/amount/i), "12,50");
        await pickBankAccount(user, "Main");
        await pickRecipient(user, "Test Supermarket");

        await user.click(screen.getByRole("button", { name: /^add expense$/i }));

        await waitFor(() => expect(rawBody).not.toBe(""));
        // The selected account is sent by ID, the Expense kind supplies the
        // sign, and untouched optional fields are still omitted.
        expect(rawBody).toBe(
            `{"transaction_date":"${todayYmd()}","account_id":1,"recipient_id":7,"amount":-12.5,"currency":"EUR"}`,
        );
    });

    it("searches for a recipient beyond the initial page and submits its id", async () => {
        const user = userEvent.setup();
        let capturedRecipientId: unknown;
        const remoteRecipient = {
            ...testRecipient,
            id: 701,
            name: "Remote Search Result",
        };
        const recipientRequests: URL[] = [];

        server.use(
            http.get(`${API_BASE}/api/recipients`, ({ request }) => {
                const url = new URL(request.url);
                recipientRequests.push(url);
                const search = url.searchParams.get("search");
                const items = search ? [remoteRecipient] : [];
                return ok({
                    items,
                    total: items.length,
                    limit: 100,
                    offset: 0,
                    links: [],
                });
            }),
            http.get(`${API_BASE}/api/recipients/701`, () =>
                ok(remoteRecipient),
            ),
            http.post(`${API_BASE}/api/transactions`, async ({ request }) => {
                capturedRecipientId = (
                    (await request.json()) as Record<string, unknown>
                ).recipient_id;
                return ok(transactionCreated({ id: 42 }));
            }),
        );

        renderWithApp(<AddTransactionButton />);
        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await user.type(screen.getByLabelText(/amount/i), "12,50");
        await pickBankAccount(user, "Main");

        await user.click(
            screen.getByRole("combobox", { name: /^payee$/i }),
        );
        await user.type(
            screen.getByPlaceholderText(/search payees/i),
            "Remote",
        );
        await user.click(
            await screen.findByRole("option", { name: "Remote Search Result" }),
        );
        await user.click(screen.getByRole("button", { name: /^add expense$/i }));

        await waitFor(() => expect(capturedRecipientId).toBe(701));
        expect(recipientRequests.length).toBeGreaterThanOrEqual(2);
        expect(
            recipientRequests.every(
                (url) => url.searchParams.get("active") === "true",
            ),
        ).toBe(true);
    });

    it("selects and submits a category beyond the old 200-item cap", async () => {
        const user = userEvent.setup();
        let capturedCategoryId: unknown;
        const categories = Array.from({ length: 202 }, (_, index) => ({
            id: index + 1,
            name: index === 201 ? "Archived receipts" : `Category ${index + 1}`,
            parentId: null,
            pathIds: [index + 1],
            path: [
                index === 201 ? "Archived receipts" : `Category ${index + 1}`,
            ],
            category_name:
                index === 201 ? "Archived receipts" : `Category ${index + 1}`,
            depth: 1,
            description: null,
            is_active: true,
            hierarchyOnly: false,
            legacyCompatible: false,
        }));

        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok(testRecipientsList),
            ),
            http.get(`${API_BASE}/api/categories/tree`, () =>
                ok(categoryTreeBody({ items: categories, total: categories.length, links: [] })),
            ),
            http.post(`${API_BASE}/api/transactions`, async ({ request }) => {
                capturedCategoryId = (
                    (await request.json()) as Record<string, unknown>
                ).category_id;
                return ok(transactionCreated({ id: 42 }));
            }),
        );

        renderWithApp(<AddTransactionButton />);
        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await user.type(screen.getByLabelText(/amount/i), "12,50");
        await pickBankAccount(user, "Main");
        await pickRecipient(user, "Test Supermarket");

        await user.click(
            screen.getByRole("combobox", { name: /category \(optional\)/i }),
        );
        await user.type(
            screen.getByPlaceholderText(/search categories/i),
            "Archived receipts",
        );
        await user.click(
            await screen.findByRole("option", {
                name: "Archived receipts",
            }),
        );
        await user.click(screen.getByRole("button", { name: /^add expense$/i }));

        await waitFor(() => expect(capturedCategoryId).toBe(202));
    }, 15000);

    it("records income as a positive amount under the Income kind", async () => {
        const user = userEvent.setup();
        let capturedBody: Record<string, unknown> | undefined;

        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok(testRecipientsList),
            ),
            http.post(`${API_BASE}/api/transactions`, async ({ request }) => {
                capturedBody = (await request.json()) as Record<string, unknown>;
                return ok(transactionCreated({ id: 43, ...capturedBody }));
            }),
        );

        renderWithApp(<AddTransactionButton />);
        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await screen.findByRole("dialog");

        await user.click(screen.getByRole("radio", { name: /^income$/i }));
        await user.type(screen.getByLabelText(/amount/i), "1200");
        await pickBankAccount(user, "Main");
        await user.click(screen.getByRole("combobox", { name: /^from$/i }));
        await user.click(
            await screen.findByRole("option", { name: "Test Supermarket" }),
        );
        await user.click(screen.getByRole("button", { name: /^add income$/i }));

        await waitFor(() => expect(capturedBody).toBeDefined());
        expect(capturedBody).toMatchObject({ amount: 1200, recipient_id: 7 });
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("records a transfer as two linked legs between different accounts", async () => {
        const user = userEvent.setup();
        const posted: Array<Record<string, unknown>> = [];
        const recipientsCreated: string[] = [];
        let linked: Record<string, unknown> | undefined;

        server.use(
            http.get(`${API_BASE}/api/accounts`, () =>
                ok(accountsBody({
                    items: [
                        accountListItem({ ...ACCOUNT_LIST_ITEM_STUB, id: 1, name: "Main", display_name: "Main" }),
                        accountListItem({ ...ACCOUNT_LIST_ITEM_STUB, id: 2, name: "Savings", display_name: "Savings" }),
                    ],
                    total: 2,
                    links: [],
                })),
            ),
            http.post(`${API_BASE}/api/recipients`, async ({ request }) => {
                const body = (await request.json()) as { name: string };
                recipientsCreated.push(body.name);
                const id = body.name === "Savings" ? 21 : 22;
                return ok(recipientCreated({ id, name: body.name }));
            }),
            http.post(`${API_BASE}/api/transactions`, async ({ request }) => {
                const body = (await request.json()) as Record<string, unknown>;
                posted.push(body);
                return ok(transactionCreated({ id: 100 + posted.length, ...body }));
            }),
            http.post(`${API_BASE}/api/transactions/transfers`, async ({ request }) => {
                linked = (await request.json()) as Record<string, unknown>;
                return ok({});
            }),
        );

        renderWithApp(<AddTransactionButton />);
        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await screen.findByRole("dialog");

        await user.click(screen.getByRole("radio", { name: /^transfer$/i }));
        await user.type(screen.getByLabelText(/amount/i), "250");
        await user.click(screen.getByLabelText(/^from account$/i));
        await user.type(screen.getByPlaceholderText(/search accounts/i), "Main");
        await user.click(await screen.findByRole("option", { name: "Main" }));
        await user.click(screen.getByLabelText(/^to account$/i));
        await user.type(screen.getByPlaceholderText(/search accounts/i), "Savings");
        await user.click(await screen.findByRole("option", { name: "Savings" }));
        await user.click(screen.getByRole("button", { name: /^add transfer$/i }));

        await waitFor(() => expect(linked).toBeDefined());
        expect(recipientsCreated.sort()).toEqual(["Main", "Savings"]);
        expect(posted).toHaveLength(2);
        expect(posted[0]).toMatchObject({ account_id: 1, recipient_id: 21, amount: -250 });
        expect(posted[1]).toMatchObject({ account_id: 2, recipient_id: 22, amount: 250 });
        expect(linked).toEqual({ aId: 101, bId: 102 });
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );
    });

    it("refuses a transfer whose two accounts are the same", async () => {
        const user = userEvent.setup();
        let postCalled = false;
        server.use(
            http.post(`${API_BASE}/api/transactions`, () => {
                postCalled = true;
                return ok(transactionCreated({ id: 1 }));
            }),
        );

        renderWithApp(<AddTransactionButton />);
        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await screen.findByRole("dialog");

        await user.click(screen.getByRole("radio", { name: /^transfer$/i }));
        await user.type(screen.getByLabelText(/amount/i), "250");
        await user.click(screen.getByLabelText(/^from account$/i));
        await user.type(screen.getByPlaceholderText(/search accounts/i), "Main");
        await user.click(await screen.findByRole("option", { name: "Main" }));
        await user.click(screen.getByLabelText(/^to account$/i));
        await user.type(screen.getByPlaceholderText(/search accounts/i), "Main");
        await user.click(await screen.findByRole("option", { name: "Main" }));
        await user.click(screen.getByRole("button", { name: /^add transfer$/i }));

        const toAccount = screen.getByLabelText(/^to account$/i);
        await waitFor(() =>
            expect(toAccount).toHaveAttribute("aria-invalid", "true"),
        );
        expect(describedError(toAccount)).toHaveTextContent(/different account/i);
        expect(postCalled).toBe(false);
    });

    it("dates the row yesterday from the date chips", async () => {
        const user = userEvent.setup();
        let capturedBody: Record<string, unknown> | undefined;
        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok(testRecipientsList),
            ),
            http.post(`${API_BASE}/api/transactions`, async ({ request }) => {
                capturedBody = (await request.json()) as Record<string, unknown>;
                return ok(transactionCreated({ id: 44, ...capturedBody }));
            }),
        );

        renderWithApp(<AddTransactionButton />);
        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await screen.findByRole("dialog");

        await user.click(screen.getByRole("radio", { name: /^yesterday$/i }));
        await user.type(screen.getByLabelText(/amount/i), "5");
        await pickBankAccount(user, "Main");
        await pickRecipient(user, "Test Supermarket");
        await user.click(screen.getByRole("button", { name: /^add expense$/i }));

        await waitFor(() => expect(capturedBody).toBeDefined());
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const expected = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
        expect(capturedBody?.transaction_date).toBe(expected);
    });

    it("fills the recipient's usual category and lets the user override it", async () => {
        const user = userEvent.setup();
        let capturedBody: Record<string, unknown> | undefined;
        const categories = [
            { id: 5, name: "Groceries", parentId: null, pathIds: [5], path: ["Groceries"], category_name: "Groceries", depth: 1, description: null, is_active: true, hierarchyOnly: false, legacyCompatible: false },
            { id: 6, name: "Household", parentId: null, pathIds: [6], path: ["Household"], category_name: "Household", depth: 1, description: null, is_active: true, hierarchyOnly: false, legacyCompatible: false },
        ];
        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok(testRecipientsList),
            ),
            http.get(`${API_BASE}/api/recipients/7`, () =>
                ok(recipientRow({ ...testRecipient, default_category_id: 5, default_category_name: "Groceries" })),
            ),
            http.get(`${API_BASE}/api/categories/tree`, () =>
                ok(categoryTreeBody({ items: categories, total: categories.length, links: [] })),
            ),
            http.post(`${API_BASE}/api/transactions`, async ({ request }) => {
                capturedBody = (await request.json()) as Record<string, unknown>;
                return ok(transactionCreated({ id: 45, ...capturedBody }));
            }),
        );

        renderWithApp(<AddTransactionButton />);
        await user.click(
            await screen.findByRole("button", { name: /add transaction/i }),
        );
        await screen.findByRole("dialog");

        await user.type(screen.getByLabelText(/amount/i), "30");
        await pickBankAccount(user, "Main");
        await pickRecipient(user, "Test Supermarket");

        expect(
            await screen.findByText(/usually goes to groceries/i),
        ).toBeInTheDocument();
        const category = screen.getByRole("combobox", { name: /category \(optional\)/i });
        expect(category).toHaveTextContent("Groceries");

        await user.click(category);
        await user.click(await screen.findByRole("option", { name: "Household" }));
        expect(
            screen.queryByText(/usually goes to groceries/i),
        ).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /^add expense$/i }));
        await waitFor(() => expect(capturedBody).toBeDefined());
        expect(capturedBody?.category_id).toBe(6);
    });
});
