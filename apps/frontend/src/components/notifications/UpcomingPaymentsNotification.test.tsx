// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
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
        expect(await screen.findByText("Monthly rent")).toBeInTheDocument();
    });

    it("does not repeat the reminder on the planned-payments route", async () => {
        renderWithApp(<UpcomingPaymentsNotification />, { initialEntries: ["/planned"] });
        await waitFor(() => expect(requested).toBe(true));
        expect(screen.queryByText("Monthly rent")).not.toBeInTheDocument();
    });
});
