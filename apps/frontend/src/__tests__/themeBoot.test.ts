// @vitest-environment jsdom
/**
 * public/theme-boot.js sets the light/dark class before first paint.
 *
 * The packaged app's CSP (`script-src 'self'`) blocks inline scripts, so the
 * theme script must be an external file; an inline one silently never ran and
 * every launch painted light first.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runInThisContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const CWD = process.cwd();
const FRONTEND_ROOT = existsSync(path.join(CWD, "apps/frontend/index.html"))
    ? path.join(CWD, "apps/frontend")
    : CWD;

const INDEX_HTML = readFileSync(path.join(FRONTEND_ROOT, "index.html"), "utf8");
const BOOT_SCRIPT = readFileSync(
    path.join(FRONTEND_ROOT, "public/theme-boot.js"),
    "utf8",
);

const DARK_PALETTE = {
    theme: "dark",
    base: "200 20% 7%",
    foreground: "42 25% 96%",
    glow: "160 74% 52%",
};

function runBoot(storage: Record<string, string>, osDark: boolean): void {
    localStorage.clear();
    for (const [key, value] of Object.entries(storage))
        localStorage.setItem(key, value);
    vi.stubGlobal(
        "matchMedia",
        (query: string) =>
            ({
                matches: query === "(prefers-color-scheme: dark)" && osDark,
            }) as MediaQueryList,
    );
    // Runs the shipped file as a classic script, as the browser does.
    runInThisContext(BOOT_SCRIPT);
}

const root = () => document.documentElement;

afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    root().className = "";
    root().removeAttribute("style");
});

describe("index.html", () => {
    it("has no inline script, which the packaged CSP would block", () => {
        const inline = INDEX_HTML.match(/<script(?![^>]*\ssrc=)[^>]*>/gi);
        expect(inline).toBeNull();
    });

    it("loads theme-boot.js as a blocking classic script in <head>", () => {
        const head = INDEX_HTML.split("</head>")[0] ?? "";
        expect(head).toContain('<script src="/theme-boot.js"></script>');
    });
});

describe("theme-boot.js", () => {
    it("defaults to dark with no stored theme", () => {
        runBoot({}, false);
        expect(root().classList.contains("dark")).toBe(true);
    });

    it("uses an explicit Light or Dark choice regardless of macOS", () => {
        runBoot({ vision_theme_mode: "light", vision_theme: "light" }, true);
        expect(root().classList.contains("dark")).toBe(false);
        runBoot({ vision_theme_mode: "dark", vision_theme: "dark" }, false);
        expect(root().classList.contains("dark")).toBe(true);
    });

    it("re-resolves follow-system mode from the current macOS appearance", () => {
        runBoot({ vision_theme_mode: "system", vision_theme: "light" }, true);
        expect(root().classList.contains("dark")).toBe(true);
        runBoot({ vision_theme_mode: "system", vision_theme: "dark" }, false);
        expect(root().classList.contains("dark")).toBe(false);
    });

    it("applies the saved boot palette only for the theme it was saved under", () => {
        const palette = JSON.stringify(DARK_PALETTE);
        runBoot({ vision_theme: "dark", vision_boot_palette: palette }, true);
        expect(root().style.getPropertyValue("--vision-boot-bg")).toBe(
            DARK_PALETTE.base,
        );

        root().removeAttribute("style");
        runBoot(
            { vision_theme_mode: "system", vision_boot_palette: palette },
            false,
        );
        expect(root().classList.contains("dark")).toBe(false);
        expect(root().style.getPropertyValue("--vision-boot-bg")).toBe("");
    });
});
