// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/index.css"), "utf8");

describe("macOS vibrancy material contract", () => {
    it("uses native vibrancy instead of re-blurring persistent web surfaces", () => {
        const nativeSubstitution = css.match(
            /html\.electron-mac\.vibrancy\s+:is\(([\s\S]*?)\)\s*\{([\s\S]*?)\}/,
        );

        expect(nativeSubstitution).not.toBeNull();
        const selectors = nativeSubstitution?.[1] ?? "";
        const declarations = nativeSubstitution?.[2] ?? "";

        for (const selector of [
            ".glass",
            ".glass-regular",
            ".glass-chrome",
            ".glass-elevated",
            ".app-topbar",
            ".modal-overlay",
        ]) {
            expect(selectors).toContain(selector);
        }
        expect(declarations).toContain("-webkit-backdrop-filter: none");
        expect(declarations).toContain("backdrop-filter: none");
    });

    it("keeps small transient thin and thick materials out of the substitution", () => {
        const nativeSubstitution = css.match(
            /html\.electron-mac\.vibrancy\s+:is\(([\s\S]*?)\)\s*\{[\s\S]*?\}/,
        );
        const selectors = nativeSubstitution?.[1] ?? "";

        expect(selectors).not.toContain(".glass-thin");
        expect(selectors).not.toContain(".glass-thick");
        expect(selectors).not.toContain(".liquid-glass-soft");
    });

    it("retains the translucent body that exposes the native material", () => {
        expect(css).toMatch(
            /html\.electron-mac\.vibrancy body\s*\{\s*background-color:\s*hsl\(var\(--background\)\s*\/\s*0\.72\)/,
        );
    });
});
