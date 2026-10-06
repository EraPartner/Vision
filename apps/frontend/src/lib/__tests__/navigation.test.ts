import { Briefcase, Import } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
    ADMIN_SECTION,
    ALL_NAV_ITEMS,
    GO_TO_ROUTES,
    NAV_SECTIONS,
    PALETTE_SECTIONS,
    SECTION_CYCLE,
    SECTION_ID_BY_URL,
    isActiveNavItem,
    matchNavSectionId,
    matchNavTitleKey,
} from "@/lib/navigation";
import { appRouteManifest } from "@/lib/routePreload";

// Parity guard for the sections sidebar (ADR-180): every page a user could
// open from the old workspace sidebars must still have a sidebar entry.

const navUrls = new Set(ALL_NAV_ITEMS.map((item) => item.url));

describe("navigation registry", () => {
    it("lists every parameterless page route exactly once", () => {
        const pageRoutes = appRouteManifest
            .map((route) => route.path)
            .filter((path) => !path.includes(":"));
        for (const path of pageRoutes) {
            expect(navUrls.has(path), `${path} has no sidebar entry`).toBe(
                true,
            );
        }
        expect(ALL_NAV_ITEMS.length).toBe(navUrls.size);
    });

    it("keeps admin pages in the admin section only", () => {
        const adminRoutes = appRouteManifest
            .filter((route) => route.admin && !route.path.includes(":"))
            .map((route) => route.path);
        const adminUrls = new Set(ADMIN_SECTION.items.map((i) => i.url));
        expect([...adminUrls].sort()).toEqual(adminRoutes.sort());
        for (const section of NAV_SECTIONS) {
            for (const item of section.items) {
                expect(adminUrls.has(item.url)).toBe(false);
            }
        }
    });

    it("offers every non-admin page in the command palette", () => {
        const paletteUrls = new Set(
            PALETTE_SECTIONS.flatMap((s) => s.pages.map((p) => p.url)),
        );
        for (const item of ALL_NAV_ITEMS) {
            if (SECTION_ID_BY_URL.get(item.url) === ADMIN_SECTION.id) continue;
            expect(paletteUrls.has(item.url), item.url).toBe(true);
        }
    });

    it("uses each go-to key once and reaches the section roots", () => {
        const keys = GO_TO_ROUTES.map((r) => r.key);
        expect(new Set(keys).size).toBe(keys.length);
        expect(GO_TO_ROUTES.find((r) => r.url === "/")?.key).toBe("h");
        for (const root of SECTION_CYCLE) {
            expect(navUrls.has(root.url)).toBe(true);
        }
    });

    it("distinguishes the budgeting and portfolio importers by icon", () => {
        const budgetingImport = ALL_NAV_ITEMS.find((i) => i.url === "/import");
        const portfolioImport = ALL_NAV_ITEMS.find(
            (i) => i.url === "/portfolio/import",
        );
        expect(budgetingImport?.icon).toBe(Import);
        expect(portfolioImport?.icon).toBe(Briefcase);
    });

    it("hides only Research by default", () => {
        expect(
            NAV_SECTIONS.filter((s) => s.defaultHidden).map((s) => s.id),
        ).toEqual(["research"]);
        expect(NAV_SECTIONS.filter((s) => !s.collapsible).map((s) => s.id)).toEqual(
            ["top"],
        );
    });

    it("lights up the owning item for child routes without prefix bleed", () => {
        const importItem = ALL_NAV_ITEMS.find((i) => i.url === "/import")!;
        const marketItem = ALL_NAV_ITEMS.find(
            (i) => i.url === "/research/market",
        )!;
        const homeItem = ALL_NAV_ITEMS.find((i) => i.url === "/")!;
        expect(isActiveNavItem(importItem, "/import/42/review")).toBe(true);
        expect(isActiveNavItem(marketItem, "/research/markets")).toBe(false);
        expect(isActiveNavItem(homeItem, "/transactions")).toBe(false);
        expect(matchNavTitleKey("/portfolio/import/7/review")).toBe(
            "nav.portfolioImport",
        );
        expect(matchNavSectionId("/portfolio/stocks")).toBe("wealth");
        expect(matchNavSectionId("/admin/db/accounts")).toBe("admin");
        expect(matchNavSectionId("/nowhere")).toBeUndefined();
    });
});
