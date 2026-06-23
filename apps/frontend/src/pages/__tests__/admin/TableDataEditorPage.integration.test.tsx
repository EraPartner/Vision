// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Routes, Route } from "react-router-dom";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import TableDataEditorPage from "@/pages/admin/TableDataEditorPage";

const API_BASE = "http://localhost:3002";

const rowsResponse = {
    table: "transactions",
    primaryKey: ["id"],
    columns: [
        { name: "id", dataType: "integer", udtName: "int4", nullable: false, hasDefault: true, generated: false, writable: true },
        { name: "amount", dataType: "numeric", udtName: "numeric", nullable: false, hasDefault: false, generated: false, writable: true },
        { name: "currency", dataType: "text", udtName: "text", nullable: false, hasDefault: false, generated: false, writable: true },
    ],
    rows: [
        { id: 1, amount: "12.50", currency: "EUR", __xmin: "500" },
        { id: 2, amount: "-3.00", currency: "USD", __xmin: "501" },
    ],
    total: 2,
    limit: 100,
    offset: 0,
};

function renderEditor() {
    return renderWithApp(
        <Routes>
            <Route path="/admin/db/:table" element={<TableDataEditorPage />} />
        </Routes>,
        { initialEntries: ["/admin/db/transactions"] },
    );
}

describe("TableDataEditorPage (integration)", () => {
    it("renders the table name and row data", async () => {
        server.use(http.get(`${API_BASE}/api/admin/database/tables/transactions/rows`, () => ok(rowsResponse)));
        renderEditor();
        expect(await screen.findByRole("heading", { name: "transactions" })).toBeInTheDocument();
        expect(await screen.findByText("EUR")).toBeInTheDocument();
        expect(await screen.findByText("USD")).toBeInTheDocument();
    });

    it("shows the bypass-validation caution banner", async () => {
        server.use(http.get(`${API_BASE}/api/admin/database/tables/transactions/rows`, () => ok(rowsResponse)));
        renderEditor();
        expect(await screen.findByText(/bypass the app's validation/i)).toBeInTheDocument();
    });

    it("adds a row and previews the generated SQL before commit", async () => {
        let previewBody: unknown = null;
        server.use(
            http.get(`${API_BASE}/api/admin/database/tables/transactions/rows`, () => ok(rowsResponse)),
            http.post(`${API_BASE}/api/admin/database/tables/transactions/mutate`, async ({ request }) => {
                previewBody = await request.json();
                return ok({
                    dryRun: true,
                    count: 1,
                    statements: [{ op: "insert", preview: "INSERT INTO \"transactions\" (\"currency\") VALUES ('GBP') RETURNING *" }],
                });
            }),
        );

        const user = userEvent.setup();
        renderEditor();
        await screen.findByText("EUR");

        await user.click(await screen.findByRole("button", { name: /add row/i }));
        expect(await screen.findByText(/1 pending change/i)).toBeInTheDocument();

        await user.click(await screen.findByRole("button", { name: /preview sql/i }));

        // Dialog shows the exact statement returned by the dry-run.
        expect(await screen.findByText(/review pending changes/i)).toBeInTheDocument();
        expect(await screen.findByText(/INSERT INTO/)).toBeInTheDocument();
        expect((previewBody as { dryRun: boolean }).dryRun).toBe(true);
    });

    it("renders a read-only notice path for a table with no primary key", async () => {
        server.use(http.get(`${API_BASE}/api/admin/database/tables/kv/rows`, () => ok({
            ...rowsResponse,
            table: "kv",
            primaryKey: [],
            rows: [],
            total: 0,
        })));
        renderWithApp(
            <Routes>
                <Route path="/admin/db/:table" element={<TableDataEditorPage />} />
            </Routes>,
            { initialEntries: ["/admin/db/kv"] },
        );
        // Add row is disabled when there is no primary key.
        const addBtn = await screen.findByRole("button", { name: /add row/i });
        expect(addBtn).toBeDisabled();
    });
});
