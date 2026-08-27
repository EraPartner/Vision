// @vitest-environment jsdom
//
// Sign convention under test: a planned payment's stored `amount` is negative
// for money out and positive for money in. The form's amount field holds an
// unsigned magnitude and the Direction toggle owns the sign, so a bill typed as
// "150" must reach onSubmit as -150 — otherwise it renders as income, inflates
// the cashflow forecast, and plannedMatchService's same-sign rule stops it from
// ever auto-clearing against the real -150 transaction.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import PlannedPaymentForm from "@/features/planned/PlannedPaymentForm";
import type { PlannedPayment } from "@/hooks/usePlannedPayments";

const EXPENSE: PlannedPayment = {
    id: 1,
    name: "Rent",
    amount: -1200,
    currency: "EUR",
    due_date: "2025-02-01",
    bank_account: "BE12345678901234",
    is_recurring: false,
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
};

const INCOME: PlannedPayment = {
    ...EXPENSE,
    id: 2,
    name: "Salary",
    amount: 2500,
};

const LOAN: PlannedPayment = {
    ...EXPENSE,
    id: 3,
    name: "Mortgage",
    amount: -450.5,
    is_recurring: true,
    is_loan: true,
    loan_type: "amortizing",
    loan_principal: 100000,
    loan_annual_interest_rate: 3,
    loan_term_months: 240,
    loan_start_date: "2025-02-01",
    loan_payment_day: 1,
};

/**
 * The locale dictionary is imported lazily by LanguageProvider, so every query
 * here must run after the dialog title has resolved to real English — before
 * that, t() returns bare keys and label queries miss.
 */
async function renderForm(initial?: PlannedPayment) {
    const onSubmit = vi.fn();
    renderWithApp(
        <PlannedPaymentForm
            open
            onOpenChange={vi.fn()}
            onSubmit={onSubmit}
            initial={initial}
        />,
    );
    await screen.findByText(initial ? "Edit payment" : "New planned payment");
    return { onSubmit };
}

/** The magnitude field — labelled "Amount *". */
function amountInput() {
    return screen.getByLabelText("Amount *");
}

function submitButton() {
    return screen.getByRole("button", { name: /create payment|save changes/i });
}

/**
 * Fill the two other required fields so submission is not blocked. Bank account
 * is an AccountCombobox — open it, type, take the create escape hatch (same
 * flow as PlannedPaymentsPage.integration.test.tsx).
 */
async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText("Name *"), "Rent");
    await user.click(screen.getByLabelText(/bank account/i));
    await user.type(
        screen.getByPlaceholderText(/search or type a new account/i),
        "Main",
    );
    await user.click(await screen.findByText(/create account "Main"/i));
}

