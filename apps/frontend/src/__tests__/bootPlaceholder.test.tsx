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
 * tests pin the two things that make it work: it is inert (no JS, nothing that
 * could grow the boot graph), and React clears it on its first commit.
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

const INDEX_HTML = readFileSync(path.join(FRONTEND_ROOT, "index.html"), "utf8");

/** The `#root` element's inner markup, as authored in index.html. */
function rootMarkup(): string {
    const markup = INDEX_HTML.match(
        /<div id="root">([\s\S]*?)<\/div>\s*<script/,
    )?.[1];
    if (markup === undefined)
        throw new Error("Could not find #root in index.html");
    return markup;
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
