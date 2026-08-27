import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/index.css"), "utf8");
const sonnerCss = readFileSync(
    join(process.cwd(), "node_modules/sonner/dist/styles.css"),
    "utf8",
);

describe("Sonner motion contract", () => {
    it("uses Vision motion tokens for toast arrival, reflow, dismissal, and swipe", () => {
        expect(css).toContain("[data-sonner-toast] {");
        expect(css).toContain(
            "transition-property: transform, opacity, height, box-shadow !important",
        );
        expect(css).toContain("[data-sonner-toaster] {");
        expect(css).toContain(
            "transition-duration: var(--duration-slow) !important",
        );
        expect(css).toContain('[data-sonner-toast][data-mounted="true"]');
        expect(css).toContain(
            "transition-timing-function: var(--ease-out-expo)",
        );
        expect(css).toContain('[data-sonner-toast][data-removed="true"]');
        expect(css).toContain(
            '[data-front="false"][data-swipe-out="false"][data-expanded="false"]',
        );
        expect(css).toContain(
            "transition-duration: var(--duration-dismiss) !important",
        );
        expect(css).toContain(
            '[data-sonner-toast][data-swipe-out="true"][data-y-position]',
        );
        expect(css).toContain(
            "animation-duration: var(--duration-dismiss) !important",
        );
        expect(css).toContain(
            '[data-sonner-toast][data-promise="true"] [data-icon] > svg',
        );
        expect(css).toContain('.sonner-loading-wrapper[data-visible="false"]');
        expect(css).toContain(".sonner-loading-bar {");
    });

    it("wins the installed Sonner cascade even when its CSS is appended later", () => {
        expect(sonnerCss).toContain(
            "transition: transform 500ms, opacity 200ms",
        );
        expect(sonnerCss).toContain(
            "transition: transform 400ms, opacity 400ms, height 400ms, box-shadow 200ms",
        );
        expect(sonnerCss).toContain(
            "animation: sonner-spin 1.2s linear infinite",
        );

        expect(css).toContain(
            "transition-property: transform, opacity, height, box-shadow !important",
        );
        expect(css).toContain(
            "transition-duration: var(--duration-dismiss) !important",
        );
        expect(css).toContain(
            "animation-duration: calc(var(--duration-reveal) * 2) !important",
        );
        expect(css).toContain("transition: none !important");
    });

    it("turns off toast, child, and loader motion for reduced-motion users", () => {
        const reducedMotion = css.slice(
            css.indexOf("@media (prefers-reduced-motion: reduce)"),
        );
        expect(reducedMotion).toContain("[data-sonner-toast] > *");
        expect(reducedMotion).toContain(".sonner-loader");
        expect(reducedMotion).toContain(".sonner-loading-wrapper");
        expect(reducedMotion).toContain(".sonner-loading-bar");
        expect(reducedMotion).toContain("transition: none !important");
        expect(reducedMotion).toContain("animation: none !important");
    });
});
