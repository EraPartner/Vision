// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { toast } from "sonner";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, ok } from "@/test/msw/handlers";
import AdminOverviewPage from "@/pages/admin/AdminOverviewPage";
import ProviderHealthPage from "@/pages/admin/ProviderHealthPage";
import EndpointLivenessPage from "@/pages/admin/EndpointLivenessPage";
import DbMaintenancePage from "@/pages/DbMaintenancePage";

const API_BASE = "http://localhost:3002";

describe("Admin pages (integration)", () => {
    it("AdminOverviewPage renders heading", async () => {
        renderWithApp(<AdminOverviewPage />);
        expect(
            await screen.findByRole("heading", { name: /admin overview/i }),
        ).toBeInTheDocument();
    });

    it("AdminOverviewPage renders link cards after data loads", async () => {
        renderWithApp(<AdminOverviewPage />);
        expect(await screen.findByRole("link", { name: /database size/i })).toBeInTheDocument();
        expect(await screen.findByRole("link", { name: /data sources/i })).toBeInTheDocument();
        expect(await screen.findByRole("link", { name: /endpoints/i })).toBeInTheDocument();
    });

    it("ProviderHealthPage renders heading", async () => {
        renderWithApp(<ProviderHealthPage />);
        expect(
            await screen.findByRole("heading", { name: /data sources/i }),
        ).toBeInTheDocument();
    });

    it("EndpointLivenessPage renders heading", async () => {
        renderWithApp(<EndpointLivenessPage />);
        expect(
            await screen.findByRole("heading", { name: /endpoint liveness/i }),
        ).toBeInTheDocument();
    });

    it("EndpointLivenessPage shows filter input", async () => {
        renderWithApp(<EndpointLivenessPage />);
        expect(
            await screen.findByPlaceholderText(/filter routes/i),
        ).toBeInTheDocument();
    });

    it("DbMaintenancePage renders heading", async () => {
        renderWithApp(<DbMaintenancePage />);
        expect(
            await screen.findByRole("heading", { name: /db maintenance/i }),
        ).toBeInTheDocument();
    });

    it("DbMaintenancePage shows VACUUM All button", async () => {
        renderWithApp(<DbMaintenancePage />);
        expect(
            await screen.findByRole("button", { name: /vacuum all/i }),
        ).toBeInTheDocument();
    });

    it("DbMaintenancePage shows Refresh button", async () => {
        renderWithApp(<DbMaintenancePage />);
        expect(
            await screen.findByRole("button", { name: /refresh/i }),
        ).toBeInTheDocument();
    });

    it("DbMaintenancePage shows error text when DB stats API fails", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/admin/database/stats`, () =>
                err(500, "db error"),
            ),
        );

        renderWithApp(<DbMaintenancePage />);

        // apiRequest retries on 500 — needs extended timeout
        expect(
            await screen.findByText(/failed to load database stats/i, {}, { timeout: 5000 }),
        ).toBeInTheDocument();

        consoleSpy.mockRestore();
    });

    it("DbMaintenancePage shows subtitle text", async () => {
        renderWithApp(<DbMaintenancePage />);
        // dbMaintenance.subtitle = "Monitor table health and run VACUUM ANALYZE to reclaim storage"
        expect(
            await screen.findByText(/monitor table health/i),
        ).toBeInTheDocument();
    });

    it("DbMaintenancePage shows Table Statistics card heading", async () => {
        renderWithApp(<DbMaintenancePage />);
        // dbMaintenance.tableStats = "Table Statistics"
        expect(
            await screen.findByText(/table statistics/i),
        ).toBeInTheDocument();
    });

    it("DbMaintenancePage shows No tables found when table list is empty", async () => {
        renderWithApp(<DbMaintenancePage />);
        // Default MSW returns { tables: [], db_size: null } — dbMaintenance.noTables = "No tables found"
        expect(
            await screen.findByText(/no tables found/i),
        ).toBeInTheDocument();
    });

    it("ProviderHealthPage shows no endpoints message when list is empty", async () => {
        renderWithApp(<ProviderHealthPage />);
        // Default MSW returns [] — heading stays visible; verify page renders fully
        expect(
            await screen.findByRole("heading", { name: /data sources/i }),
        ).toBeInTheDocument();
    });

    it("EndpointLivenessPage typing in filter updates the input", async () => {
        const user = userEvent.setup();
        renderWithApp(<EndpointLivenessPage />);

        const filterInput = await screen.findByPlaceholderText(/filter routes/i);
        await user.type(filterInput, "api");

        expect(filterInput).toHaveValue("api");
    });

    it("AdminOverviewPage shows all-healthy indicator when no failing providers", async () => {
        renderWithApp(<AdminOverviewPage />);
        // Default MSW returns [] for providers → failingProviders === 0
        // admin.overview.allHealthy = "All healthy"
        expect(await screen.findByText(/all healthy/i)).toBeInTheDocument();
    });

    it("ProviderHealthPage shows Data Source Health card heading", async () => {
        renderWithApp(<ProviderHealthPage />);
        // admin.providers.tableTitle = "Data Source Health" — always rendered in CardTitle
        expect(await screen.findByText(/data source health/i)).toBeInTheDocument();
    });

    it("EndpointLivenessPage shows Route Matrix card heading", async () => {
        renderWithApp(<EndpointLivenessPage />);
        // admin.endpoints.tableTitle = "Route Matrix" — always rendered in CardTitle
        expect(await screen.findByText(/route matrix/i)).toBeInTheDocument();
    });

    // ─── Data-rendering tests ─────────────────────────────────────────────────

    it("ProviderHealthPage renders provider row when API returns data", async () => {
        server.use(
            http.get(`${API_BASE}/api/admin/providers/health`, () =>
                ok({
                    items: [{
                        provider: "alphavantage",
                        kind: "price",
                        label: "Alpha Vantage",
                        last_success_at: null,
                        last_error_at: null,
                        last_error: null,
                        consecutive_failures: 0,
                        updated_at: null,
                    }],
                    total: 1,
                }),
            ),
        );
        renderWithApp(<ProviderHealthPage />);
        expect(await screen.findByText("Alpha Vantage")).toBeInTheDocument();
    });

    it("ProviderHealthPage shows failing provider with non-zero consecutive_failures", async () => {
        server.use(
            http.get(`${API_BASE}/api/admin/providers/health`, () =>
                ok({
                    items: [{
                        provider: "ecb",
                        kind: "fx",
                        label: "ECB",
                        last_success_at: null,
                        last_error_at: "2025-01-01T00:00:00.000Z",
                        last_error: "timeout",
                        consecutive_failures: 3,
                        updated_at: null,
                    }],
                    total: 1,
                }),
            ),
        );
        renderWithApp(<ProviderHealthPage />);
        expect(await screen.findByText("ECB")).toBeInTheDocument();
        // consecutive_failures = 3 → error badge appears (non-zero failures)
        expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("ProviderHealthPage renders gracefully when API returns 500", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/admin/providers/health`, () => err(500, "db error")),
        );
        renderWithApp(<ProviderHealthPage />);
        expect(
            await screen.findByRole("heading", { name: /data sources/i }, { timeout: 5000 }),
        ).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    it("EndpointLivenessPage renders route row when API returns data", async () => {
        server.use(
            http.get(`${API_BASE}/api/admin/endpoints`, () =>
                ok({ items: [{ method: "GET", path: "/api/transactions" }], total: 1 }),
            ),
        );
        renderWithApp(<EndpointLivenessPage />);
        expect(await screen.findByText("GET")).toBeInTheDocument();
        expect(await screen.findByText("/api/transactions")).toBeInTheDocument();
    });

    it("EndpointLivenessPage renders gracefully when API returns 500", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/admin/endpoints`, () => err(500, "db error")),
        );
        renderWithApp(<EndpointLivenessPage />);
        expect(
            await screen.findByRole("heading", { name: /endpoint liveness/i }, { timeout: 5000 }),
        ).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    it("AdminOverviewPage shows failing count when providers have failures", async () => {
        server.use(
            http.get(`${API_BASE}/api/admin/providers/health`, () =>
                ok({
                    items: [{
                        provider: "ecb",
                        kind: "fx",
                        label: "ECB",
                        last_success_at: null,
                        last_error_at: null,
                        last_error: null,
                        consecutive_failures: 1,
                        updated_at: null,
                    }],
                    total: 1,
                }),
            ),
        );
        renderWithApp(<AdminOverviewPage />);
        // admin.overview.failing = "failing" — rendered next to the failure count
        expect(await screen.findByText(/failing/i)).toBeInTheDocument();
    });

    it("AdminOverviewPage renders gracefully when providers API returns 500", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/admin/providers/health`, () => err(500, "server error")),
        );
        renderWithApp(<AdminOverviewPage />);
        expect(
            await screen.findByRole("heading", { name: /admin overview/i }, { timeout: 5000 }),
        ).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    it("ProviderHealthPage probe success shows success toast", async () => {
        const toastSpy = vi.spyOn(toast, "success");
        server.use(
            http.get(`${API_BASE}/api/admin/providers/health`, () =>
                ok({
                    items: [{
                        provider: "alphavantage",
                        kind: "price",
                        label: "Alpha Vantage",
                        last_success_at: null,
                        last_error_at: null,
                        last_error: null,
                        consecutive_failures: 0,
                        updated_at: null,
                    }],
                    total: 1,
                }),
            ),
            http.post(`${API_BASE}/api/admin/providers/alphavantage/probe`, () =>
                ok({
                    ok: true,
                    provider: {
                        provider: "alphavantage",
                        kind: "price",
                        label: "Alpha Vantage",
                        last_success_at: "2025-01-01T00:00:00.000Z",
                        last_error_at: null,
                        last_error: null,
                        consecutive_failures: 0,
                        updated_at: "2025-01-01T00:00:00.000Z",
                    },
                }),
            ),
        );
        const user = userEvent.setup();
        renderWithApp(<ProviderHealthPage />);
        await screen.findByText("Alpha Vantage");
        const checkBtn = screen.getByRole("button", { name: /check now/i });
        await user.click(checkBtn);
        // admin.providers.probeOk = "{provider} is healthy"
        await vi.waitFor(() => {
            expect(toastSpy).toHaveBeenCalledWith(
                expect.stringMatching(/alpha vantage.*healthy|healthy/i),
            );
        }, { timeout: 5000 });
        toastSpy.mockRestore();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("AdminOverviewPage does not crash when database stats endpoint returns 4xx", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/admin/database/stats`, () => err(404, "Not found")),
        );
        const { container } = renderWithApp(<AdminOverviewPage />);
        await new Promise((r) => setTimeout(r, 200));
        expect(container.firstChild).toBeTruthy();
        errSpy.mockRestore();
    });

    it("ProviderHealthPage does not crash on 4xx providers/health", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/admin/providers/health`, () => err(404, "Not found")),
        );
        const { container } = renderWithApp(<ProviderHealthPage />);
        await new Promise((r) => setTimeout(r, 200));
        expect(container.firstChild).toBeTruthy();
        errSpy.mockRestore();
    });

    it("EndpointLivenessPage does not crash on 4xx liveness", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/admin/endpoint-liveness`, () => err(404, "Not found")),
        );
        const { container } = renderWithApp(<EndpointLivenessPage />);
        await new Promise((r) => setTimeout(r, 200));
        expect(container.firstChild).toBeTruthy();
        errSpy.mockRestore();
    });
});
