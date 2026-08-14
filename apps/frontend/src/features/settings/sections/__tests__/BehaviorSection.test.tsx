// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { apiClient } from "@/lib/api";
import { BehaviorSection } from "@/features/settings/sections/BehaviorSection";

// The server-computed portfolio summary reads the TOP-LEVEL cost_basis_method
// setting (portfolioSummaryService.resolveCostBasisMethod), not the
// app_settings blob the Select historically wrote — so changing the method
// must also persist that key and refresh the server-computed summaries.

function costBasisTrigger(): Promise<HTMLElement> {
    // findBy: the provider stack resolves settings before children render.
    return screen.findByRole("combobox", { name: /cost basis method/i });
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("BehaviorSection — cost basis method", () => {
    it("persists the top-level cost_basis_method key and refreshes portfolio summaries", async () => {
        const saveSetting = vi
            .spyOn(apiClient, "saveSetting")
            .mockResolvedValue({ key: "cost_basis_method", value: "fifo" });
        const user = userEvent.setup();
        const { queryClient } = renderWithApp(<BehaviorSection />);
        const invalidate = vi.spyOn(queryClient, "invalidateQueries");

        await user.click(await costBasisTrigger());
        await user.click(await screen.findByRole("option", { name: /fifo/i }));

        await waitFor(() => {
            expect(saveSetting).toHaveBeenCalledWith("cost_basis_method", "fifo");
        });
        await waitFor(() => {
            expect(invalidate).toHaveBeenCalledWith({ queryKey: ["portfolio-summary"] });
        });
    });

    it("surfaces a save failure instead of swallowing it", async () => {
        vi.spyOn(apiClient, "saveSetting").mockRejectedValue(new Error("boom"));
        const { toast } = await import("sonner");
        const errorToast = vi.spyOn(toast, "error").mockReturnValue("t" as never);
        const user = userEvent.setup();
        renderWithApp(<BehaviorSection />);

        await user.click(await costBasisTrigger());
        await user.click(await screen.findByRole("option", { name: /lifo/i }));

        await waitFor(() => {
            expect(errorToast).toHaveBeenCalled();
        });
    });
});

// ── Keep services running on quit ────────────────────────────────────────────
// Electron-only opt-in toggle. `apiClient.isElectron()` returns true iff
// `window.electronUpdater` exists; the toggle itself loads/persists through
// `window.electronServices` (services:save/load-settings IPC).

interface ServicesSettings {
    keepServicesOnQuit: boolean;
}

function installElectronStubs(loadedSettings: ServicesSettings = { keepServicesOnQuit: false }) {
    const win = window as unknown as Record<string, unknown>;
    win.electronUpdater = {
        pullImage: vi.fn().mockResolvedValue({ success: true, wasNew: false }),
    };
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const loadSettings = vi.fn().mockResolvedValue(loadedSettings);
    win.electronServices = { saveSettings, loadSettings };
    return { saveSettings, loadSettings };
}

function clearElectronStubs() {
    const win = window as unknown as Record<string, unknown>;
    delete win.electronUpdater;
    delete win.electronServices;
}

describe("BehaviorSection — keep services running on quit", () => {
    beforeEach(() => {
        clearElectronStubs();
    });

    afterEach(() => {
        clearElectronStubs();
        vi.restoreAllMocks();
    });

    it("is hidden in the web (non-Electron) context", async () => {
        renderWithApp(<BehaviorSection />);

        // Wait for a row that always renders so we know the section settled.
        await costBasisTrigger();

        expect(
            screen.queryByRole("switch", { name: /keep services running on quit/i }),
        ).not.toBeInTheDocument();
    });

    it("renders and reflects the stored value in the Electron context", async () => {
        installElectronStubs({ keepServicesOnQuit: true });
        renderWithApp(<BehaviorSection />);

        const switchEl = await screen.findByRole("switch", { name: /keep services running on quit/i });
        await waitFor(() => {
            expect(switchEl).toHaveAttribute("data-state", "checked");
        });
    });

    it("persists the toggle via the services save-settings IPC", async () => {
        const { saveSettings } = installElectronStubs({ keepServicesOnQuit: false });
        const user = userEvent.setup();
        renderWithApp(<BehaviorSection />);

        const switchEl = await screen.findByRole("switch", { name: /keep services running on quit/i });
        await waitFor(() => expect(switchEl).toHaveAttribute("data-state", "unchecked"));

        await user.click(switchEl);

        await waitFor(() => {
            expect(switchEl).toHaveAttribute("data-state", "checked");
        });
        await waitFor(() => {
            expect(saveSettings).toHaveBeenCalledWith({ keepServicesOnQuit: true });
        });
    });
});
