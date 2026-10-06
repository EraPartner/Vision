// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { http } from "msw";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { renderWithApp } from "@/test/renderWithApp";
import { apiClient } from "@/lib/api";
import { AboutSection } from "@/features/settings/sections/AboutSection";
import {
    DEFAULT_APP_SETTINGS,
    DEFAULT_DASHBOARD_SETTINGS,
    useSettingsStore,
} from "@/stores/settingsStore";

const API_BASE = "http://localhost:3002";

// "Reset all settings" sits in the danger zone: it must ask first, and only a
// confirmed reset may touch the stored preferences or the server-side
// includeTransfers aggregation setting.

async function renderWithCustomisedSettings() {
    const saveSetting = vi.spyOn(apiClient, "saveSetting").mockResolvedValue({
        key: "includeTransfers",
        value: false,
        expected: { exists: true, value: false },
    });
    const user = userEvent.setup();
    renderWithApp(<AboutSection onOpenChange={vi.fn()} />);
    const resetButton = await screen.findByRole("button", { name: /^reset$/i });
    await waitFor(() => {
        const state = useSettingsStore.getState();
        expect(state.isAppSettingsLoading).toBe(false);
        expect(state.isDashboardSettingsLoading).toBe(false);
    });
    useSettingsStore.setState({
        appSettings: { ...DEFAULT_APP_SETTINGS, dateFormat: "YYYY-MM-DD" },
        dashboardSettings: {
            ...DEFAULT_DASHBOARD_SETTINGS,
            excludedCategoryIds: [5],
        },
    });
    return { user, resetButton, saveSetting };
}

afterEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.setState({
        appSettings: DEFAULT_APP_SETTINGS,
        dashboardSettings: DEFAULT_DASHBOARD_SETTINGS,
    });
});

describe("AboutSection — reset all settings", () => {
    it("asks first and keeps every setting when cancelled", async () => {
        const { user, resetButton, saveSetting } =
            await renderWithCustomisedSettings();

        await user.click(resetButton);
        const dialog = await screen.findByRole("alertdialog", {
            name: /reset all settings\?/i,
        });
        expect(
            within(dialog).getByText(
                /your theme, accounts, transactions and other data are kept/i,
            ),
        ).toBeInTheDocument();
        await user.click(
            within(dialog).getByRole("button", { name: /cancel/i }),
        );

        await waitFor(() => {
            expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
        });
        const state = useSettingsStore.getState();
        expect(state.appSettings.dateFormat).toBe("YYYY-MM-DD");
        expect(state.dashboardSettings.excludedCategoryIds).toEqual([5]);
        expect(saveSetting).not.toHaveBeenCalledWith("includeTransfers", false);
    });

    it("resets preferences, exclusions and includeTransfers once confirmed", async () => {
        const info = vi.spyOn(toast, "info").mockReturnValue("t" as never);
        const { user, resetButton, saveSetting } =
            await renderWithCustomisedSettings();

        await user.click(resetButton);
        const dialog = await screen.findByRole("alertdialog", {
            name: /reset all settings\?/i,
        });
        await user.click(
            within(dialog).getByRole("button", { name: /^reset settings$/i }),
        );

        await waitFor(() => {
            expect(useSettingsStore.getState().appSettings.dateFormat).toBe(
                DEFAULT_APP_SETTINGS.dateFormat,
            );
        });
        expect(
            useSettingsStore.getState().dashboardSettings.excludedCategoryIds,
        ).toEqual([]);
        await waitFor(() => {
            expect(saveSetting).toHaveBeenCalledWith("includeTransfers", false);
        });
        expect(info).toHaveBeenCalledWith("Settings reset to defaults");
    });
});

// The update dialog is gone (ADR-180): the About section is where an
// available update is shown and installed, fed by the shared status query.
describe("AboutSection — updates", () => {
    const UPDATE_AVAILABLE = {
        up_to_date: false,
        current_version: "1.2.3",
        latest_version: "1.3.0",
        published_at: "2025-04-01T00:00:00.000Z",
        release_notes: "- Bug fixes\n- New features",
        html_url: "https://example.com/release/1.3.0",
        update_mode: "native" as const,
    };

    it("shows the available version with its release notes link", async () => {
        server.use(
            http.get(`${API_BASE}/api/admin/update/check`, () =>
                ok(UPDATE_AVAILABLE),
            ),
        );
        renderWithApp(<AboutSection onOpenChange={vi.fn()} />);

        expect(
            await screen.findByText(/version 1\.3\.0 is available/i),
        ).toBeInTheDocument();
        expect(screen.getByText(/Bug fixes/)).toBeInTheDocument();
        const link = screen.getByRole("link", { name: /release notes/i });
        expect(link).toHaveAttribute("href", "https://example.com/release/1.3.0");
        expect(link).toHaveAttribute("target", "_blank");
        expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
        // Outside Electron there is nothing to install in place.
        expect(
            screen.queryByRole("button", { name: /install update/i }),
        ).not.toBeInTheDocument();
    });

    it("says the app is current when up to date", async () => {
        renderWithApp(<AboutSection onOpenChange={vi.fn()} />);
        expect(
            await screen.findByText(/running the latest version/i),
        ).toBeInTheDocument();
    });
});
