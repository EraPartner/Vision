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

/** `mapObservation` for a first (baseline) check. */
const OBSERVATION = {
    id: "o-1",
    monitorId: "m-1",
    status: "baseline",
    previousValue: null,
    currentValue: "120",
    previousEvidenceVersion: null,
    currentEvidenceVersion: null,
    analysisDefinitionVersion: 1,
    analysisRunId: "run-1",
    historicalAnalysisRunId: "run-1",
    analysisRunStatus: "succeeded",
    analysisWindow: null,
    coverage: { status: "unknown" },
    reasonCode: "baseline",
    reason: "First observation",
    checkedAt: "2026-09-19T00:00:00.000Z",
};

/** `mapMonitor` for a threshold rule that has not been checked yet. */
const MONITOR = {
    id: "m-1",
    kind: "analysis-threshold",
    title: "Limit",
    enabled: true,
    savedAnalysisId: "a-1",
    dossierId: null,
    historicalTargetId: "a-1",
    targetLabel: "Spending",
    targetAvailable: true,
    fieldId: "sum",
    operator: "above",
    threshold: "100.00000001",
    intervalMinutes: 1440,
    cooldownMinutes: 1440,
    nextDueAt: "2026-09-19T00:00:00.000Z",
    lastCheckedAt: null,
    lastStatus: null,
    lastObservation: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
};

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
                    return ok(MONITOR);
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
                ok(OBSERVATION),
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

    it("rejects a monitor page whose threshold arrives as a number", async () => {
        server.use(
            http.get(`${API_BASE}/api/analysis/monitors`, () =>
                ok({
                    items: [{ ...MONITOR, threshold: 100 }],
                    total: 1,
                    limit: 200,
                    offset: 0,
                }),
            ),
        );
        await expect(listMonitors()).rejects.toMatchObject({
            name: "ApiContractError",
            endpoint: "GET /api/analysis/monitors",
        });
    });
});
