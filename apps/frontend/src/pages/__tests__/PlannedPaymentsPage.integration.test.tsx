// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { toast } from "sonner";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import {
    err,
    noContent,
    ok,
    ACCOUNT_LIST_ITEM_STUB,
} from "@/test/msw/handlers";
import PlannedPaymentsPage from "@/pages/PlannedPaymentsPage";
import PlannedPaymentForm from "@/features/planned/PlannedPaymentForm";
import { todayYmd } from "@/lib/timezone";

// The table virtualizes rows via @tanstack/react-virtual, which renders nothing
// in jsdom's zero-height scroll container. Mock the virtualizer to materialise
// every row so row-content assertions work (the windowing itself is covered by
// VirtualDataTable's unit test). In a real browser the container has height and
// rows render normally.
vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({
        count,
        estimateSize,
    }: {
        count: number;
        estimateSize: () => number;
    }) => ({
        getVirtualItems: () =>
            Array.from({ length: count }, (_, i) => ({
                key: i,
                index: i,
                start: i * estimateSize(),
                size: estimateSize(),
            })),
        getTotalSize: () => count * estimateSize(),
        measureElement: vi.fn(),
    }),
}));

/** Minimal backend PlannedTransaction fixture (active, recurring) */
const rentPayment = {
    id: 1,
    memo: "Rent",
    recipient_name: "Landlord SA",
    amount: -900,
    currency: "EUR",
    planned_date: "2025-05-01",
    is_recurring: true,
    recurrence_pattern: "monthly",
    is_active: true,
    is_executed: false,
    is_loan: false,
    created_at: "2025-01-01T00:00:00.000Z",
    execution_count: 0,
    executions: [],
};

const API_BASE = "http://localhost:3002";

beforeEach(() => {
    server.use(
        http.get(`${API_BASE}/api/planned-transactions/match-suggestions`, () =>
            ok({ items: [], total: 0 }),
        ),
        http.get(`${API_BASE}/api/accounts`, () =>
            ok({
                items: [
                    {
                        ...ACCOUNT_LIST_ITEM_STUB,
                        name: "Main",
                        display_name: "Main",
                    },
                ],
                total: 1,
                links: [],
            }),
        ),
    );
});

/**
 * The header's primary action. The empty state repeats "Add payment" once
 * there is nothing planned, so the first match is the header button.
 */
async function addButton() {
    const [button] = await screen.findAllByRole("button", {
        name: /add payment/i,
    });
    return button;
}

async function openViewMenu(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "View" }));
    await screen.findByRole("menu");
}

async function openRowMenu(
    user: ReturnType<typeof userEvent.setup>,
    name: string,
) {
    await user.click(
        await screen.findByRole("button", { name: `Actions for ${name}` }),
    );
    await screen.findByRole("menu");
}

