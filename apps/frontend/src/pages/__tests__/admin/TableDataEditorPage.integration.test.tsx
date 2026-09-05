// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Routes, Route } from "react-router";
import { screen, waitFor, within } from "@testing-library/react";
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
        {
            name: "id",
            dataType: "integer",
            udtName: "int4",
            nullable: false,
            hasDefault: true,
            generated: false,
            writable: true,
        },
        {
            name: "amount",
            dataType: "numeric",
            udtName: "numeric",
            nullable: false,
            hasDefault: false,
            generated: false,
            writable: true,
        },
        {
            name: "currency",
            dataType: "text",
            udtName: "text",
            nullable: false,
            hasDefault: false,
            generated: false,
            writable: true,
        },
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
        server.use(
            http.get(
                `${API_BASE}/api/admin/database/tables/transactions/rows`,
                () => ok(rowsResponse),
            ),
        );
        renderEditor();
        expect(
            await screen.findByRole("heading", { name: "transactions" }),
        ).toBeInTheDocument();
        expect(await screen.findByText("EUR")).toBeInTheDocument();
        expect(await screen.findByText("USD")).toBeInTheDocument();
    });

    it("shows the bypass-validation caution banner", async () => {
        server.use(
            http.get(
                `${API_BASE}/api/admin/database/tables/transactions/rows`,
                () => ok(rowsResponse),
            ),
        );
        renderEditor();
        expect(
            await screen.findByText(/bypass the app's validation/i),
        ).toBeInTheDocument();
    });

    it("adds a row and previews the generated SQL before commit", async () => {
        let previewBody: unknown = null;
        server.use(
            http.get(
                `${API_BASE}/api/admin/database/tables/transactions/rows`,
                () => ok(rowsResponse),
            ),
            http.post(
                `${API_BASE}/api/admin/database/tables/transactions/mutate`,
                async ({ request }) => {
                    previewBody = await request.json();
                    return ok({
                        dryRun: true,
                        count: 1,
                        statements: [
                            {
                                op: "insert",
                                preview:
                                    'INSERT INTO "transactions" ("currency") VALUES (\'GBP\') RETURNING *',
                            },
                        ],
                    });
                },
            ),
        );

        const user = userEvent.setup();
        renderEditor();
        await screen.findByText("EUR");

        await user.click(
            await screen.findByRole("button", { name: /add row/i }),
        );
        expect(
            await screen.findByText(/1 pending change/i),
        ).toBeInTheDocument();

        await user.click(
            await screen.findByRole("button", { name: /preview sql/i }),
        );

        // Dialog shows the exact statement returned by the dry-run.
        expect(
            await screen.findByText(/review pending changes/i),
        ).toBeInTheDocument();
        expect(await screen.findByText(/INSERT INTO/)).toBeInTheDocument();
        expect((previewBody as { dryRun: boolean }).dryRun).toBe(true);
    });

    it("commits a previewed edit, clears it, and refetches rows", async () => {
        let committed = false;
        let rowGets = 0;
        const mutationBodies: Array<Record<string, unknown>> = [];
        server.use(
            http.get(
                `${API_BASE}/api/admin/database/tables/transactions/rows`,
                () => {
                    rowGets += 1;
                    return ok({
                        ...rowsResponse,
                        rows: committed
                            ? [
                                  { ...rowsResponse.rows[0], amount: "20.00" },
                                  rowsResponse.rows[1],
                              ]
                            : rowsResponse.rows,
                    });
                },
            ),
            http.post(
                `${API_BASE}/api/admin/database/tables/transactions/mutate`,
                async ({ request }) => {
                    const body = (await request.json()) as Record<
                        string,
                        unknown
                    >;
                    mutationBodies.push(body);
                    if (body.dryRun === true) {
                        return ok({
                            dryRun: true,
                            count: 1,
                            statements: [
                                {
                                    op: "update",
                                    preview: "UPDATE transactions ...",
                                },
                            ],
                        });
                    }
                    committed = true;
                    return ok({
                        dryRun: false,
                        applied: 1,
                        results: [{ op: "update" }],
                        refreshScheduled: false,
                    });
                },
            ),
        );

        const user = userEvent.setup();
        renderEditor();
        await user.click(await screen.findByText("12.50"));
        const amountInput = screen.getByDisplayValue("12.50");
        await user.clear(amountInput);
        await user.type(amountInput, "20{Enter}");
        await user.click(screen.getByRole("button", { name: /preview sql/i }));
        await user.click(
            await screen.findByRole("button", { name: /commit to database/i }),
        );

        expect(mutationBodies[0]).toMatchObject({
            dryRun: true,
            changes: [
                {
                    op: "update",
                    pk: { id: 1 },
                    xmin: "500",
                    set: { amount: "20" },
                },
            ],
        });
        expect(mutationBodies[1].dryRun ?? false).toBe(false);
        expect(mutationBodies[1].changes).toEqual(mutationBodies[0].changes);
        await waitFor(() => expect(rowGets).toBeGreaterThan(1));
        expect(await screen.findByText("20.00")).toBeInTheDocument();
        expect(screen.queryByText(/pending change/i)).not.toBeInTheDocument();
        expect(
            screen.queryByRole("heading", { name: /review pending changes/i }),
        ).not.toBeInTheDocument();
    });

    it("reverts one staged existing-cell edit with its undo control and preserves the other", async () => {
        let previewBody: unknown = null;
        server.use(
            http.get(
                `${API_BASE}/api/admin/database/tables/transactions/rows`,
                () => ok(rowsResponse),
            ),
            http.post(
                `${API_BASE}/api/admin/database/tables/transactions/mutate`,
                async ({ request }) => {
                    previewBody = await request.json();
                    return ok({ dryRun: true, count: 1, statements: [] });
                },
            ),
        );

        const user = userEvent.setup();
        renderEditor();
        await screen.findByText("EUR");

        await user.click(screen.getByText("12.50"));
        const amountInput = screen.getByDisplayValue("12.50");
        await user.clear(amountInput);
        await user.type(amountInput, "20{Enter}");

        await user.click(screen.getByText("USD"));
        const currencyInput = screen.getByDisplayValue("USD");
        await user.clear(currencyInput);
        await user.type(currencyInput, "CAD{Enter}");
        expect(
            await screen.findByText(/2 pending change/i),
        ).toBeInTheDocument();

        const editedAmountRow = screen.getByText("20").closest("tr");
        expect(editedAmountRow).not.toBeNull();
        await user.click(
            within(editedAmountRow as HTMLElement).getByRole("button", {
                name: /revert cell change/i,
            }),
        );
        expect(await screen.findByText("12.50")).toBeInTheDocument();
        expect(screen.getByText(/1 pending change/i)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /preview sql/i }));
        await screen.findByText(/review pending changes/i);
        expect(previewBody).toMatchObject({
            dryRun: true,
            changes: [
                {
                    op: "update",
                    pk: { id: 2 },
                    xmin: "501",
                    set: { currency: "CAD" },
                },
            ],
        });
    });

    it("reverts a staged value in a new row without discarding the row", async () => {
        let previewBody: unknown = null;
        server.use(
            http.get(
                `${API_BASE}/api/admin/database/tables/transactions/rows`,
                () => ok(rowsResponse),
            ),
            http.post(
                `${API_BASE}/api/admin/database/tables/transactions/mutate`,
                async ({ request }) => {
                    previewBody = await request.json();
                    return ok({ dryRun: true, count: 1, statements: [] });
                },
            ),
        );

        const user = userEvent.setup();
        renderEditor();
        await screen.findByText("EUR");
        await user.click(screen.getByRole("button", { name: /add row/i }));

        const newRow = screen
            .getByRole("button", { name: /discard new row/i })
            .closest("tr");
        expect(newRow).not.toBeNull();
        const currencyCell = within(newRow as HTMLElement).getAllByRole(
            "cell",
        )[3];
        await user.click(currencyCell);
        await user.type(
            within(newRow as HTMLElement).getByRole("textbox"),
            "GBP{Enter}",
        );
        await user.click(within(newRow as HTMLElement).getByText("GBP"));
        await user.keyboard("{Escape}");

        expect(
            within(newRow as HTMLElement).getAllByText("NULL"),
        ).not.toHaveLength(0);
        expect(screen.getByText(/1 pending change/i)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /preview sql/i }));
        await screen.findByText(/review pending changes/i);
        expect(previewBody).toMatchObject({
            dryRun: true,
            changes: [{ op: "insert", values: {} }],
        });
    });

    it("renders a read-only notice path for a table with no primary key", async () => {
        server.use(
            http.get(`${API_BASE}/api/admin/database/tables/kv/rows`, () =>
                ok({
                    ...rowsResponse,
                    table: "kv",
                    primaryKey: [],
                    rows: [],
                    total: 0,
                }),
            ),
        );
        renderWithApp(
            <Routes>
                <Route
                    path="/admin/db/:table"
                    element={<TableDataEditorPage />}
                />
            </Routes>,
            { initialEntries: ["/admin/db/kv"] },
        );
        // A mutation cannot be staged while metadata is loading or after the
        // response confirms that the table has no primary key.
        const addBtn = screen.getByRole("button", { name: /add row/i });
        expect(addBtn).toBeDisabled();
        await screen.findByText(/no rows/i);
        expect(addBtn).toBeDisabled();
    });
});
