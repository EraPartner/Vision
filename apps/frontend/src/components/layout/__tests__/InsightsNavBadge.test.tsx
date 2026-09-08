// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http } from "msw";
import { InsightsNavBadge } from "../InsightsNavBadge";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { insightsCountRefetchInterval } from "@/hooks/useInsightsDigest";

const API_BASE = "http://localhost:3002";

describe("InsightsNavBadge", () => {
    it("retries pending counts quickly and unavailable counts after backoff", () => {
        expect(insightsCountRefetchInterval("pending")).toBe(2_000);
        expect(insightsCountRefetchInterval("unavailable")).toBe(60_000);
        expect(insightsCountRefetchInterval("ready")).toBe(false);
    });

    it("reads only the persisted count and renders it when ready", async () => {
        let digestRequests = 0;
        server.use(
            http.get(`${API_BASE}/api/info/insights-count`, () =>
                ok({
                    count: 3,
                    status: "ready",
                    computed_at: "2026-09-08T00:00:00Z",
                }),
            ),
            http.get(`${API_BASE}/api/info/insights-digest`, () => {
                digestRequests += 1;
                return ok({});
            }),
        );

        renderWithApp(<InsightsNavBadge />);

        expect(await screen.findByText("3")).toBeVisible();
        expect(digestRequests).toBe(0);
    });

    it("does not render a stale number while refresh is pending", async () => {
        let countRequests = 0;
        server.use(
            http.get(`${API_BASE}/api/info/insights-count`, () => {
                countRequests += 1;
                return ok({
                    count: null,
                    status: "pending",
                    computed_at: null,
                });
            }),
        );

        renderWithApp(<InsightsNavBadge />);

        await waitFor(() => expect(countRequests).toBe(1));
        expect(screen.queryByText(/\d+/)).not.toBeInTheDocument();
    });
});
