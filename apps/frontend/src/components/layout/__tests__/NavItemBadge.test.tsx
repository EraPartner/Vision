// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http } from "msw";
import { NavItemBadge, SidebarCount } from "../NavItemBadge";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { insightsCountRefetchInterval } from "@/hooks/useInsightsDigest";

const API_BASE = "http://localhost:3002";

describe("SidebarCount", () => {
    it("renders nothing for zero and caps large counts", () => {
        const { container, rerender } = renderWithApp(
            <SidebarCount count={0} label="0 items" />,
        );
        expect(container.querySelector("[data-sidebar=count]")).toBeNull();
        rerender(<SidebarCount count={250} label="250 items" tone="hot" />);
        expect(screen.getByText("99+")).toBeInTheDocument();
        expect(screen.getByText("250 items")).toHaveClass("sr-only");
        expect(
            container.querySelector("[data-sidebar=count]"),
        ).toHaveAttribute("data-tone", "hot");
    });
});

describe("NavItemBadge insights", () => {
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

        renderWithApp(<NavItemBadge kind="insights" />);

        expect(await screen.findByText("3")).toBeInTheDocument();
        expect(screen.getByText("3 new insights")).toHaveClass("sr-only");
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

        renderWithApp(<NavItemBadge kind="insights" />);

        await waitFor(() => expect(countRequests).toBe(1));
        expect(screen.queryByText(/\d+/)).not.toBeInTheDocument();
    });
});

describe("NavItemBadge monitors", () => {
    it("shows the server-side unread count", async () => {
        server.use(
            http.get(`${API_BASE}/api/analysis/monitors/notifications`, () =>
                ok({ items: [], total: 0, unreadCount: 2, links: [] }),
            ),
        );
        renderWithApp(<NavItemBadge kind="monitors" />);
        expect(await screen.findByText("2")).toBeInTheDocument();
    });
});
