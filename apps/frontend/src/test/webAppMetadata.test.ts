// @vitest-environment node

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const frontendRoot = process.cwd();
const publicRoot = join(frontendRoot, "public");

describe("web app metadata", () => {
    it("pins the installable shell metadata and icon assets", () => {
        const manifest = JSON.parse(
            readFileSync(join(publicRoot, "manifest.json"), "utf8"),
        ) as {
            name: string;
            start_url: string;
            scope: string;
            display: string;
            theme_color: string;
            background_color: string;
            icons: Array<{ src: string; sizes: string }>;
        };

        expect(manifest).toMatchObject({
            name: "Vision",
            start_url: "/",
            scope: "/",
            display: "standalone",
        });
        expect(manifest.theme_color).toMatch(/^#[0-9A-F]{6}$/i);
        expect(manifest.background_color).toMatch(/^#[0-9A-F]{6}$/i);
        expect(manifest.icons.map((icon) => icon.sizes)).toEqual(
            expect.arrayContaining(["any", "192x192", "512x512"]),
        );
        for (const icon of manifest.icons) {
            expect(
                existsSync(join(publicRoot, icon.src.replace(/^\//, ""))),
            ).toBe(true);
        }
    });

    it("links the manifest and both theme colors without claiming offline support", () => {
        const html = readFileSync(join(frontendRoot, "index.html"), "utf8");
        const source = readFileSync(join(frontendRoot, "src/main.tsx"), "utf8");

        expect(html).toContain('rel="manifest"');
        expect(html.match(/name="theme-color"/g)).toHaveLength(2);
        expect(`${html}\n${source}`).not.toMatch(
            /serviceWorker|service-worker|workbox/i,
        );
    });
});
