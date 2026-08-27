// @vitest-environment jsdom
/**
 * The splash → SPA handoff.
 *
 * When the Electron splash navigates to the app, Chromium holds the splash
 * frame until this document's first paint. `#root` used to be empty, so that
 * paint was a bare colored void for the whole boot-graph parse/execute window:
 * spinner + wordmark → nothing → shell.
 *
 * `index.html` now ships a static mirror of the splash inside `#root`. These
 * tests pin the two things that make it work — it is inert (no JS, nothing that
 * could grow the boot graph), and React clears it on its first commit — plus its
 * fidelity to `splashDataUrl()` in packaging/electron/main.js, which is read
 * here so that changing the splash's look without following it fails loudly.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

// jsdom tests have an http: import.meta.url, so resolve off the run directory
// (vitest's root is apps/frontend; tolerate a repo-root invocation too).
const CWD = process.cwd();
const FRONTEND_ROOT = existsSync(path.join(CWD, "apps/frontend/index.html"))
    ? path.join(CWD, "apps/frontend")
    : CWD;
const REPO_ROOT = path.resolve(FRONTEND_ROOT, "../..");

const INDEX_HTML = readFileSync(path.join(FRONTEND_ROOT, "index.html"), "utf8");
const ELECTRON_MAIN = readFileSync(
    path.join(REPO_ROOT, "packaging/electron/main.js"),
    "utf8",
);

/** The `#root` element's inner markup, as authored in index.html. */
function rootMarkup(): string {
    const match = INDEX_HTML.match(
        /<div id="root">([\s\S]*?)<\/div>\s*<script/,
    );
    if (!match) throw new Error("Could not find #root in index.html");
    return match[1];
}

describe("boot placeholder markup", () => {
    it("lives inside #root, so React's first commit clears it", () => {
        expect(rootMarkup()).toContain('id="boot-splash"');
    });

    it("is inert — no script, no imports, nothing that grows the boot graph", () => {
        const markup = rootMarkup();
        expect(markup).not.toMatch(/<script/i);
        expect(markup).not.toMatch(/\son[a-z]+=/i);
        expect(markup).not.toMatch(/<img|<link|<iframe/i);
    });

    it("carries the splash's three elements: spinner, wordmark, status line", () => {
        const markup = rootMarkup();
        expect(markup).toContain("boot-splash__spinner");
        expect(markup).toContain("boot-splash__name");
        // Reserved, not written: the splash's status text is localized in the
        // main process and nothing here can pick a language without JS. The line
        // box still has to exist or the wordmark shifts at the handoff.
        expect(markup).toContain("boot-splash__status");
        expect(markup).toMatch(/boot-splash__status[^>]*>&nbsp;</);
    });

    it("is styled from the theme tokens the pre-paint class already selected", () => {
        // The inline script in <head> sets `.dark` before first paint, and the
        // placeholder reads --background/--foreground/--primary, so it is correct
        // in both themes with no flash and no second source of truth for color.
        expect(INDEX_HTML).toContain("--boot-bg: var(--background");
        expect(INDEX_HTML).toContain("--boot-fg: var(--foreground");
        expect(INDEX_HTML).toContain("--boot-glow: var(--primary");
        expect(INDEX_HTML).toMatch(/\.dark #boot-splash\s*\{/);
    });
});

describe("boot placeholder fidelity to the Electron splash", () => {
    // Every value below is lifted from splashDataUrl() in
    // packaging/electron/main.js. Reading both files keeps the two in lockstep:
    // restyle the splash and this test points at the placeholder to match.
    const splashCss = (() => {
        const start = ELECTRON_MAIN.indexOf("function splashDataUrl()");
        expect(start).toBeGreaterThan(-1);
        return ELECTRON_MAIN.slice(
            start,
            ELECTRON_MAIN.indexOf("function setSplashStatus"),
        );
    })();

    const SHARED = [
        // Layout: same stack, same rhythm, same centering.
        "flex-direction: column",
        "align-items: center",
        "justify-content: center",
        "gap: 14px",
        // Spinner: same size, stroke, cut, opacity and period.
        "width: 26px",
        "height: 26px",
        "border-radius: 50%",
        "border: 2.5px solid currentColor",
        "border-top-color: transparent",
        "opacity: 0.55",
        "0.9s linear infinite",
        "rotate(360deg)",
        // Type: same stack (system fonts — the app's webfonts are not loaded
        // yet at this point) and same scale.
        "-apple-system, BlinkMacSystemFont",
        "font-size: 15px",
        "font-weight: 600",
        "letter-spacing: 0.01em",
        "font-size: 13px",
        "font-variant-numeric: tabular-nums",
        // Feel.
        "-webkit-font-smoothing: antialiased",
        "user-select: none",
        "cursor: default",
        // The "shine": identical gradient geometry and alpha.
        "radial-gradient(85% 60% at 50% 38%",
        "/ 0.16)",
        "transparent 70%",
    ];

    it.each(SHARED)("matches the splash on %s", (fragment) => {
        expect(splashCss).toContain(fragment);
        expect(INDEX_HTML).toContain(fragment);
    });

    it("hides the spinner under prefers-reduced-motion, exactly as the splash does", () => {
        expect(splashCss).toContain("@media (prefers-reduced-motion: reduce)");
        expect(INDEX_HTML).toMatch(
            /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,160}boot-splash__spinner[\s\S]{0,60}display: none/,
        );
    });

    it("shows the same wordmark the splash shows", () => {
        expect(ELECTRON_MAIN).toMatch(
            /const APP_NAME = __IS_DEMO \? ["']Vision Demo["'] : ["']Vision["']/,
        );
        expect(rootMarkup()).toMatch(/boot-splash__name[^>]*>Vision</);
    });
});

describe("handoff to React", () => {
    it("is replaced atomically by the first render, leaving nothing behind", async () => {
        const container = document.createElement("div");
        container.id = "root";
        // Same markup index.html ships.
        container.innerHTML = rootMarkup();
        document.body.appendChild(container);

        expect(container.querySelector("#boot-splash")).not.toBeNull();

        const root = createRoot(container);
        await act(async () => {
            root.render(<main data-testid="shell">shell</main>);
        });

        expect(container.querySelector("#boot-splash")).toBeNull();
        expect(container.querySelector('[data-testid="shell"]')).not.toBeNull();

        root.unmount();
        container.remove();
    });
});
