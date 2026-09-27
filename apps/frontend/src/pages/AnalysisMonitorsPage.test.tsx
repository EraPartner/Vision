// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, ok } from "@/test/msw/handlers";
import AnalysisMonitorsPage from "@/pages/AnalysisMonitorsPage";

const api = "http://localhost:3002/api";

describe("AnalysisMonitorsPage", () => {
    beforeEach(() => {
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
            http.get(`${api}/analysis/monitors/m-1/observations`, () =>
                ok({ items: [], total: 0, limit: 200, offset: 0 }),
            ),
        );
    });
    it("offers retry without claiming that failed rules are empty", async () => {
        const user = userEvent.setup();
        server.use(
            http.get(`${api}/analysis/monitors`, () => err(403, "Unavailable")),
        );
        renderWithApp(<AnalysisMonitorsPage />);
        const error = await screen.findByText("Could not load monitors");
        expect(screen.queryByText("No monitors yet.")).not.toBeInTheDocument();
        server.use(
            http.get(`${api}/analysis/monitors`, () =>
                ok({ items: [], total: 0, limit: 200, offset: 0 }),
            ),
        );
        await user.click(
            within(error.parentElement!).getByRole("button", { name: "Retry" }),
        );
        expect(await screen.findByText("No monitors yet.")).toBeInTheDocument();
        expect(
            screen.queryByText("Could not load monitors"),
        ).not.toBeInTheDocument();
    });

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
        await screen.findByRole("option", { name: "Cash flow" });
        await user.selectOptions(
            screen.getByLabelText("Saved analysis"),
            "a-1",
        );
        await user.type(screen.getByLabelText("Title"), "Cash threshold");
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
            intervalMinutes: 1440,
            cooldownMinutes: 1440,
        });
    });

    it("guides users to create a target and keeps unavailable condition inputs hidden", async () => {
        server.use(
            http.get(`${api}/analysis/saved`, () => ok({ items: [] })),
            http.get(`${api}/research-dossiers`, () =>
                ok({ items: [], total: 0, limit: 500, offset: 0 }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<AnalysisMonitorsPage />);
        expect(
            await screen.findByRole("link", { name: "Open Analysis" }),
        ).toHaveAttribute("href", "/analysis");
        expect(
            screen.queryByLabelText("Numeric field"),
        ).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /create monitor/i }),
        ).not.toBeInTheDocument();
        await user.selectOptions(
            screen.getByLabelText("Condition type"),
            "dossier-evidence",
        );
        expect(
            await screen.findByRole("link", { name: "Open dossiers" }),
        ).toHaveAttribute("href", "/research/dossiers");
        expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
    });

    it("retains a custom schedule when the evidence form disclosure is closed", async () => {
        let posted: unknown;
        server.use(
            http.get(`${api}/analysis/saved`, () => ok({ items: [] })),
            http.get(`${api}/research-dossiers`, () =>
                ok({
                    items: [{ id: "d-1", title: "Research" }],
                    total: 1,
                    limit: 500,
                    offset: 0,
                }),
            ),
            http.post(`${api}/analysis/monitors`, async ({ request }) => {
                posted = await request.json();
                return ok({ id: "m-1" });
            }),
        );
        const user = userEvent.setup();
        renderWithApp(<AnalysisMonitorsPage />);
        await user.selectOptions(
            screen.getByLabelText("Condition type"),
            "dossier-evidence",
        );
        await screen.findByRole("option", { name: "Research" });
        await user.selectOptions(
            screen.getByLabelText("Research dossier"),
            "d-1",
        );
        await user.type(screen.getByLabelText("Title"), "Evidence changes");
        expect(screen.queryByLabelText("Threshold")).not.toBeInTheDocument();
        const schedule = screen.getByText("Schedule", { selector: "summary" });
        expect(schedule.parentElement).not.toHaveAttribute("open");
        await user.click(schedule);
        const interval = screen.getByLabelText(/interval/i);
        const cooldown = screen.getByLabelText(/cooldown/i);
        await user.clear(interval);
        await user.type(interval, "1");
        await user.click(schedule);
        await user.click(
            screen.getByRole("button", { name: /create monitor/i }),
        );
        expect(posted).toBeUndefined();
        expect(schedule.parentElement).toHaveAttribute("open");
        expect(interval).toHaveFocus();
        expect(interval).toBeInvalid();
        await user.clear(interval);
        await user.type(interval, "60");
        await user.clear(cooldown);
        await user.type(cooldown, "120");
        await user.click(schedule);
        expect(schedule.parentElement).not.toHaveAttribute("open");
        await user.click(
            screen.getByRole("button", { name: /create monitor/i }),
        );
        expect(await screen.findByRole("status")).toHaveTextContent(
            "Monitor created",
        );
        expect(posted).toEqual({
            kind: "dossier-evidence",
            title: "Evidence changes",
            dossierId: "d-1",
            intervalMinutes: 60,
            cooldownMinutes: 120,
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
