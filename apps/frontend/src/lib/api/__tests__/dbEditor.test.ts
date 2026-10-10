// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";

import {
    getTableSchema,
    getTableRows,
    previewTableMutation,
    commitTableMutation,
} from "@/lib/api/dbEditor";

const API_BASE = "http://localhost:3002";

function ok<T>(data: T) {
    return HttpResponse.json({ ok: true, data });
}

afterEach(() => server.resetHandlers());

/** `getTableMeta` for a one-column table. */
const TABLE_META = {
    table: "transactions",
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
    ],
    primaryKey: ["id"],
};

/** A last `readRows` page: `total` is only set on an unpaged first page. */
const ROWS_PAGE = {
    ...TABLE_META,
    rows: [],
    total: 0,
    limit: 100,
    hasMore: false,
    nextCursor: null,
};

describe("dbEditor API client", () => {
    it("getTableSchema fetches the schema for a (URL-encoded) table name", async () => {
        let url = "";
        server.use(
            http.get(
                `${API_BASE}/api/admin/database/tables/:table/schema`,
                ({ request }) => {
                    url = request.url;
                    return ok(TABLE_META);
                },
            ),
        );
        await getTableSchema("my table");
        expect(url).toContain("my%20table");
    });

    it("getTableRows builds the full query string when all params are set", async () => {
        let url = "";
        server.use(
            http.get(
                `${API_BASE}/api/admin/database/tables/:table/rows`,
                ({ request }) => {
                    url = request.url;
                    return ok({ ...ROWS_PAGE, total: undefined, limit: 50 });
                },
            ),
        );
        await getTableRows("transactions", {
            limit: 50,
            cursor: "opaque-token",
            orderBy: "id",
            dir: "desc",
            filters: [{ col: "x", op: "=", val: 1 }] as never,
        });
        const p = new URL(url).searchParams;
        expect(p.get("limit")).toBe("50");
        expect(p.get("cursor")).toBe("opaque-token");
        expect(p.get("orderBy")).toBe("id");
        expect(p.get("dir")).toBe("desc");
        // The raw `where` param was removed (SQLi oracle) — never sent.
        expect(p.get("where")).toBeNull();
        expect(JSON.parse(p.get("filters")!)).toEqual([
            { col: "x", op: "=", val: 1 },
        ]);
    });

    it("getTableRows omits the query string when called with no params (false-branch side)", async () => {
        let url = "";
        server.use(
            http.get(
                `${API_BASE}/api/admin/database/tables/:table/rows`,
                ({ request }) => {
                    url = request.url;
                    return ok(ROWS_PAGE);
                },
            ),
        );
        await getTableRows("transactions");
        expect(url.endsWith("/rows")).toBe(true);
    });

    it("getTableRows omits empty filters array", async () => {
        let url = "";
        server.use(
            http.get(
                `${API_BASE}/api/admin/database/tables/:table/rows`,
                ({ request }) => {
                    url = request.url;
                    return ok(ROWS_PAGE);
                },
            ),
        );
        await getTableRows("transactions", { filters: [] });
        expect(url).not.toContain("filters");
    });

    it("previewTableMutation posts changes with dryRun=true", async () => {
        let body: unknown = null;
        server.use(
            http.post(
                `${API_BASE}/api/admin/database/tables/:table/mutate`,
                async ({ request }) => {
                    body = await request.json();
                    return ok({ dryRun: true, count: 1, statements: [] });
                },
            ),
        );
        await previewTableMutation("transactions", [
            { kind: "update" },
        ] as never);
        expect(body).toMatchObject({
            dryRun: true,
            changes: [{ kind: "update" }],
        });
    });

    it("commitTableMutation posts changes without dryRun", async () => {
        let body: Record<string, unknown> = {};
        server.use(
            http.post(
                `${API_BASE}/api/admin/database/tables/:table/mutate`,
                async ({ request }) => {
                    body = (await request.json()) as Record<string, unknown>;
                    return ok({
                        dryRun: false,
                        applied: 1,
                        results: [{ op: "delete" }],
                        refreshScheduled: false,
                    });
                },
            ),
        );
        await commitTableMutation("transactions", [
            { kind: "delete" },
        ] as never);
        expect(body.changes).toEqual([{ kind: "delete" }]);
        expect("dryRun" in body).toBe(false);
    });

    it("getTableRows rejects a page without its cursor fields", async () => {
        server.use(
            http.get(`${API_BASE}/api/admin/database/tables/:table/rows`, () =>
                ok({ ...TABLE_META, rows: [], limit: 100 }),
            ),
        );
        await expect(getTableRows("transactions")).rejects.toMatchObject({
            name: "ApiContractError",
            endpoint: "GET /api/admin/database/tables/transactions/rows",
        });
    });
});
