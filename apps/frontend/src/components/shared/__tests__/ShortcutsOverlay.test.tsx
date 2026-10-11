// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { ShortcutsOverlay } from "@/components/shared/ShortcutsOverlay";

describe("ShortcutsOverlay", () => {
    it("documents keyboard access to toast and row actions", async () => {
        renderWithApp(<ShortcutsOverlay open onOpenChange={() => {}} />);

        const toastLabel = await screen.findByText("Focus notifications");
        const toastRow = toastLabel.closest("div");
        expect(toastRow).not.toBeNull();
        expect(screen.getByText(/Shift\+F10/)).toBeInTheDocument();
        expect(within(toastRow!).getByText("Alt")).toBeInTheDocument();
        expect(within(toastRow!).getByText("T")).toBeInTheDocument();
    });
    it("shows current destination names with their updated keys", async () => {
        renderWithApp(<ShortcutsOverlay open onOpenChange={() => {}} />);
        for (const [label, key] of [
            ["Insights", "I"],
            ["Payees", "Y"],
            ["Import & Export", "E"],
        ]) {
            const name = await screen.findByText(label);
            const row = name.closest("div")!;
            expect(within(row).getByText("G")).toBeInTheDocument();
            expect(within(row).getByText(key)).toBeInTheDocument();
        }
    });
});
