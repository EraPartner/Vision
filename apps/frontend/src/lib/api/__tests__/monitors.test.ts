// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { API_BASE, ok } from "./clientTestHarness";
import {
    checkMonitor,
    createMonitor,
    listMonitorNotifications,
    listMonitorObservations,
    listMonitors,
    readMonitorNotification,
    updateMonitor,
} from "@/lib/api/monitors";

afterEach(() => server.resetHandlers());

describe("analysis monitor API client", () => {
    it("uses bounded paging and exposes unread count", async () => {
        const urls: string[] = [];
        server.use(
            http.get(`${API_BASE}/api/analysis/monitors`, ({ request }) => {
                urls.push(request.url);
                return ok({ items: [], total: 240, limit: 200, offset: 200 });
            }),
            http.get(
                `${API_BASE}/api/analysis/monitors/m-1/observations`,
                ({ request }) => {
                    urls.push(request.url);
                    return ok({
                        items: [],
                        total: 230,
                        limit: 200,
                        offset: 200,
                    });
                },
            ),
            http.get(
                `${API_BASE}/api/analysis/monitors/notifications`,
                ({ request }) => {
                    urls.push(request.url);
                    return ok({
                        items: [],
                        total: 220,
                        unreadCount: 7,
                        limit: 200,
                        offset: 200,
                    });
                },
            ),
        );
        expect((await listMonitors(200)).total).toBe(240);
        expect((await listMonitorObservations("m-1", 200)).total).toBe(230);
        expect((await listMonitorNotifications(200)).unreadCount).toBe(7);
        expect(urls.every((url) => url.includes("limit=200&offset=200"))).toBe(
            true,
        );
    });

    it("sends exact decimal threshold strings and partial edits", async () => {
        const bodies: unknown[] = [];
        server.use(
            http.post(
                `${API_BASE}/api/analysis/monitors`,
                async ({ request }) => {
                    bodies.push(await request.json());
                    return ok({ id: "m-1" });
                },
            ),
            http.patch(
                `${API_BASE}/api/analysis/monitors/m-1`,
                async ({ request }) => {
                    bodies.push(await request.json());
                    return ok({ id: "m-1" });
                },
            ),
        );
        await createMonitor({
            kind: "analysis-threshold",
            title: "Limit",
            savedAnalysisId: "a-1",
            fieldId: "sum",
            operator: "above",
            threshold: "100.00000001",
        });
        await updateMonitor("m-1", { enabled: false });
        expect(bodies).toEqual([
            {
                kind: "analysis-threshold",
                title: "Limit",
                savedAnalysisId: "a-1",
                fieldId: "sum",
                operator: "above",
                threshold: "100.00000001",
            },
            { enabled: false },
        ]);
    });

    it("checks explicitly and marks persisted notifications read", async () => {
        server.use(
            http.post(`${API_BASE}/api/analysis/monitors/m-1/check`, () =>
                ok({ id: "o-1", status: "baseline" }),
            ),
            http.post(
                `${API_BASE}/api/analysis/monitors/notifications/n-1/read`,
                () => ok({ id: "n-1", readAt: "2026-09-19T00:00:00Z" }),
            ),
        );
        expect((await checkMonitor("m-1")).status).toBe("baseline");
        expect((await readMonitorNotification("n-1")).readAt).not.toBeNull();
    });

    it("handles 204 delete transport through the shared envelope client", async () => {
        server.use(
            http.delete(
                `${API_BASE}/api/analysis/monitors/m-1`,
                () => new HttpResponse(null, { status: 204 }),
            ),
        );
        const { deleteMonitor } = await import("@/lib/api/monitors");
        await expect(deleteMonitor("m-1")).resolves.toBeUndefined();
    });
});
