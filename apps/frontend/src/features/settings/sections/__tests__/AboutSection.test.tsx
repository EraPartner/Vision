// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { renderWithApp } from "@/test/renderWithApp";
import { apiClient } from "@/lib/api";
import { AboutSection } from "@/features/settings/sections/AboutSection";
import {
    DEFAULT_APP_SETTINGS,
    DEFAULT_DASHBOARD_SETTINGS,
    useSettingsStore,
} from "@/stores/settingsStore";

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
