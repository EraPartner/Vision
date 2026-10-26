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
 * jsdom neither loads index.css nor evaluates @supports/@media, so this
 * pins the rendered half: each overlay carries the semantic class and no
 * unconditional blur utility.
 */
import { describe, it, expect } from "vitest";
import { render, cleanup } from "@testing-library/react";
import {
    Dialog,
    DialogContent,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog";
import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogTitle,
    AlertDialogDescription,
} from "@/components/ui/alert-dialog";
import {
    Sheet,
    SheetContent,
    SheetTitle,
    SheetDescription,
} from "@/components/ui/sheet";
import { must } from "@/test/must";

function overlayEl(): HTMLElement {
    const el = document.querySelector<HTMLElement>(".fixed.inset-0.z-50");
    expect(el).not.toBeNull();
    return must(el);
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
    ])(
        "%s overlay uses the tiered dim class, not an unconditional blur",
        (_name, ui, strong) => {
            render(ui());
            const overlay = overlayEl();
            expect(overlay.className).toContain("modal-overlay");
            expect(overlay.className.includes("modal-overlay-strong")).toBe(
                strong,
            );
            // The unconditional full-viewport blur must be gone at the default tier.
            expect(overlay.className).not.toContain("backdrop-blur");
            expect(overlay.className).not.toContain("bg-background/");
            cleanup();
        },
    );
});
