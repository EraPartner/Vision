// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { UpcomingPaymentsNotification } from "@/components/notifications/UpcomingPaymentsNotification";
import { __resetDismissedCacheForTests } from "@/hooks/useUpcomingPlannedPayments";
import { renderWithApp } from "@/test/renderWithApp";
import { ok, PLANNED_TRANSACTION_STUB } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";

const API_BASE = "http://localhost:3002";
let requested = false;

describe("UpcomingPaymentsNotification route density", () => {
    beforeEach(() => {
        __resetDismissedCacheForTests();
        window.localStorage?.clear();
        requested = false;
        server.use(http.get(`${API_BASE}/api/planned-transactions`, () => {
            requested = true;
            return ok({
                items: [PLANNED_TRANSACTION_STUB],
                total: 1,
                limit: 100,
                offset: 0,
                links: [],
            });
        }));
    });

    it("shows the reminder on the dashboard route", async () => {
        renderWithApp(<UpcomingPaymentsNotification />, { initialEntries: ["/"] });
        const summary = await screen.findByRole("button", { name: "1 upcoming payment due this week" });
        expect(summary).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByRole("button", { name: "Dismiss reminder for Monthly rent" })).not.toBeInTheDocument();
        fireEvent.click(summary);
        expect(summary).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByText("Monthly rent")).toBeVisible();
        expect(screen.getByRole("link")).toHaveAttribute("href", "/planned");
        fireEvent.click(screen.getByRole("button", { name: "Dismiss reminder for Monthly rent" }));
        expect(screen.queryByRole("button", { name: "1 upcoming payment due this week" })).not.toBeInTheDocument();
    });

    it("shows the soonest payment first even when the API returns newest dates first", async () => {
        server.use(http.get(`${API_BASE}/api/planned-transactions`, () => ok({
            items: [
                { ...PLANNED_TRANSACTION_STUB, id: 2, memo: "Later payment", planned_date: "2026-09-30" },
                { ...PLANNED_TRANSACTION_STUB, id: 3, memo: "Sooner payment", planned_date: "2026-09-26" },
            ], total: 2, limit: 100, offset: 0, links: [],
        })));
        renderWithApp(<UpcomingPaymentsNotification />, { initialEntries: ["/"] });
        fireEvent.click(await screen.findByRole("button", { name: "2 upcoming payments due this week" }));
        const dismissButtons = screen.getAllByRole("button", { name: /Dismiss reminder for/ });
        expect(dismissButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
            "Dismiss reminder for Sooner payment", "Dismiss reminder for Later payment",
        ]);
    });

    it("does not repeat the reminder on the planned-payments route", async () => {
        renderWithApp(<UpcomingPaymentsNotification />, { initialEntries: ["/planned"] });
        await waitFor(() => expect(requested).toBe(true));
        expect(screen.queryByText("Monthly rent")).not.toBeInTheDocument();
    });
});
