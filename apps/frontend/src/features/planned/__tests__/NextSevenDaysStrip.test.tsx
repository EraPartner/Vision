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

describe("NextSevenDaysStrip currency totals", () => {
  it("shows that missing-rate payments are excluded from both visible aggregates", async () => {
    const payments = [payment(1, -10, "EUR"), payment(2, -99, "GBP")];
    const convertAmount = (amount: number, currency?: string) =>
      currency === "GBP" ? undefined : amount;

    renderWithApp(
      <NextSevenDaysStrip
        payments={payments}
        estimatedMonthly={-10}
        estimatedMonthlyUnavailableCount={1}
        currencyRatesLoading={false}
        convertAmount={convertAmount}
        onSelect={vi.fn()}
      />,
    );

    const notices = await screen.findAllByText(
      "1 payment excluded: exchange rate unavailable",
    );
    expect(notices).toHaveLength(2);

    const windowSummary = screen.getByText("2 payments due").parentElement;
    expect(windowSummary).toHaveTextContent("10,00");
    expect(windowSummary).not.toHaveTextContent("99");
  });

  it("keeps both aggregates pending while exchange rates are loading", async () => {
    const payments = [payment(1, -10, "EUR"), payment(2, -99, "GBP")];

    renderWithApp(
      <NextSevenDaysStrip
        payments={payments}
        estimatedMonthly={-10}
        estimatedMonthlyUnavailableCount={1}
        currencyRatesLoading
        convertAmount={(amount, currency) => currency === "GBP" ? undefined : amount}
        onSelect={vi.fn()}
      />,
    );

    const loadingStatuses = screen.getAllByRole("status");
    expect(loadingStatuses).toHaveLength(2);
    expect(loadingStatuses.every((status) => status.hasAttribute("aria-label"))).toBe(true);
    expect(
      screen.queryByText("1 payment excluded: exchange rate unavailable"),
    ).not.toBeInTheDocument();
  });
});