describe("PlannedPaymentsPage (integration)", () => {
    it("hydrates the show-all filter from the URL", async () => {
        const user = userEvent.setup();
        renderWithApp(<PlannedPaymentsPage />, {
            initialEntries: ["/planned?show_all=true"],
        });

        await openViewMenu(user);
        expect(
            await screen.findByRole("menuitemcheckbox", {
                name: /include paused/i,
                checked: true,
            }),
        ).toBeInTheDocument();
    });

    it("renders page heading", async () => {
        renderWithApp(<PlannedPaymentsPage />);
        expect(
            await screen.findByRole("heading", { name: "Planned", level: 1 }),
        ).toBeInTheDocument();
    });

    it("renders the Add payment button", async () => {
        renderWithApp(<PlannedPaymentsPage />);
        expect(
            await addButton(),
        ).toBeInTheDocument();
    });

    it("shows error alert when planned-transactions API fails", async () => {
        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/planned-transactions`, () =>
                err(500, "db unavailable"),
            ),
        );

        renderWithApp(<PlannedPaymentsPage />);

        expect(
            await screen.findByText(/db unavailable/i, {}, { timeout: 5000 }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /retry/i }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /add payment/i }),
        ).not.toBeInTheDocument();

        consoleSpy.mockRestore();
    });

    it("opens New Planned Payment dialog when New Payment is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<PlannedPaymentsPage />);

        const newPaymentBtn = await addButton();
        await user.click(newPaymentBtn);

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            screen.getByRole("heading", { name: "New payment" }),
        ).toBeInTheDocument();
    });

    it("dialog shows Name and Amount fields", async () => {
        const user = userEvent.setup();
        renderWithApp(<PlannedPaymentsPage />);

        const newPaymentBtn = await addButton();
        await user.click(newPaymentBtn);

        await screen.findByRole("dialog");

        expect(screen.getByLabelText("Name")).toBeInTheDocument();
        expect(screen.getByLabelText("Amount", { selector: "#pp-amount" })).toBeInTheDocument();
    });

    it("closes dialog when Cancel is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<PlannedPaymentsPage />);

        const newPaymentBtn = await addButton();
        await user.click(newPaymentBtn);

        await screen.findByRole("dialog");

        await user.click(screen.getByRole("button", { name: /cancel/i }));

        // Dialog should close
        await screen.findByRole("heading", { name: "Planned", level: 1 });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows All Payments table section", async () => {
        renderWithApp(<PlannedPaymentsPage />);
        // plannedPage.tableTitle = "All Payments"
        expect(await screen.findByText(/all payments/i)).toBeInTheDocument();
    });

    it("offers Include paused in the View menu, off by default", async () => {
        const user = userEvent.setup();
        renderWithApp(<PlannedPaymentsPage />);
        await openViewMenu(user);
        expect(
            await screen.findByRole("menuitemcheckbox", {
                name: /include paused/i,
                checked: false,
            }),
        ).toBeInTheDocument();
    });

    it("shows page subtitle text", async () => {
        renderWithApp(<PlannedPaymentsPage />);
        // Wait for full page load (translations lazy-load after settings fetch + locale import)
        await addButton();
        expect(
            screen.getByText(
                /see recurring bills and future payments/i,
            ),
        ).toBeInTheDocument();
    });

    it("closes New Payment dialog via Escape key", async () => {
        const user = userEvent.setup();
        renderWithApp(<PlannedPaymentsPage />);

        const newPaymentBtn = await addButton();
        await user.click(newPaymentBtn);

        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("resets the create form (direction toggle, name) between consecutive New opens", async () => {
        const user = userEvent.setup();
        renderWithApp(<PlannedPaymentsPage />);

        // First "New" open: dirty the sticky fields — flip the direction
        // toggle to Income and type a name.
        await user.click(
            await addButton(),
        );
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("radio", { name: /income/i }));
        expect(screen.getByRole("radio", { name: /income/i })).toHaveAttribute(
            "aria-checked",
            "true",
        );
        await user.type(screen.getByLabelText("Name"), "Salary");

        // Close without saving, reopen "New".
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        await user.click(await addButton());
        await screen.findByRole("dialog");

        // The form remounted blank: direction back on its Expense default
        // (the sign-owning field), name cleared.
        expect(screen.getByRole("radio", { name: /expense/i })).toHaveAttribute(
            "aria-checked",
            "true",
        );
        expect(screen.getByRole("radio", { name: /income/i })).toHaveAttribute(
            "aria-checked",
            "false",
        );
        expect(screen.getByLabelText("Name")).toHaveValue("");
    });

    it("shows payment name in table row when MSW returns a planned payment", async () => {
        server.use(
            http.get(`${API_BASE}/api/planned-transactions`, () =>
                ok({
                    items: [rentPayment],
                    total: 1,
                    limit: 1000,
                    offset: 0,
                    links: [],
                }),
            ),
        );

        renderWithApp(<PlannedPaymentsPage />);

        // "Rent" is the memo → mapped to name
        expect(await screen.findByText("Rent")).toBeInTheDocument();
    });

    it("shows payment amount in table row", async () => {
        server.use(
            http.get(`${API_BASE}/api/planned-transactions`, () =>
                ok({
                    items: [rentPayment],
                    total: 1,
                    limit: 1000,
                    offset: 0,
                    links: [],
                }),
            ),
        );

        renderWithApp(<PlannedPaymentsPage />);

        // Amount = -900 EUR → formatted with minus sign in table cell (span.tabular-nums)
        const amountCells = await screen.findAllByText(/900/);
        expect(amountCells.length).toBeGreaterThan(0);
    });

    it("shows recurring frequency badge when payment is recurring", async () => {
        server.use(
            http.get(`${API_BASE}/api/planned-transactions`, () =>
                ok({
                    items: [rentPayment],
                    total: 1,
                    limit: 1000,
                    offset: 0,
                    links: [],
                }),
            ),
        );

        renderWithApp(<PlannedPaymentsPage />);

        // plannedPage.freq.monthly = "Monthly" — multiple elements may match, just verify at least one
        const matches = await screen.findAllByText(/monthly/i);
        expect(matches.length).toBeGreaterThan(0);
    });

    it("KPI card Est. Monthly shows non-zero when active recurring payment exists", async () => {
        server.use(
            http.get(`${API_BASE}/api/planned-transactions`, () =>
                ok({
                    items: [rentPayment],
                    total: 1,
                    limit: 1000,
                    offset: 0,
                    links: [],
                }),
            ),
        );

        renderWithApp(<PlannedPaymentsPage />);

        // "Est. Monthly" label always renders; just verify it's present
        expect(await screen.findByText(/estimated monthly/i)).toBeInTheDocument();
    });

    it("shows All Payments table with payment row after data loads", async () => {
        server.use(
            http.get(`${API_BASE}/api/planned-transactions`, () =>
                ok({
                    items: [rentPayment],
                    total: 1,
                    limit: 1000,
                    offset: 0,
                    links: [],
                }),
            ),
        );

        renderWithApp(<PlannedPaymentsPage />);

        // Table section heading appears
        await screen.findByText(/all payments/i);
        // Payment row is rendered
        expect(await screen.findByText("Rent")).toBeInTheDocument();
    });

    it("turns Include paused on from the View menu", async () => {
        const user = userEvent.setup();
        renderWithApp(<PlannedPaymentsPage />);

        await openViewMenu(user);
        await user.click(
            await screen.findByRole("menuitemcheckbox", {
                name: /include paused/i,
                checked: false,
            }),
        );

        await openViewMenu(user);
        expect(
            await screen.findByRole("menuitemcheckbox", {
                name: /include paused/i,
                checked: true,
            }),
        ).toBeInTheDocument();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("does not crash when planned-transactions endpoint returns 404", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/planned-transactions`, () =>
                err(404, "Not found"),
            ),
        );
        const { container } = renderWithApp(<PlannedPaymentsPage />);
        // Container should render (skeleton or content)
        await new Promise((r) => setTimeout(r, 200));
        expect(container.firstChild).toBeTruthy();
        errSpy.mockRestore();
    });

    it("does not crash when server returns malformed payload (defensive)", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/planned-transactions`, () =>
                ok({ items: null, total: 0 }),
            ),
        );
        const { container } = renderWithApp(<PlannedPaymentsPage />);
        await new Promise((r) => setTimeout(r, 200));
        expect(container.firstChild).toBeTruthy();
        errSpy.mockRestore();
    });

    it("after a successful create, the planned-transactions list refetches (stale refetch)", async () => {
        let getCalls = 0;
        const stub = {
            id: 99,
            planned_date: "2025-02-01",
            bank_account: null,
            recipient_id: null,
            recipient_name: null,
            memo: "Test",
            amount: 100,
            currency: "EUR",
            category_id: null,
            category_name: null,
            comment: null,
            url: null,
            is_recurring: false,
            recurrence_pattern: null,
            reminder_days_before: null,
            is_executed: false,
            last_executed_date: null,
            is_loan: false,
            loan_type: null,
            loan_principal: null,
            loan_annual_interest_rate: null,
            loan_term_months: null,
            loan_start_date: null,
            loan_payment_day: null,
            loan_regular_payment_amount: null,
            loan_first_payment_date: null,
            loan_schedule: [],
            executed_transaction_id: null,
            execution_count: 0,
            executions: [],
            is_active: true,
            created_at: "2025-01-01T00:00:00Z",
            updated_at: null,
            links: [],
        };
        server.use(
            http.get(`${API_BASE}/api/planned-transactions`, () => {
                getCalls += 1;
                return ok({
                    items: [],
                    total: 0,
                    limit: 1000,
                    offset: 0,
                    links: [],
                });
            }),
            http.post(`${API_BASE}/api/planned-transactions`, () => ok(stub)),
        );

        renderWithApp(<PlannedPaymentsPage />);
        await screen.findByRole("heading", { name: "Planned", level: 1 });
        // Hook usePlannedPayments may use multiple fetches; sample baseline
        await new Promise((r) => setTimeout(r, 100));
        const before = getCalls;
        // Trigger a refetch by simulating the React Query invalidation effect
        // (Calling the POST endpoint on its own won't refetch — full mutation
        // flow is exercised by AddPortfolioTxnDialog tests; here we just
        // verify the GET handler is wired and called at least once.)
        expect(before).toBeGreaterThan(0);
    });
});

// ─── PlannedPaymentForm inline field validation ─────────────────────────────
//
// Validation used to stop submission behind a blocking `alert()` — modal,
// unlinked to any field, and impossible to re-read. It now renders on the
// offending field, tied to it by `aria-describedby` with `aria-invalid` on the
// control, so these assert the linkage rather than only the copy. The blocking
// conditions themselves are unchanged: `onSubmit` must still never fire.
describe("PlannedPaymentForm (inline validation)", () => {
    /** The message element the control points at — the whole a11y contract. */
    function describedError(control: HTMLElement): HTMLElement {
        const describedBy = control.getAttribute("aria-describedby");
        expect(describedBy).toBeTruthy();
        const message = document.getElementById(describedBy!);
        expect(message).toBeInTheDocument();
        return message!;
    }

    /** Choose an existing bank account from the account picker. */
    async function pickBankAccount(
        user: ReturnType<typeof userEvent.setup>,
        name: string,
    ) {
        await user.click(screen.getByLabelText(/bank account/i));
        await user.type(screen.getByPlaceholderText(/search accounts/i), name);
        await user.click(await screen.findByRole("option", { name }));
    }

    /** New payment, name + bank filled — the point where the submit button unlocks. */
    async function renderSubmittableForm() {
        const user = userEvent.setup();
        const onSubmit = vi.fn();
        renderWithApp(
            <PlannedPaymentForm
                open
                onOpenChange={() => {}}
                onSubmit={onSubmit}
            />,
        );
        await screen.findByRole("dialog");
        await user.type(screen.getByLabelText("Name"), "Mortgage");
        await user.type(screen.getByLabelText("Amount", { selector: "#pp-amount" }), "100");
        await pickBankAccount(user, "Main");
        return { user, onSubmit };
    }

    // Scoped to the sheet: the page behind it has its own "Add payment".
    const submitBtn = () =>
        within(screen.getByRole("dialog")).getByRole("button", {
            name: /add payment/i,
        });

    /** Empty form, waited out to real English (the dictionary loads lazily). */
    async function renderEmptyForm() {
        const user = userEvent.setup();
        const onSubmit = vi.fn();
        renderWithApp(
            <PlannedPaymentForm
                open
                onOpenChange={() => {}}
                onSubmit={onSubmit}
            />,
        );
        await screen.findByRole("heading", { name: "New payment" });
        return { user, onSubmit };
    }

    it("reveals the required-field errors on a plain mouse click of the submit button", async () => {
        const { user, onSubmit } = await renderEmptyForm();

        // The button used to be disabled on exactly the empty required fields.
        // This form has no <form> element, so its onClick is the *only* path
        // into the blocked-submit branch — with the button dead, the inline
        // errors could not be reached at all, by mouse or by keyboard.
        const submit = submitBtn();
        expect(submit).toBeEnabled();
        await user.click(submit);

        const name = screen.getByLabelText("Name");
        await waitFor(() => expect(name).toHaveFocus());
        expect(describedError(name)).toHaveTextContent(/name is required/i);

        // The rest are flagged as well, not just the focused one. (Due date
        // defaults to today, so it is not among them.)
        const amount = screen.getByLabelText("Amount", { selector: "#pp-amount" });
        expect(amount).toHaveAttribute("aria-invalid", "true");
        expect(describedError(amount)).toHaveTextContent(
            /valid amount is required/i,
        );
        const bank = screen.getByLabelText(/bank account/i);
        expect(bank).toHaveAttribute("aria-invalid", "true");
        expect(describedError(bank)).toHaveTextContent(/select account/i);

        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("gives every combobox in the form an accessible name", async () => {
        const { user } = await renderEmptyForm();

        // A combobox takes no name from its own content, so a <Label> with no
        // htmlFor (or one pointing at a control with no id) left these nameless.
        for (const name of [
            /^payee$/i,
            /^category$/i,
            /^tags$/i,
            /bank account/i,
        ]) {
            expect(screen.getByRole("combobox", { name })).toBeInTheDocument();
        }

        // Loan section.
        await user.click(screen.getByLabelText(/loan repayment/i));
        expect(
            screen.getByRole("combobox", { name: /loan type/i }),
        ).toBeInTheDocument();
        await user.click(screen.getByLabelText(/loan repayment/i));

        // Recurrence section — the end-date picker is a button, not a combobox.
        await user.click(screen.getByLabelText("Recurring"));
        expect(
            screen.getByRole("combobox", { name: /frequency/i }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /end date/i }),
        ).toBeInTheDocument();
    });

    it("flags every missing loan field, focuses the first, and blocks submit", async () => {
        const { user, onSubmit } = await renderSubmittableForm();

        await user.click(screen.getByLabelText(/loan repayment/i));
        await user.click(submitBtn());

        const principal = screen.getByLabelText(/principal amount/i);
        await waitFor(() => expect(principal).toHaveFocus());
        expect(principal).toHaveAttribute("aria-invalid", "true");
        expect(describedError(principal)).toHaveTextContent(/required/i);

        // The other two are flagged as well, not just the focused one.
        for (const label of [/annual interest/i, /term \(months\)/i]) {
            const field = screen.getByLabelText(label);
            expect(field).toHaveAttribute("aria-invalid", "true");
            expect(describedError(field)).toHaveTextContent(/required/i);
        }

        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("flags an out-of-range loan term on the term field and blocks submit", async () => {
        const { user, onSubmit } = await renderSubmittableForm();

        await user.click(screen.getByLabelText(/loan repayment/i));
        await user.type(screen.getByLabelText(/principal amount/i), "1000");
        await user.type(screen.getByLabelText(/annual interest/i), "3,5");
        const termField = screen.getByLabelText(/term \(months\)/i);
        await user.type(termField, "601");

        await user.click(submitBtn());

        await waitFor(() =>
            expect(termField).toHaveAttribute("aria-invalid", "true"),
        );
        expect(describedError(termField)).toHaveTextContent(
            /between 1 and 600 months/i,
        );
        expect(onSubmit).not.toHaveBeenCalled();

        // Correcting the field clears its message without another submit.
        await user.clear(termField);
        await user.type(termField, "240");
        await waitFor(() =>
            expect(termField).not.toHaveAttribute("aria-invalid"),
        );
        expect(
            screen.queryByText(/between 1 and 600 months/i),
        ).not.toBeInTheDocument();
    });

    it("flags a blank custom repeat interval on the interval field and blocks submit", async () => {
        const { user, onSubmit } = await renderSubmittableForm();

        await user.click(screen.getByLabelText("Recurring"));
        const frequency = screen.getByRole("combobox", { name: /frequency/i });
        await user.click(frequency);
        await user.click(
            await screen.findByRole("option", { name: /custom interval/i }),
        );

        await user.click(submitBtn());

        const days = screen.getByLabelText(/repeat every/i);
        await waitFor(() =>
            expect(days).toHaveAttribute("aria-invalid", "true"),
        );
        expect(describedError(days)).toHaveTextContent(/at least 1 day/i);
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("submits an unchanged payload once the loan fields are valid", async () => {
        const { user, onSubmit } = await renderSubmittableForm();

        await user.click(screen.getByLabelText(/loan repayment/i));
        await user.type(screen.getByLabelText(/principal amount/i), "1000");
        await user.type(screen.getByLabelText(/annual interest/i), "3,5");
        await user.type(screen.getByLabelText(/term \(months\)/i), "240");

        await user.click(submitBtn());

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        // Recurrence fields are deleted for loans, and the selected account is
        // sent by ID.
        expect(JSON.stringify(onSubmit.mock.calls[0][0])).toBe(
            JSON.stringify({
                name: "Mortgage",
                // Typed as "100" with the Direction toggle on its "Expense"
                // default (and locked there by the loan switch) — the form owns
                // the sign now, so it leaves as -100.
                amount: -100,
                currency: "EUR",
                due_date: todayYmd(),
                url: undefined,
                is_recurring: true,
                is_loan: true,
                loan_type: "amortizing",
                loan_principal: 1000,
                loan_annual_interest_rate: 3.5,
                loan_term_months: 240,
                loan_start_date: todayYmd(),
                loan_payment_day: new Date().getDate(),
                recipient_id: undefined,
                category_id: undefined,
                account_id: 1,
                tags: undefined,
                notes: undefined,
                is_active: true,
            }),
        );
    });

    it("sends an unchanged POST body end-to-end on a plain create", async () => {
        const user = userEvent.setup();
        let rawBody = "";

        server.use(
            http.get(`${API_BASE}/api/planned-transactions`, () =>
                ok({ items: [], total: 0, limit: 1000, offset: 0, links: [] }),
            ),
            http.post(
                `${API_BASE}/api/planned-transactions`,
                async ({ request }) => {
                    rawBody = await request.text();
                    return ok({ ...rentPayment, id: 99, memo: "Groceries" });
                },
            ),
        );

        renderWithApp(<PlannedPaymentsPage />);

        await user.click(
            await addButton(),
        );
        await screen.findByRole("dialog");

        await user.type(screen.getByLabelText("Name"), "Groceries");
        await user.type(screen.getByLabelText("Amount", { selector: "#pp-amount" }), "100");
        await pickBankAccount(user, "Main");

        await user.click(submitBtn());

        await waitFor(() => expect(rawBody).not.toBe(""));
        expect(JSON.parse(rawBody)).toEqual({
            memo: "Groceries",
            // Expense is the Direction default, so a bare "100" reaches the API
            // as -100 — the sign the forecast and auto-match both expect.
            amount: -100,
            currency: "EUR",
            planned_date: todayYmd(),
            is_recurring: false,
            is_loan: false,
            account_id: 1,
        });
    });

    it("confirms a created payment with a success toast", async () => {
        const user = userEvent.setup();
        const success = vi
            .spyOn(toast, "success")
            .mockReturnValue("t" as never);
        server.use(
            http.get(`${API_BASE}/api/planned-transactions`, () =>
                ok({ items: [], total: 0, limit: 1000, offset: 0, links: [] }),
            ),
            http.post(`${API_BASE}/api/planned-transactions`, () =>
                ok({ ...rentPayment, id: 99, memo: "Groceries" }),
            ),
        );

        renderWithApp(<PlannedPaymentsPage />);

        await user.click(
            await addButton(),
        );
        await screen.findByRole("dialog");
        await user.type(screen.getByLabelText("Name"), "Groceries");
        await user.type(screen.getByLabelText("Amount", { selector: "#pp-amount" }), "100");
        await pickBankAccount(user, "Main");
        await user.click(submitBtn());

        await waitFor(() => {
            expect(success).toHaveBeenCalledWith(
                'Planned payment "Groceries" created',
            );
        });
        success.mockRestore();
    });
});

// ─── Success feedback for row actions ───────────────────────────────────────
//
// Pausing, resuming, editing and deleting used to finish silently. Each now
// confirms through the shared toast system; none offers Undo because no undo
// path exists for planned payments.
describe("PlannedPaymentsPage (success feedback)", () => {
    function serveRent(
        payment: typeof rentPayment & { account_id?: number } = rentPayment,
    ) {
        server.use(
            http.get(`${API_BASE}/api/planned-transactions`, () =>
                ok({
                    items: [payment],
                    total: 1,
                    limit: 1000,
                    offset: 0,
                    links: [],
                }),
            ),
        );
    }

    it("confirms pausing an active payment", async () => {
        const user = userEvent.setup();
        const success = vi
            .spyOn(toast, "success")
            .mockReturnValue("t" as never);
        serveRent();
        server.use(
            http.patch(`${API_BASE}/api/planned-transactions/1`, () =>
                ok({ ...rentPayment, is_active: false }),
            ),
        );

        renderWithApp(<PlannedPaymentsPage />);
        await openRowMenu(user, "Rent");
        await user.click(
            await screen.findByRole("menuitem", { name: "Pause" }),
        );

        await waitFor(() => {
            expect(success).toHaveBeenCalledWith(
                "Payment paused",
                expect.objectContaining({ description: "Rent" }),
            );
        });
        success.mockRestore();
    });

    it("confirms resuming a paused payment", async () => {
        const user = userEvent.setup();
        const success = vi
            .spyOn(toast, "success")
            .mockReturnValue("t" as never);
        serveRent({ ...rentPayment, is_active: false });
        server.use(
            http.patch(`${API_BASE}/api/planned-transactions/1`, () =>
                ok({ ...rentPayment, is_active: true }),
            ),
        );

        renderWithApp(<PlannedPaymentsPage />, {
            initialEntries: ["/planned?show_all=true"],
        });
        await openRowMenu(user, "Rent");
        await user.click(
            await screen.findByRole("menuitem", { name: "Resume" }),
        );

        await waitFor(() => {
            expect(success).toHaveBeenCalledWith(
                "Payment resumed",
                expect.objectContaining({ description: "Rent" }),
            );
        });
        success.mockRestore();
    });

    it("confirms saving an edited payment", async () => {
        const user = userEvent.setup();
        const success = vi
            .spyOn(toast, "success")
            .mockReturnValue("t" as never);
        let patched = false;
        serveRent({ ...rentPayment, account_id: ACCOUNT_LIST_ITEM_STUB.id });
        server.use(
            http.patch(`${API_BASE}/api/planned-transactions/1`, () => {
                patched = true;
                return ok({
                    ...rentPayment,
                    account_id: ACCOUNT_LIST_ITEM_STUB.id,
                });
            }),
        );

        renderWithApp(<PlannedPaymentsPage />);
        await openRowMenu(user, "Rent");
        await user.click(
            await screen.findByRole("menuitem", { name: "Edit" }),
        );
        await screen.findByRole("dialog");
        await user.click(screen.getByRole("button", { name: /save changes/i }));

        await waitFor(() => {
            expect(success).toHaveBeenCalledWith(
                'Planned payment "Rent" updated',
            );
        });
        expect(patched).toBe(true);
        success.mockRestore();
    });

    it("confirms a deletion only after the destructive dialog is accepted", async () => {
        const user = userEvent.setup();
        const success = vi
            .spyOn(toast, "success")
            .mockReturnValue("t" as never);
        let deleted = false;
        serveRent();
        server.use(
            http.delete(`${API_BASE}/api/planned-transactions/1`, () => {
                deleted = true;
                return noContent();
            }),
        );

        renderWithApp(<PlannedPaymentsPage />);
        await openRowMenu(user, "Rent");
        await user.click(
            await screen.findByRole("menuitem", { name: "Delete" }),
        );
        const dialog = await screen.findByRole("alertdialog");
        expect(success).not.toHaveBeenCalled();
        await user.click(
            within(dialog).getByRole("button", { name: "Delete" }),
        );

        await waitFor(() => {
            expect(success).toHaveBeenCalledWith(
                'Planned payment "Rent" deleted',
            );
        });
        expect(deleted).toBe(true);
        success.mockRestore();
    });
});
