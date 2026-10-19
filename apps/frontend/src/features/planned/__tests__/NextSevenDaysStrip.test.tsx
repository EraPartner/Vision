// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { NextSevenDaysStrip } from "@/features/planned/NextSevenDaysStrip";
import type { PlannedPayment } from "@/hooks/usePlannedPayments";

function todayYmd(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function payment(id: number, amount: number, currency: string): PlannedPayment {
  return {
    id,
    name: `Payment ${id}`,
    amount,
    currency,
    due_date: todayYmd(),
    bank_account: "Main",
    is_recurring: true,
    frequency: "monthly",
    is_active: true,
    is_executed: false,
    created_at: `${todayYmd()}T00:00:00.000Z`,
  };
}

/** The server's next_days_total: -10 EUR converted, the GBP row left out. */
const WINDOW_TOTAL = {
  from: todayYmd(),
  to: todayYmd(),
  incoming: 0,
  outgoing: -10,
  net: -10,
  unconverted_count: 1,
};

describe("NextSevenDaysStrip currency totals", () => {
  it("shows the server window total and that missing-rate payments are left out", async () => {
    const payments = [payment(1, -10, "EUR"), payment(2, -99, "GBP")];

    renderWithApp(
      <NextSevenDaysStrip
        payments={payments}
        estimatedMonthly={-10}
        estimatedMonthlyUnavailableCount={1}
        windowTotal={WINDOW_TOTAL}
        onSelect={vi.fn()}
      />,
    );

    const notices = await screen.findAllByText(
      "1 payment left out: exchange rate unavailable",
    );
    expect(notices).toHaveLength(2);

    const windowSummary = screen.getByText("2 payments due").parentElement;
    expect(windowSummary).toHaveTextContent("10,00");
    expect(windowSummary).not.toHaveTextContent("99");
  });

  it("keeps both aggregates pending while the server totals load", async () => {
    const payments = [payment(1, -10, "EUR"), payment(2, -99, "GBP")];

    renderWithApp(
      <NextSevenDaysStrip
        payments={payments}
        estimatedMonthly={undefined}
        estimatedMonthlyUnavailableCount={1}
        windowTotal={undefined}
        onSelect={vi.fn()}
      />,
    );

    const loadingStatuses = screen.getAllByRole("status");
    expect(loadingStatuses).toHaveLength(2);
    expect(loadingStatuses.every((status) => status.hasAttribute("aria-label"))).toBe(true);
    expect(
      screen.queryByText("1 payment left out: exchange rate unavailable"),
    ).not.toBeInTheDocument();
  });
});
