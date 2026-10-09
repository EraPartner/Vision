// @vitest-environment jsdom
import { vi, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { UpcomingPaymentsList } from "../UpcomingPaymentsList";

const payments = vi.hoisted(() =>
    [6, 4, 2, 5, 3, 1].map((day) => ({
        id: day,
        planned_date: `2026-10-0${day}`,
        recipient_name: `Payment ${day}`,
        amount: -10,
        currency: "EUR",
    })),
);
vi.mock("@/hooks/useUpcomingPlannedPayments", () => ({
    useUpcomingPlannedPayments: () => ({ visibleUpcoming: payments }),
}));
it("shows the earliest five payments in due-date order without mutating reminders", async () => {
    renderWithApp(<UpcomingPaymentsList />);
    await screen.findByText("Payment 1");
    expect(
        screen.getAllByText(/Payment \d/).map((node) => node.textContent),
    ).toEqual([
        "Payment 1",
        "Payment 2",
        "Payment 3",
        "Payment 4",
        "Payment 5",
    ]);
    expect(screen.queryByText("Payment 6")).not.toBeInTheDocument();
    expect(payments.map((payment) => payment.id)).toEqual([6, 4, 2, 5, 3, 1]);
});
