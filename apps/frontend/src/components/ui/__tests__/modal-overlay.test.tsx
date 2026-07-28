// @vitest-environment jsdom
/**
 * Modal overlay backdrop — tier contract (ADR-075).
 *
 * The dialog / alert-dialog / sheet overlays used to hard-code
 * `backdrop-blur-md`, re-blurring the entire viewport on every vsync while
 * any modal was open. They now carry the semantic `modal-overlay` class,
 * whose per-tier styling lives in index.css: a flat dim at every tier, with
 * the frosted blur restored only under `:root.fx-enhanced` (the class
 * VisualEffectsController stamps on <html> when the effective
 * visual-effects tier is 'enhanced').
 *
 * jsdom neither loads index.css nor evaluates @supports/@media, so the tier
 * toggle is pinned in two halves:
 *  - DOM: each overlay renders the semantic class and no blur utility;
 *  - CSS: index.css scopes the blur to `:root.fx-enhanced` and keeps the
 *    base `.modal-overlay` rule blur-free.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogTitle,
    AlertDialogDescription,
} from "@/components/ui/alert-dialog";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";

// vitest runs with apps/frontend as the project root.
const indexCss = readFileSync(join(process.cwd(), "src/index.css"), "utf8");

function overlayEl(): HTMLElement {
    const el = document.querySelector<HTMLElement>(".fixed.inset-0.z-50");
    expect(el).not.toBeNull();
    return el!;
}

/** The body of the first CSS rule for `selector` (naive but sufficient here). */
function ruleBody(selector: string): string {
    const start = indexCss.indexOf(`${selector} {`);
    expect(start, `rule "${selector}" exists in index.css`).toBeGreaterThan(-1);
    const open = indexCss.indexOf("{", start);
    const close = indexCss.indexOf("}", open);
    return indexCss.slice(open + 1, close);
}

describe("modal overlay — rendered classes (default tier = dim)", () => {
    it.each([
        [
            "dialog",
            () => (
                <Dialog open>
                    <DialogContent>
                        <DialogTitle>t</DialogTitle>
                        <DialogDescription>d</DialogDescription>
                    </DialogContent>
                </Dialog>
            ),
            false,
        ],
        [
            "alert-dialog",
            () => (
                <AlertDialog open>
                    <AlertDialogContent>
                        <AlertDialogTitle>t</AlertDialogTitle>
                        <AlertDialogDescription>d</AlertDialogDescription>
                    </AlertDialogContent>
                </AlertDialog>
            ),
            true,
        ],
        [
            "sheet",
            () => (
                <Sheet open>
                    <SheetContent>
                        <SheetTitle>t</SheetTitle>
                        <SheetDescription>d</SheetDescription>
                    </SheetContent>
                </Sheet>
            ),
            false,
        ],
    ])("%s overlay uses the tiered dim class, not an unconditional blur", (_name, ui, strong) => {
        render(ui());
        const overlay = overlayEl();
        expect(overlay.className).toContain("modal-overlay");
        expect(overlay.className.includes("modal-overlay-strong")).toBe(strong);
        // The unconditional full-viewport blur must be gone at the default tier.
        expect(overlay.className).not.toContain("backdrop-blur");
        expect(overlay.className).not.toContain("bg-background/");
        cleanup();
    });
});

describe("modal overlay — index.css tier rules", () => {
    it("base tier is a flat dim with no backdrop blur", () => {
        const base = ruleBody("    .modal-overlay");
        expect(base).toContain("hsl(var(--background) / 0.6)");
        expect(base).not.toContain("backdrop-filter");
    });

    it("the frosted blur is scoped to the enhanced tier root class", () => {
        const enhanced = ruleBody(":root.fx-enhanced .modal-overlay");
        // Pixel-identical to the pre-tier overlay: blur-md (12px) over /40.
        expect(enhanced).toContain("backdrop-filter: blur(12px)");
        expect(enhanced).toContain("hsl(var(--background) / 0.4)");
    });

    it("alert dialogs keep their stronger scrim at the enhanced tier", () => {
        const strong = ruleBody(":root.fx-enhanced .modal-overlay-strong");
        expect(strong).toContain("hsl(var(--background) / 0.5)");
    });

    it("no rule blurs .modal-overlay outside the fx-enhanced scope", () => {
        // Every `.modal-overlay` rule that sets a backdrop-filter must sit
        // under :root.fx-enhanced — the class VisualEffectsController stamps
        // on <html> when the user's visual-effects setting is 'enhanced'.
        const ruleRe = /^[^\S\n]*([^\n{}]*\.modal-overlay[^\n{}]*)\{([^}]*)\}/gm;
        let match: RegExpExecArray | null;
        let count = 0;
        while ((match = ruleRe.exec(indexCss)) !== null) {
            count += 1;
            const [, selector, body] = match;
            if (body.includes("backdrop-filter")) {
                expect(selector).toContain(":root.fx-enhanced");
            }
        }
        expect(count).toBeGreaterThanOrEqual(2);
    });
});
