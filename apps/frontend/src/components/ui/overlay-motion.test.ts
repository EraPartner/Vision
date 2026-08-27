// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FLOATING_FILES = [
    "popover.tsx",
    "dropdown-menu.tsx",
    "select.tsx",
    "context-menu.tsx",
];

const FLOATING_MOTION_CLASSES = [
    "data-[state=open]:duration-[var(--duration-fast)]",
    "data-[state=closed]:duration-[var(--duration-fast)]",
    "ease-[var(--ease-out-expo)]",
    "motion-reduce:data-[state=open]:animate-none",
    "motion-reduce:data-[state=closed]:animate-none",
];

function readPrimitive(file: string): string {
    return readFileSync(join(process.cwd(), "src/components/ui", file), "utf8");
}

function sourceBetween(source: string, start: string, end: string): string {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex);
    expect(startIndex, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
    expect(endIndex, `missing end marker: ${end}`).toBeGreaterThan(startIndex);
    return source.slice(startIndex, endIndex);
}

describe("overlay motion contract", () => {
    it.each(FLOATING_FILES)("owns fast motion and reduced-motion gates in %s", (file) => {
        const source = readPrimitive(file);
        for (const className of FLOATING_MOTION_CLASSES) {
            expect(source, `${file}: ${className}`).toContain(className);
        }
    });

    it("uses Tooltip's actual instant-open and delayed-open states", () => {
        const source = readPrimitive("tooltip.tsx");
        const openStates = ["instant-open", "delayed-open"];

        for (const state of openStates) {
            expect(source).toContain(`data-[state=${state}]:animate-in`);
            expect(source).toContain(`data-[state=${state}]:duration-[var(--duration-fast)]`);
            expect(source).toContain(`motion-reduce:data-[state=${state}]:animate-none`);
        }
        expect(source).not.toContain("data-[state=open]");
        expect(source).toContain("data-[state=closed]:duration-[var(--duration-fast)]");
        expect(source).toContain("motion-reduce:data-[state=closed]:animate-none");
        expect(source).toContain("ease-[var(--ease-out-expo)]");
    });

    it("keeps Sheet slower and gates both its content and overlay", () => {
        const source = readPrimitive("sheet.tsx");
        const overlay = sourceBetween(source, "const SheetOverlay", "SheetOverlay.displayName");
        const content = sourceBetween(source, "const sheetVariants", "const SheetContent");
        const required = [
            "data-[state=open]:duration-[var(--duration-slow)]",
            "data-[state=closed]:duration-[var(--duration-normal)]",
            "ease-[var(--ease-out-expo)]",
            "motion-reduce:data-[state=open]:animate-none",
            "motion-reduce:data-[state=closed]:animate-none",
        ];

        for (const className of required) {
            expect(overlay, `SheetOverlay: ${className}`).toContain(className);
            expect(content, `sheetVariants: ${className}`).toContain(className);
        }
    });
});
