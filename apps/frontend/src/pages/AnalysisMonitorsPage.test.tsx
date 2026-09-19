// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import AnalysisMonitorsPage from "@/pages/AnalysisMonitorsPage";

const api = "http://localhost:3002/api";

describe("AnalysisMonitorsPage", () => {
    it("creates an exact-decimal rule only on submit and explains baseline behavior", async () => {
        let posted: unknown = null;
        server.use(
            http.get(`${api}/analysis/monitors`, () =>
                ok({ items: [], total: 0, limit: 200, offset: 0 }),
            ),
            http.get(`${api}/analysis/monitors/notifications`, () =>
                ok({
                    items: [],
                    total: 0,
                    unreadCount: 0,
                    limit: 200,
                    offset: 0,
                }),
            ),
            http.get(`${api}/analysis/saved`, () =>
                ok({
                    items: [
                        {
                            id: "a-1",
                            name: "Cash flow",
                            refreshMode: "live",
                            lastResult: {
                                rows: [{ amount: "100.00" }],
                                columns: [{ id: "amount", type: "decimal" }],
                            },
                        },
                    ],
                }),
            ),
            http.get(`${api}/research-dossiers`, () =>
                ok({ items: [], total: 0, limit: 500, offset: 0 }),
            ),
            http.post(`${api}/analysis/monitors`, async ({ request }) => {
                posted = await request.json();
                return ok({ id: "m-1" });
            }),
        );
        const user = userEvent.setup();
        renderWithApp(<AnalysisMonitorsPage />);
        expect(
            await screen.findByText(
                /first valid check establishes a baseline/i,
            ),
        ).toBeInTheDocument();
        await user.type(screen.getByLabelText("Title"), "Cash threshold");
        await user.selectOptions(
            screen.getByLabelText("Saved analysis"),
            "a-1",
        );
        await user.selectOptions(
            screen.getByLabelText("Numeric field"),
            "amount",
        );
        await user.type(screen.getByLabelText("Threshold"), "100.00000001");
        expect(posted).toBeNull();
        await user.click(
            screen.getByRole("button", { name: /create monitor/i }),
        );
        expect(await screen.findByRole("status")).toHaveTextContent(
            "Monitor created",
        );
        expect(posted).toMatchObject({
            kind: "analysis-threshold",
            savedAnalysisId: "a-1",
            fieldId: "amount",
            threshold: "100.00000001",
        });
    });

    it("shows durable failure observations and marks inbox records read explicitly", async () => {
        let reads = 0;
        const monitor = {
            id: "m-1",
            kind: "analysis-threshold",
            title: "Cash threshold",
            enabled: true,
            savedAnalysisId: "a-1",
            dossierId: null,
            targetLabel: "Cash flow",
            fieldId: "amount",
            operator: "above",
            threshold: "100",
            intervalMinutes: 1440,
            cooldownMinutes: 1440,
            nextDueAt: null,
            lastCheckedAt: null,
            lastStatus: "failed",
            lastObservation: null,
            createdAt: "2026-09-19T00:00:00Z",
            updatedAt: "2026-09-19T00:00:00Z",
        };
        server.use(
            http.get(`${api}/analysis/monitors`, () =>
                ok({ items: [monitor], total: 1, limit: 200, offset: 0 }),
            ),
            http.get(`${api}/analysis/monitors/notifications`, () =>
                ok({
                    items: [
                        {
                            id: "n-1",
                            monitorId: "m-1",
                            observationId: "o-1",
                            kind: "analysis-threshold",
                            title: "Cash threshold",
                            reasonCode: "threshold-crossed",
                            reason: "English backend diagnostic",
                            previousValue: "99",
                            currentValue: "101",
                            createdAt: "2026-09-19T00:00:00Z",
                            readAt: null,
                        },
                    ],
                    total: 1,
                    unreadCount: 1,
                    limit: 200,
                    offset: 0,
                }),
            ),
            http.get(`${api}/analysis/monitors/m-1/observations`, () =>
                ok({
                    items: [
                        {
                            id: "o-1",
                            monitorId: "m-1",
                            status: "failed",
                            reasonCode: "analysis-execution-failed",
                            reason: "English backend diagnostic",
                            previousValue: null,
                            currentValue: null,
                            previousEvidenceVersion: null,
                            currentEvidenceVersion: null,
                            analysisRunId: null,
                            historicalAnalysisRunId: null,
                            coverage: {
                                status: "unknown",
                                reason: "English coverage detail",
                            },
                            checkedAt: "2026-09-19T00:00:00Z",
                        },
                    ],
                    total: 1,
                    limit: 200,
                    offset: 0,
                }),
            ),
            http.get(`${api}/analysis/saved`, () => ok({ items: [] })),
            http.get(`${api}/research-dossiers`, () =>
                ok({ items: [], total: 0, limit: 500, offset: 0 }),
            ),
            http.post(`${api}/analysis/monitors/notifications/n-1/read`, () => {
                reads += 1;
                return ok({ id: "n-1", readAt: "2026-09-19T01:00:00Z" });
            }),
        );
        const user = userEvent.setup();
        renderWithApp(<AnalysisMonitorsPage />);
        await user.click(
            await screen.findByRole("button", {
                name: /cash threshold.*failed/i,
            }),
        );
        expect(
            await screen.findByText("The analysis run failed."),
        ).toBeInTheDocument();
        expect(
            screen.getByText("Source coverage is not proven for this check."),
        ).toBeInTheDocument();
        expect(
            screen.getByText("The value crossed the threshold."),
        ).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /mark as read/i }));
        expect(await screen.findByRole("status")).toHaveTextContent(
            "Notification marked as read",
        );
        expect(reads).toBe(1);
    });
});