describe("PlannedPaymentForm — amount direction", () => {
    beforeEach(() => vi.clearAllMocks());

    it("defaults to expense and negates a bare amount on save", async () => {
        const user = userEvent.setup();
        const { onSubmit } = await renderForm();

        expect(screen.getByRole("radio", { name: /expense/i })).toHaveAttribute(
            "data-state",
            "on",
        );

        await fillRequired(user);
        await user.type(amountInput(), "150");
        await user.click(submitButton());

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0]).toMatchObject({ amount: -150 });
    });

    it("keeps the amount positive when income is selected", async () => {
        const user = userEvent.setup();
        const { onSubmit } = await renderForm();

        await fillRequired(user);
        await user.type(amountInput(), "150");
        await user.click(screen.getByRole("radio", { name: /income/i }));
        await user.click(submitButton());

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0]).toMatchObject({ amount: 150 });
    });

    it("ignores a typed minus sign — the toggle owns the sign", async () => {
        const user = userEvent.setup();
        const { onSubmit } = await renderForm();

        await fillRequired(user);
        await user.type(amountInput(), "-150");
        await user.click(screen.getByRole("radio", { name: /income/i }));
        await user.click(submitButton());

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0]).toMatchObject({ amount: 150 });
    });

    it("shows a stored expense as its absolute value with expense selected", async () => {
        await renderForm(EXPENSE);

        expect(amountInput()).toHaveValue("1200");
        expect(screen.getByRole("radio", { name: /expense/i })).toHaveAttribute(
            "data-state",
            "on",
        );
    });

    it("shows a stored income as positive with income selected", async () => {
        await renderForm(INCOME);

        expect(amountInput()).toHaveValue("2500");
        expect(screen.getByRole("radio", { name: /income/i })).toHaveAttribute(
            "data-state",
            "on",
        );
    });

    it("round-trips an edited expense without flipping its sign", async () => {
        const user = userEvent.setup();
        const { onSubmit } = await renderForm(EXPENSE);

        await user.click(submitButton());

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0]).toMatchObject({ amount: -1200 });
    });

    it("round-trips an edited income without flipping its sign", async () => {
        const user = userEvent.setup();
        const { onSubmit } = await renderForm(INCOME);

        await user.click(submitButton());

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0]).toMatchObject({ amount: 2500 });
    });

    it("submits exactly once on Enter in the amount field", async () => {
        // Enter-to-submit regression (TODO.md "Enter never submits in the
        // button-only dialogs"): the dialog body is now a real <form>, so Enter
        // in a text field must submit — and only once (no button-onClick +
        // form-onSubmit double fire).
        const user = userEvent.setup();
        const { onSubmit } = await renderForm();

        await fillRequired(user);
        await user.type(amountInput(), "150{Enter}");

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0]).toMatchObject({ amount: -150 });
    });

    it("does not submit on Enter inside the currency Select", async () => {
        // Radix Select handles Enter itself (preventDefault) — picking an
        // option with the keyboard must never fall through to the form.
        const user = userEvent.setup();
        const { onSubmit } = await renderForm();

        await fillRequired(user);
        await user.type(amountInput(), "150");
        await user.click(screen.getByRole("combobox", { name: /currency/i }));
        await user.keyboard("{ArrowDown}{Enter}");

        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("does not submit on Enter inside the notes textarea", async () => {
        // Native behavior stays: textareas swallow Enter as a newline.
        const user = userEvent.setup();
        const { onSubmit } = await renderForm();

        await fillRequired(user);
        await user.type(amountInput(), "150");
        await user.type(
            screen.getByLabelText(/notes/i),
            "line one{Enter}line two",
        );

        expect(onSubmit).not.toHaveBeenCalled();
        expect(screen.getByLabelText(/notes/i)).toHaveValue(
            "line one\nline two",
        );
    });

    it("cancel closes without submitting", async () => {
        const user = userEvent.setup();
        const onSubmit = vi.fn();
        const onOpenChange = vi.fn();
        renderWithApp(
            <PlannedPaymentForm
                open
                onOpenChange={onOpenChange}
                onSubmit={onSubmit}
            />,
        );
        await screen.findByText("New planned payment");

        await user.type(amountInput(), "150");
        await user.click(screen.getByRole("button", { name: /cancel/i }));

        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("disables submit while the caller's save is in flight", async () => {
        const onSubmit = vi.fn();
        renderWithApp(
            <PlannedPaymentForm
                open
                onOpenChange={vi.fn()}
                onSubmit={onSubmit}
                loading
            />,
        );
        await screen.findByText("New planned payment");

        expect(submitButton()).toBeDisabled();
    });

    it("locks a loan to expense and re-sends the schedule's negative installment", async () => {
        const user = userEvent.setup();
        const { onSubmit } = await renderForm(LOAN);

        const expense = screen.getByRole("radio", { name: /expense/i });
        expect(expense).toHaveAttribute("data-state", "on");
        expect(expense).toBeDisabled();
        expect(screen.getByRole("radio", { name: /income/i })).toBeDisabled();

        await user.click(submitButton());

        // Not -(-450.5): the magnitude/direction split reproduces the stored
        // value, so the server's own -Math.abs() is never applied twice.
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0]).toMatchObject({ amount: -450.5 });
    });
});
