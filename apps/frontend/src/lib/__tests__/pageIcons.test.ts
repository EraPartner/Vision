import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ALL_NAV_ITEMS } from "@/lib/navigation";
import { PAGE_ICONS } from "@/lib/pageIcons";

const pagesRoot = resolve(import.meta.dirname, "../..", "pages");

function pageFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory()
            ? pageFiles(path)
            : path.endsWith("Page.tsx")
              ? [path]
              : [];
    });
}

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
            PAGE_ICONS["/portfolio/performance"],
        );
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

    it("prevents page headers from bypassing the registry", () => {
        const failures: string[] = [];
        for (const file of pageFiles(pagesRoot)) {
            const source = readFileSync(file, "utf8");
            for (const match of source.matchAll(
                /<PageHeader\b(?:(?!\/>)[\s\S])*?\bicon=\{([^}]+)\}/g,
            )) {
                if (
                    !match[1].includes("PAGE_ICONS") &&
                    match[1] !== "PageIcon"
                ) {
                    failures.push(`${relative(pagesRoot, file)}: ${match[1]}`);
                }
            }
        }
        expect(failures).toEqual([]);
    });
});
