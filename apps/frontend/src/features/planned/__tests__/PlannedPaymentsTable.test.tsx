// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PlannedPaymentsTable } from "@/features/planned/PlannedPaymentsTable";
import type { PlannedPayment } from "@/hooks/usePlannedPayments";

const translations = vi.hoisted<Record<string, string>>(() => ({
  "aria.deletePlannedPayment": "Delete planned payment",
  "aria.editPlannedPayment": "Edit planned payment",
  "plannedPage.due.overdue": "Overdue",
  "plannedPage.everyNDays": "Every {n}d",
  "plannedPage.execute.button": "Execute payment",
  "plannedPage.execute.linked": "Executed (linked to transaction #{n})",
  "plannedPage.freq.monthly": "Monthly",
  "plannedPage.loanBadge": "Loan",
  "plannedPage.oneTime": "One-time",
  "plannedPage.openLink": "Open related link",
  "plannedPage.statusActive": "Active",
  "plannedPage.statusPaused": "Paused",
}));

vi.mock("@/stores/hydration/LanguageHydration", () => ({
  useLanguage: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const template = translations[key] ?? key;
      return Object.entries(params ?? {}).reduce(
        (value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)),
        template,
      );
    },
  }),
}));

vi.mock("@/components/shared/Money", () => ({
  Money: ({ amount, currency }: { amount: number; currency?: string }) => (
    <span>{amount} {currency}</span>
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
              {column.render ? column.render(row) : String(row[column.key] ?? "")}
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
    <PlannedPaymentsTable
      payments={payments}
      totalCount={payments.length}
      dateFormat="yyyy-MM-dd"
      actionLoading={false}
      {...props}
    />,
  );
  return props;
}

describe("PlannedPaymentsTable", () => {
  it("wires execute, edit, toggle, and delete actions to the page callbacks", async () => {
    const user = userEvent.setup();
    const row = payment();
    const callbacks = renderTable([row]);

    await user.click(screen.getByTitle("Execute payment"));
    await user.click(screen.getByRole("button", { name: "Edit planned payment" }));
    await user.click(screen.getByRole("button", { name: "Active" }));
    await user.click(screen.getByRole("button", { name: "Delete planned payment" }));

    expect(callbacks.onRequestExecution).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(callbacks.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(callbacks.onToggleActive).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(callbacks.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("disables execution for executed and inactive payments", () => {
    renderTable([
      payment({ id: 1, name: "Executed", is_executed: true, executed_transaction_id: 99 }),
      payment({ id: 2, name: "Paused", is_active: false }),
    ]);

    expect(screen.getByTitle(/linked.*99/i)).toBeDisabled();
    expect(screen.getByTitle("Execute payment")).toBeDisabled();
  });

  it("renders safe links and the loan, custom, and one-time recurrence variants", () => {
    renderTable([
      payment({ id: 1, name: "Custom", frequency: "custom", custom_interval_days: 9, url: "https://example.com/bill" }),
      payment({ id: 2, name: "One time", is_recurring: false, url: "javascript:alert(1)" }),
      payment({ id: 3, name: "Loan", is_loan: true, loan_term_months: 24 }),
    ]);

    expect(screen.getByRole("link", { name: "Open related link" })).toHaveAttribute(
      "href",
      "https://example.com/bill",
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText("Every 9d")).toBeInTheDocument();
    expect(screen.getByText("One-time")).toBeInTheDocument();
    expect(screen.getByText("loan(24 months)")).toBeInTheDocument();
    expect(screen.getAllByText("Loan")).toHaveLength(2);
  });
});
