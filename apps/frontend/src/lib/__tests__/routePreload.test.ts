// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { matchRoutes } from "react-router";
import {
    appRouteManifest,
    routeLoaders,
    preloadRoute,
} from "@/lib/routePreload";

const EXPECTED_PATHS = [
    "/",
    "/transactions",
    "/categories",
    "/accounts",
    "/accounts/:id",
    "/recipients",
    "/planned",
    "/statistics",
    "/import",
    "/import/:batchId/review",
    "/owes",
    "/tax",
    "/admin",
    "/admin/db",
    "/admin/db/:table",
    "/admin/providers",
    "/admin/endpoints",
    "/admin/exchange-rates",
    "/portfolio",
    "/portfolio/stocks",
    "/portfolio/crypto",
    "/portfolio/metals",
    "/portfolio/real-estate",
    "/portfolio/savings",
    "/portfolio/performance",
    "/portfolio/net-worth",
    "/portfolio/import",
    "/portfolio/import/:batchId/review",
    "/portfolio/tax",
    "/portfolio/rebalance",
    "/research",
    "/research/markets",
    "/research/market",
    "/research/watchlist",
    "/research/compare",
    "/research/forecast",
    "/research/charts",
    "/ai-chat",
] as const;

const ADMIN_PATHS = [
    "/admin",
    "/admin/db",
    "/admin/db/:table",
    "/admin/providers",
    "/admin/endpoints",
    "/admin/exchange-rates",
] as const;

describe("routeLoaders map", () => {
    it("derives every unique loader from the ordered route manifest", () => {
        expect(appRouteManifest.map(({ path }) => path)).toEqual(
            EXPECTED_PATHS,
        );
        expect(new Set(EXPECTED_PATHS).size).toBe(EXPECTED_PATHS.length);
        expect(new Set(appRouteManifest.map(({ loader }) => loader)).size).toBe(
            appRouteManifest.length,
        );
        for (const { path, loader } of appRouteManifest) {
            expect(routeLoaders[path]).toBe(loader);
        }
    });

    it("pins the exact routes protected by the admin gate", () => {
        expect(
            appRouteManifest
                .filter(({ admin }) => admin)
                .map(({ path }) => path),
        ).toEqual(ADMIN_PATHS);
    });

    it.each([
        ["/accounts/42", "/accounts/:id", false],
        ["/import/abc/review", "/import/:batchId/review", false],
        ["/admin/db/transactions", "/admin/db/:table", true],
        [
            "/portfolio/import/abc/review",
            "/portfolio/import/:batchId/review",
            false,
        ],
        ["/research/charts", "/research/charts", false],
    ])("matches deep link %s to %s", (url, expectedPath, expectedAdmin) => {
        const matches = matchRoutes(appRouteManifest, url);
        expect(matches?.at(-1)?.route.path).toBe(expectedPath);
        expect(matches?.at(-1)?.route.admin).toBe(expectedAdmin);
    });

    it("exposes loader functions keyed by route path", () => {
        expect(typeof routeLoaders["/"]).toBe("function");
        expect(typeof routeLoaders["/transactions"]).toBe("function");
        expect(typeof routeLoaders["/portfolio/net-worth"]).toBe("function");
        // Every entry is a callable lazy importer.
        for (const loader of Object.values(routeLoaders)) {
            expect(typeof loader).toBe("function");
        }
    });
});

describe("preloadRoute", () => {
    it("is a no-op for an unknown route", () => {
        // No loader exists, so nothing is invoked and no error is thrown.
        expect(() => preloadRoute("/does-not-exist")).not.toThrow();
    });

    it("warms a known chunk only once (dedup on repeated calls)", async () => {
        const importSpy = vi.fn(() => Promise.resolve({}));
        // Replace one loader with a spy to observe the warm-once behaviour without
        // pulling a real page chunk into the test bundle.
        const original = routeLoaders["/owes"];
        (routeLoaders as Record<string, () => Promise<unknown>>)["/owes"] =
            importSpy;
        try {
            preloadRoute("/owes");
            preloadRoute("/owes");
            await Promise.resolve();
            expect(importSpy).toHaveBeenCalledTimes(1);
        } finally {
            (routeLoaders as Record<string, () => Promise<unknown>>)["/owes"] =
                original;
        }
    });

    it("allows a failed preload to retry", async () => {
        const importSpy = vi
            .fn<(typeof routeLoaders)[string]>()
            .mockRejectedValueOnce(new Error("network"))
            .mockResolvedValueOnce({ default: () => null });
        const original = routeLoaders["/tax"];
        routeLoaders["/tax"] = importSpy;
        try {
            preloadRoute("/tax");
            await Promise.resolve();
            await Promise.resolve();
            preloadRoute("/tax");
            await Promise.resolve();
            expect(importSpy).toHaveBeenCalledTimes(2);
        } finally {
            routeLoaders["/tax"] = original;
        }
    });
});
