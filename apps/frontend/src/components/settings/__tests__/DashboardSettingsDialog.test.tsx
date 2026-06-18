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
        renderDialog(true);
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    it("does not render dialog when open=false", () => {
        renderDialog(false);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows the sidebar nav sections", async () => {
        renderDialog(true);
        await screen.findByRole("dialog");

        for (const name of [/^general$/i, /^appearance$/i, /^statistics$/i, /^behavior$/i, /AI & Research/i, /^backup$/i, /About & Maintenance/i]) {
            expect(await screen.findByRole("button", { name })).toBeInTheDocument();
        }
    });

    it("switching to Appearance shows appearance content", async () => {
        const user = userEvent.setup();
        renderDialog(true, "general");
        await screen.findByRole("dialog");

        await user.click(await screen.findByRole("button", { name: /^appearance$/i }));

        expect(await screen.findByText(/theme variant/i)).toBeInTheDocument();
    });

    it("switching to Statistics shows exclusion content", async () => {
        const user = userEvent.setup();
        renderDialog(true, "general");
        await screen.findByRole("dialog");

        await user.click(await screen.findByRole("button", { name: /^statistics$/i }));

        expect(await screen.findAllByText(/exclusion scope/i)).not.toHaveLength(0);
    });

    it("Done button closes the dialog", async () => {
        const user = userEvent.setup();
        const { onOpenChange } = renderDialog(true);
        await screen.findByRole("dialog");

        await user.click(await screen.findByRole("button", { name: /^done$/i }));

        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it("Escape key calls onOpenChange(false)", async () => {
        const user = userEvent.setup();
        const { onOpenChange } = renderDialog(true);
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it("defaultTab=appearance opens on the Appearance section", async () => {
        renderDialog(true, "appearance");
        await screen.findByRole("dialog");

        expect(await screen.findByText(/theme variant/i)).toBeInTheDocument();
        const navBtn = await screen.findByRole("button", { name: /^appearance$/i });
        expect(navBtn).toHaveAttribute("aria-current", "page");
    });

    it("legacy 'dashboard' deep-link maps to the Statistics section", async () => {
        renderDialog(true, "dashboard");
        await screen.findByRole("dialog");

        const navBtn = await screen.findByRole("button", { name: /^statistics$/i });
        expect(navBtn).toHaveAttribute("aria-current", "page");
        expect(await screen.findAllByText(/exclusion scope/i)).not.toHaveLength(0);
    });

    it("legacy 'app' deep-link maps to the About section", async () => {
        renderDialog(true, "app");
        await screen.findByRole("dialog");

        const navBtn = await screen.findByRole("button", { name: /About & Maintenance/i });
        expect(navBtn).toHaveAttribute("aria-current", "page");
        expect(await screen.findByText(/reset all settings/i)).toBeInTheDocument();
    });

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        renderDialog(true);
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });
});
