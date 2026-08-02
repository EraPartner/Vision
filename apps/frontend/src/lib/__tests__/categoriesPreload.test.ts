import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { http } from "msw";

import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import {
    CATEGORY_FETCH_LIMIT,
    fetchCategoriesForExclusions,
    resetCategoriesPreloadForTests,
    startCategoriesPreload,
    takeStartedCategoriesPreload,
} from "@/lib/categoriesPreload";

const API_BASE = "http://localhost:3002";

function categoriesPage(items: unknown[], total = items.length) {
    return ok({ items, total, limit: CATEGORY_FETCH_LIMIT, offset: 0, links: [] });
}

function category(id: number, isActive: boolean) {
    return {
        id,
        general: "FOOD",
        detail: `D${id}`,
        is_active: isActive,
        created_at: "2025-01-01T00:00:00.000Z",
        links: [],
    };
}

afterEach(() => {
    resetCategoriesPreloadForTests();
    vi.restoreAllMocks();
});

describe("categories boot preload", () => {
    it("issues exactly one request no matter how often it is started", async () => {
        let requests = 0;
        server.use(
            http.get(`${API_BASE}/api/categories`, () => {
                requests += 1;
                return categoriesPage([category(1, true)]);
            }),
        );

        const first = startCategoriesPreload();
        expect(startCategoriesPreload()).toBe(first);
        await first;

        expect(requests).toBe(1);
    });

    it("hands the boot response to the first taker and nothing to the next", async () => {
        server.use(
            http.get(`${API_BASE}/api/categories`, () =>
                categoriesPage([category(7, false)]),
            ),
        );

        startCategoriesPreload();
        const taken = await takeStartedCategoriesPreload();
        expect(taken?.map((c) => c.id)).toEqual([7]);

        // Consumed. A later refetch must go to the network rather than replay a
        // boot-time snapshot that a category mutation may since have invalidated.
        expect(await takeStartedCategoriesPreload()).toBeNull();
    });

    it("returns null (not a rejection) when the boot fetch fails", async () => {
        server.use(
            http.get(`${API_BASE}/api/categories`, () =>
                new Response("boom", { status: 500 }),
            ),
        );

        const promise = startCategoriesPreload();
        // Never rejects: nothing is attached at module scope, and when
        // excludeHiddenCategories is off nobody ever takes it.
        await expect(promise).resolves.toEqual({ ok: false });
        expect(await takeStartedCategoriesPreload()).toBeNull();
    });

    it("warns instead of silently truncating when the fetch cap is hit", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/categories`, () =>
                categoriesPage(
                    Array.from({ length: CATEGORY_FETCH_LIMIT }, (_, i) => category(i + 1, true)),
                    CATEGORY_FETCH_LIMIT + 5,
                ),
            ),
        );

        await fetchCategoriesForExclusions();

        expect(warn).toHaveBeenCalledWith(expect.stringContaining("fetch cap"));
    });

    it("is kicked off from module scope in main.tsx, before React mounts", () => {
        // The whole point of the preload: started while the boot graph is still
        // executing. If this moves into a component/effect the request goes back
        // to queueing *after* mount and the aggregation hop re-serializes behind
        // it — exactly the regression this guards.
        const mainSrc = readFileSync(
            fileURLToPath(new URL("../../main.tsx", import.meta.url)),
            "utf8",
        );

        const kickoff = mainSrc.indexOf("startCategoriesPreload()");
        const mount = mainSrc.indexOf("createRoot(");
        expect(kickoff).toBeGreaterThan(-1);
        expect(mount).toBeGreaterThan(-1);
        expect(kickoff).toBeLessThan(mount);
    });
});
