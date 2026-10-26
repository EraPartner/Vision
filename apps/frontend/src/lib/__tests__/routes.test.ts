// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ALL_NAV_ITEMS } from "@/lib/navigation";
import { appRouteManifest, legacyRouteRedirects } from "@/lib/routePreload";
import { isAppPath, LEGACY_ROUTES, ROUTES, type AppPath } from "@/lib/routes";

describe("route table", () => {
    it("is the router manifest's exact path set", () => {
        expect(appRouteManifest.map((r) => r.path).sort()).toEqual(
            Object.values(ROUTES).sort(),
        );
    });

    it("keeps every legacy redirect source in LEGACY_ROUTES", () => {
        expect(legacyRouteRedirects.map((r) => r.from).sort()).toEqual(
            Object.values(LEGACY_ROUTES).sort(),
        );
        for (const { to } of legacyRouteRedirects) {
            expect(isAppPath(to)).toBe(true);
        }
    });

    it("gives every navigation registry entry a real page route", () => {
        const patterns = new Set<string>(Object.values(ROUTES));
        for (const item of ALL_NAV_ITEMS) {
            expect(patterns.has(item.url), item.url).toBe(true);
        }
    });
});

describe("isAppPath", () => {
    it.each([
        "/",
        "/transactions",
        "/transactions?new=1",
        "/accounts/42",
        "/accounts/42?since=2025-01-01",
        "/import/7/review",
        "/portfolio/import/7/review",
        "/admin/db/some_table",
        "/research/market?symbol=AAPL#chart",
        "/portfolio/performance?period=1y",
    ])("accepts %s", (path) => {
        expect(isAppPath(path)).toBe(true);
    });

    it.each([
        "",
        "transactions",
        "//evil.example/transactions",
        "https://example.com/",
        "/acounts",
        "/accounts/1/2/3",
        "/import/7",
        "/removed-page",
        null,
        42,
    ])("rejects %s", (path) => {
        expect(isAppPath(path)).toBe(false);
    });

    it("narrows template paths at compile time", () => {
        const id = 5;
        const path: AppPath = `/accounts/${id}?since=2025-01-01`;
        expect(isAppPath(path)).toBe(true);
        // @ts-expect-error a misspelled route is not an AppPath
        const typo: AppPath = "/acounts";
        expect(isAppPath(typo)).toBe(false);
    });
});
