// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PlannedPaymentsTable } from "@/features/planned/PlannedPaymentsTable";
import type { PlannedPayment } from "@/hooks/usePlannedPayments";

const translations = vi.hoisted<Record<string, string>>(() => ({
    "common.delete": "Delete",
    "common.edit": "Edit",
    "plannedPage.due.overdue": "Overdue",
    "plannedPage.everyNDays": "Every {n} days",
    "plannedPage.execute.button": "Mark as paid",
    "plannedPage.execute.linked": "Paid (transaction {n})",
    "plannedPage.freq.monthly": "Monthly",
    "plannedPage.loanBadge": "Loan",
    "plannedPage.loanTerm.one": "Loan ({count} month)",
    "plannedPage.loanTerm.other": "Loan ({count} months)",
    "plannedPage.oneTime": "One-time",
    "plannedPage.openLink": "Open related link",
    "plannedPage.pause": "Pause",
    "plannedPage.resume": "Resume",
    "plannedPage.rowMenu": "Actions for {name}",
    "plannedPage.statusPaused": "Paused",
}));

vi.mock("@/stores/hydration/LanguageHydration", () => {
    const t = (key: string, params?: Record<string, string | number>) => {
        const template = translations[key] ?? key;
        return Object.entries(params ?? {}).reduce(
            (value, [name, replacement]) =>
                value.replace(`{${name}}`, String(replacement)),
            template,
        );
    };
    return {
        useLanguage: () => ({
            t,
            tc: (
                key: string,
                count: number,
                params?: Record<string, string | number>,
            ) =>
                t(`${key}.${count === 1 ? "one" : "other"}`, {
                    count,
                    ...params,
                }),
        }),
    };
});

vi.mock("@/components/shared/Money", () => ({
    Money: ({ amount, currency }: { amount: number; currency?: string }) => (
        <span>
            {amount} {currency}
        </span>
    ),
}));

vi.mock("@/components/shared/VirtualDataTable", () => ({
    VirtualDataTable: ({
        columns,
        data,
    }: {
        columns: Array<{
            key: string;
            render?: (row: Record<string, unknown>) => ReactNode;
        }>;
        data: Array<Record<string, unknown>>;
    }) => (
        <div>
            {data.map((row, rowIndex) => (
                <div key={String(row.id ?? rowIndex)}>
                    {columns.map((column) => (
                        <div key={`${rowIndex}-${column.key}`}>
                            {column.render
                                ? column.render(row)
                                : String(row[column.key] ?? "")}
                        </div>
                    ))}
                </div>
            ))}
        </div>
    ),
}));

function payment(overrides: Partial<PlannedPayment> = {}): PlannedPayment {
    return {
        id: 1,
        name: "Rent",
        amount: -1000,
        currency: "EUR",
        due_date: "2026-09-01",
        is_recurring: true,
        frequency: "monthly",
        is_active: true,
        is_executed: false,
        created_at: "2026-01-01T00:00:00Z",
        ...overrides,
    } as PlannedPayment;
}

function renderTable(
    payments: PlannedPayment[],
    callbacks: Partial<{
        onRequestExecution: (value: PlannedPayment) => void;
        onEdit: (value: PlannedPayment) => void;
        onToggleActive: (value: PlannedPayment) => void;
        onDelete: (value: PlannedPayment) => void;
    }> = {},
) {
    const props = {
        onRequestExecution: vi.fn(),
        onEdit: vi.fn(),
        onToggleActive: vi.fn(),
        onDelete: vi.fn(),
        ...callbacks,
    };
    render(
        <MemoryRouter>
            <PlannedPaymentsTable
                payments={payments}
                totalCount={payments.length}
                dateFormat="yyyy-MM-dd"
                actionLoading={false}
                {...props}
            />
        </MemoryRouter>,
    );
    return props;
}

async function openRowMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(screen.getByRole("button", { name: `Actions for ${name}` }));
    return screen.findByRole("menu");
}

describe("PlannedPaymentsTable", () => {
    it("wires Mark as paid and the row menu's Edit, Pause and Delete to the page callbacks", async () => {
        const user = userEvent.setup();
        const row = payment();
        const callbacks = renderTable([row]);

        await user.click(
            screen.getByRole("button", { name: "Mark as paid: Rent" }),
        );
        expect(callbacks.onRequestExecution).toHaveBeenCalledWith(
            expect.objectContaining({ id: 1 }),
        );

        let menu = await openRowMenu(user, "Rent");
        await user.click(within(menu).getByRole("menuitem", { name: "Edit" }));
        expect(callbacks.onEdit).toHaveBeenCalledWith(
            expect.objectContaining({ id: 1 }),
        );

        menu = await openRowMenu(user, "Rent");
        await user.click(within(menu).getByRole("menuitem", { name: "Pause" }));
        expect(callbacks.onToggleActive).toHaveBeenCalledWith(
            expect.objectContaining({ id: 1 }),
        );

        menu = await openRowMenu(user, "Rent");
        await user.click(
            within(menu).getByRole("menuitem", { name: "Delete" }),
        );
        expect(callbacks.onDelete).toHaveBeenCalledWith(
            expect.objectContaining({ id: 1 }),
        );
    });

    it("marks a paused row with a badge and offers Resume instead of Pause", async () => {
        const user = userEvent.setup();
        const callbacks = renderTable([
            payment(),
            payment({ id: 2, name: "Internet", is_active: false }),
        ]);

        expect(screen.getByText("Paused")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Actions for Rent" }),
        ).toHaveAttribute("aria-haspopup", "menu");

        const menu = await openRowMenu(user, "Internet");
        expect(
            within(menu).queryByRole("menuitem", { name: "Pause" }),
        ).not.toBeInTheDocument();
        await user.click(
            within(menu).getByRole("menuitem", { name: "Resume" }),
        );
        expect(callbacks.onToggleActive).toHaveBeenCalledWith(
            expect.objectContaining({ id: 2 }),
        );
    });

    it("links a paid row to its transaction and disables Mark as paid for a paused one", () => {
        renderTable([
            payment({
                id: 1,
                name: "Executed",
                is_executed: true,
                executed_transaction_id: 99,
            }),
            payment({ id: 2, name: "Paused", is_active: false }),
        ]);

        expect(
            screen.queryByRole("button", { name: "Mark as paid: Executed" }),
        ).not.toBeInTheDocument();
        expect(screen.getByRole("link", { name: /paid/i })).toHaveAttribute(
            "href",
            "/transactions?transaction_id=99",
        );
        expect(
            screen.getByRole("button", { name: "Mark as paid: Paused" }),
        ).toBeDisabled();
    });

    it("renders safe links and the loan, custom, and one-time recurrence variants", () => {
        renderTable([
            payment({
                id: 1,
                name: "Custom",
                frequency: "custom",
                custom_interval_days: 9,
                url: "https://example.com/bill",
            }),
            payment({
                id: 2,
                name: "One time",
                is_recurring: false,
                url: "javascript:alert(1)",
            }),
            payment({
                id: 3,
                name: "Loan",
                is_loan: true,
                loan_term_months: 24,
            }),
        ]);

        expect(
            screen.getByRole("link", { name: "Open related link: Custom" }),
        ).toHaveAttribute("href", "https://example.com/bill");
        expect(screen.getAllByRole("link")).toHaveLength(1);
        expect(screen.getByText("Every 9 days")).toBeInTheDocument();
        expect(screen.getByText("One-time")).toBeInTheDocument();
        expect(screen.getByText("Loan (24 months)")).toBeInTheDocument();
        expect(screen.getAllByText("Loan")).toHaveLength(2);
    });
});
