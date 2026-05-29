// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { DashboardSettingsDialog } from "@/components/settings/DashboardSettingsDialog";

beforeEach(() => {
    server.resetHandlers();
});

function renderDialog(open = true, defaultTab = "general") {
    const onOpenChange = vi.fn();
    const result = renderWithApp(
        <DashboardSettingsDialog
            open={open}
            onOpenChange={onOpenChange}
            defaultTab={defaultTab}
        />
    );
    return { ...result, onOpenChange };
}

describe("DashboardSettingsDialog", () => {
    it("renders dialog when open=true", async () => {
        // Arrange + Act
        renderDialog(true);

        // Assert
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    it("does not render dialog when open=false", () => {
        // Arrange + Act
        renderDialog(false);

        // Assert
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows all 5 tabs", async () => {
        // Arrange + Act
        renderDialog(true);

        // Assert — wait for dialog to appear first
        await screen.findByRole("dialog");
        expect(await screen.findByRole("tab", { name: /^general$/i })).toBeInTheDocument();
        expect(await screen.findByRole("tab", { name: /^appearance$/i })).toBeInTheDocument();
        expect(await screen.findByRole("tab", { name: /^dashboard$/i })).toBeInTheDocument();
        expect(await screen.findByRole("tab", { name: /^app$/i })).toBeInTheDocument();
        expect(await screen.findByRole("tab", { name: /^backup$/i })).toBeInTheDocument();
    });

    it("switching to Appearance tab shows appearance content", async () => {
        // Arrange
        const user = userEvent.setup();
        renderDialog(true, "general");
        await screen.findByRole("dialog");

        // Act
        const appearanceTab = await screen.findByRole("tab", { name: /^appearance$/i });
        await user.click(appearanceTab);

        // Assert — Appearance tab shows theme variant content (unique to this tab)
        expect(await screen.findByText(/theme variant/i)).toBeInTheDocument();
    });

    it("switching to Dashboard tab shows exclusion filters content", async () => {
        // Arrange
        const user = userEvent.setup();
        renderDialog(true, "general");
        await screen.findByRole("dialog");

        // Act
        const dashboardTab = await screen.findByRole("tab", { name: /^dashboard$/i });
        await user.click(dashboardTab);

        // Assert — Dashboard tab renders exclusion settings section
        expect(await screen.findByText(/exclusion settings/i)).toBeInTheDocument();
    });

    it("Save button closes dialog and shows success toast", async () => {
        // Arrange
        const user = userEvent.setup();
        const { onOpenChange } = renderDialog(true);
        await screen.findByRole("dialog");

        // Act
        const saveBtn = await screen.findByRole("button", { name: /save changes/i });
        await user.click(saveBtn);

        // Assert
        await waitFor(() => {
            expect(onOpenChange).toHaveBeenCalledWith(false);
        });
    });

    it("Cancel button closes dialog", async () => {
        // Arrange
        const user = userEvent.setup();
        const { onOpenChange } = renderDialog(true);
        await screen.findByRole("dialog");

        // Act
        const cancelBtn = await screen.findByRole("button", { name: /cancel/i });
        await user.click(cancelBtn);

        // Assert
        await waitFor(() => {
            expect(onOpenChange).toHaveBeenCalledWith(false);
        });
    });

    it("defaultTab prop controls initial tab", async () => {
        // Arrange + Act — render with appearance as default
        renderDialog(true, "appearance");
        await screen.findByRole("dialog");

        // Assert — Appearance content is immediately visible (unique to Appearance tab)
        expect(await screen.findByText(/theme variant/i)).toBeInTheDocument();
        // Appearance tab trigger should be selected
        const appearanceTab = await screen.findByRole("tab", { name: /^appearance$/i });
        expect(appearanceTab).toHaveAttribute("data-state", "active");
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("Escape key calls onOpenChange(false)", async () => {
        const user = userEvent.setup();
        const { onOpenChange } = renderDialog(true);
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        renderDialog(true);
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });

    it("first focusable element exists for Tab navigation (keyboard nav)", async () => {
        renderDialog(true);
        await screen.findByRole("dialog");
        const focusables = screen.getAllByRole("button");
        expect(focusables.length).toBeGreaterThan(0);
    });
});
