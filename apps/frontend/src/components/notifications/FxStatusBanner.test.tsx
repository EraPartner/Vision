// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { FxStatusBanner } from "@/components/notifications/FxStatusBanner";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";

const API_BASE = "http://localhost:3002";

describe("FxStatusBanner", () => {
    it("refreshes stale rates inline and then reloads the status", async () => {
        let statusRequests = 0;
        let refreshRequests = 0;
        server.use(
            http.get(`${API_BASE}/api/info/exchange-rates`, () => {
                statusRequests += 1;
                return ok({
                    rates: [],
                    fallback_rates: {},
                    base: "EUR",
                    date: "2025-01-01",
                    source: "fallback",
                    is_stale: true,
                    last_fetched_at: "2025-01-01T00:00:00.000Z",
                });
            }),
            http.post(`${API_BASE}/api/info/exchange-rates/refresh`, () => {
                refreshRequests += 1;
                return ok({ message: "refreshed" });
            }),
        );

        const user = userEvent.setup();
        renderWithApp(<FxStatusBanner />);

        await user.click(await screen.findByRole("button", { name: /refresh/i }));

        await waitFor(() => {
            expect(refreshRequests).toBe(1);
            expect(statusRequests).toBeGreaterThanOrEqual(2);
        });
    });
});
