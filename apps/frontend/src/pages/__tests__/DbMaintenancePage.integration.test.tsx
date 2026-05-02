// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, ok } from "@/test/msw/handlers";
import DbMaintenancePage from "@/pages/DbMaintenancePage";

const API_BASE = "http://localhost:3002";

const emptyStats = { tables: [], db_size: null };
const statsWithTable = {
    db_size: "14 MB",
    tables: [
        {
            schemaname: "public",
            table_name: "transactions",
            live_rows: "1234",
            dead_rows: "5",
            last_autovacuum: "2025-01-01T00:00:00.000Z",
            last_autoanalyze: "2025-01-01T00:00:00.000Z",
            size: "4096 kB",
            size_bytes: "4194304",
        },
    ],
};

describe("DbMaintenancePage (integration)", () => {
    it("renders page heading", async () => {
        server.use(http.get(`${API_BASE}/api/admin/database/stats`, () => ok(emptyStats)));
        renderWithApp(<DbMaintenancePage />);
        // dbMaintenance.title = "DB Maintenance"
        expect(
            await screen.findByRole("heading", { name: /db maintenance/i }),
        ).toBeInTheDocument();
    });

    it("renders without crashing when table list is empty", async () => {
        server.use(http.get(`${API_BASE}/api/admin/database/stats`, () => ok(emptyStats)));
        renderWithApp(<DbMaintenancePage />);
        await screen.findByRole("heading", { name: /db maintenance/i });
    });

    it("shows Refresh button", async () => {
        server.use(http.get(`${API_BASE}/api/admin/database/stats`, () => ok(emptyStats)));
        renderWithApp(<DbMaintenancePage />);
        // dbMaintenance.refresh = "Refresh"
        expect(
            await screen.findByRole("button", { name: /refresh/i }),
        ).toBeInTheDocument();
    });

    it("shows VACUUM All button", async () => {
        server.use(http.get(`${API_BASE}/api/admin/database/stats`, () => ok(emptyStats)));
        renderWithApp(<DbMaintenancePage />);
        // dbMaintenance.vacuumAll = "VACUUM All"
        expect(
            await screen.findByRole("button", { name: /vacuum all/i }),
        ).toBeInTheDocument();
    });

    it("shows error state when stats API fails", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/admin/database/stats`, () => err(500, "db unavailable")),
        );
        renderWithApp(<DbMaintenancePage />);
        // dbMaintenance.loadError = "Failed to load database stats"
        expect(
            await screen.findByText(/failed to load database stats/i, {}, { timeout: 5000 }),
        ).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    it("shows empty tables message when no tables exist", async () => {
        server.use(http.get(`${API_BASE}/api/admin/database/stats`, () => ok(emptyStats)));
        renderWithApp(<DbMaintenancePage />);
        // dbMaintenance.noTables = "No tables found"
        expect(
            await screen.findByText(/no tables found/i),
        ).toBeInTheDocument();
    });

    it("shows Table Statistics section heading", async () => {
        server.use(http.get(`${API_BASE}/api/admin/database/stats`, () => ok(emptyStats)));
        renderWithApp(<DbMaintenancePage />);
        // dbMaintenance.tableStats = "Table Statistics"
        expect(
            await screen.findByText(/table statistics/i),
        ).toBeInTheDocument();
    });

    it("shows db_size stat card when data loads", async () => {
        server.use(http.get(`${API_BASE}/api/admin/database/stats`, () => ok(statsWithTable)));
        renderWithApp(<DbMaintenancePage />);
        // The db_size value "14 MB" appears in the Total DB Size card
        expect(await screen.findByText("14 MB")).toBeInTheDocument();
    });

    it("shows table row with VACUUM button when tables exist", async () => {
        server.use(http.get(`${API_BASE}/api/admin/database/stats`, () => ok(statsWithTable)));
        renderWithApp(<DbMaintenancePage />);
        // Table name appears
        expect(await screen.findByText("transactions")).toBeInTheDocument();
        // Each row has a VACUUM button (dbMaintenance.vacuumTable = "VACUUM")
        const vacuumBtns = await screen.findAllByRole("button", { name: /^vacuum$/i });
        expect(vacuumBtns.length).toBeGreaterThan(0);
    });

    it("calls vacuum API when VACUUM All button is clicked", async () => {
        const user = userEvent.setup();
        let vacuumCalled = false;

        server.use(
            http.get(`${API_BASE}/api/admin/database/stats`, () => ok(emptyStats)),
            http.post(`${API_BASE}/api/admin/database/vacuum`, () => {
                vacuumCalled = true;
                return ok({ vacuumed: "all" });
            }),
        );

        renderWithApp(<DbMaintenancePage />);
        const vacuumAllBtn = await screen.findByRole("button", { name: /vacuum all/i });
        await user.click(vacuumAllBtn);

        expect(vacuumCalled).toBe(true);
    });

    it("calls vacuum API when per-row VACUUM button is clicked", async () => {
        const user = userEvent.setup();
        let vacuumedTable: string | null = null;

        server.use(
            http.get(`${API_BASE}/api/admin/database/stats`, () => ok(statsWithTable)),
            http.post(`${API_BASE}/api/admin/database/vacuum`, async ({ request }) => {
                const body = await request.json() as { table: string };
                vacuumedTable = body.table;
                return ok({ vacuumed: body.table });
            }),
        );

        renderWithApp(<DbMaintenancePage />);
        // Wait for row to appear
        await screen.findByText("transactions");
        const [rowVacuumBtn] = await screen.findAllByRole("button", { name: /^vacuum$/i });
        await user.click(rowVacuumBtn);

        expect(vacuumedTable).toBe("transactions");
    });

    it("shows Tables count stat card", async () => {
        server.use(http.get(`${API_BASE}/api/admin/database/stats`, () => ok(statsWithTable)));
        renderWithApp(<DbMaintenancePage />);
        // dbMaintenance.tableCount = "Tables"
        expect(await screen.findByText(/^tables$/i)).toBeInTheDocument();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("does not crash when stats endpoint returns 404", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/admin/database/stats`, () => err(404, "Not found")),
        );
        const { container } = renderWithApp(<DbMaintenancePage />);
        await new Promise((r) => setTimeout(r, 200));
        expect(container.firstChild).toBeTruthy();
        errSpy.mockRestore();
    });
});
