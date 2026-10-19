import { describe, expect, it } from "vitest";
import { ALL_NAV_ITEMS } from "@/lib/navigation";
import { PAGE_ICONS } from "@/lib/pageIcons";

describe("page icon identity", () => {
    it("keeps every navigable destination on the canonical icon registry", () => {
        expect(ALL_NAV_ITEMS.map((item) => item.url).sort()).toEqual(
            Object.keys(PAGE_ICONS).sort(),
        );
        for (const item of ALL_NAV_ITEMS) {
            expect(item.icon, item.url).toBe(
                PAGE_ICONS[item.url as keyof typeof PAGE_ICONS],
            );
            expect(item).not.toHaveProperty("paletteIcon");
        }
    });

    it("separates previously-colliding destinations", () => {
        expect(PAGE_ICONS["/statistics"]).not.toBe(
            PAGE_ICONS["/research/market"],
        );
        expect(PAGE_ICONS["/accounts"]).not.toBe(PAGE_ICONS["/tax"]);
        expect(PAGE_ICONS["/admin/db"]).not.toBe(
            PAGE_ICONS["/admin/exchange-rates"],
        );
        expect(PAGE_ICONS["/portfolio/stocks"]).not.toBe(
            PAGE_ICONS["/research/forecast"],
        );
        expect(PAGE_ICONS["/research/markets"]).not.toBe(
            PAGE_ICONS["/admin/providers"],
        );
    });
});
