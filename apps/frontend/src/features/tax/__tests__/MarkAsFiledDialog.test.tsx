// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { apiClient } from "@/lib/api";
import { MarkAsFiledDialog } from "../MarkAsFiledDialog";
import { useSettingsStore } from "@/stores/settingsStore";
import { DEFAULT_BELGIAN_TAX_PROFILE } from "@/stores/belgianTaxStore";

vi.mock("@/contexts/BelgianTaxProfileContext", () => ({
    useBelgianTaxProfile: (selector: Parameters<typeof useSettingsStore>[0]) =>
        useSettingsStore(selector),
}));
vi.mock("@/stores/hydration/LanguageHydration", () => ({
    useLanguage: () => ({ t: (key: string) => key }),
}));

describe("recording a filing", () => {
    beforeEach(() => {
        vi.spyOn(apiClient, "saveSettings").mockResolvedValue(undefined);
        useSettingsStore
            .getState()
            ._hydrate(DEFAULT_BELGIAN_TAX_PROFILE, {}, {});
    });
    afterEach(() => vi.restoreAllMocks());
    it("explains missing profile data and prevents recording an unprepared year", () => {
        render(
            <MarkAsFiledDialog
                year={2020}
                trigger={<button>Record filing</button>}
            />,
        );
        fireEvent.click(screen.getByText("Record filing"));
        expect(screen.getByRole("status").textContent).toBe(
            "tax.markFiled.prerequisite",
        );
        expect(
            screen.getByRole("button", { name: "tax.markFiled.confirm" }),
        ).toBeDisabled();
    });
    it("requires confirmation and records the optional reference for the live profile year", async () => {
        let resolveSave!: () => void;
        vi.mocked(apiClient.saveSettings).mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveSave = resolve;
                }),
        );
        const year = DEFAULT_BELGIAN_TAX_PROFILE.taxYear;
        useSettingsStore.getState().updateProfile({ profileConfigured: true });
        render(
            <MarkAsFiledDialog
                year={year}
                trigger={<button>Record filing</button>}
            />,
        );
        fireEvent.click(screen.getByText("Record filing"));
        expect(useSettingsStore.getState().isYearFiled(year)).toBe(false);
        fireEvent.change(
            screen.getByLabelText("tax.markFiled.referenceLabel"),
            { target: { value: "  synthetic-123  " } },
        );
        fireEvent.click(
            screen.getByRole("button", { name: "tax.markFiled.confirm" }),
        );
        expect(useSettingsStore.getState().isYearFiled(year)).toBe(false);
        expect(
            screen.getByRole("button", { name: "tax.markFiled.confirm" }),
        ).toBeDisabled();
        await act(async () => resolveSave());
        expect(apiClient.saveSettings).toHaveBeenCalledWith(
            expect.objectContaining({
                belgian_tax_profile: expect.any(Object),
                belgian_tax_profile_snapshots_v1: expect.objectContaining({
                    [year]: expect.any(Object),
                }),
                belgian_tax_profile_snapshot_meta_v1: expect.objectContaining({
                    [year]: expect.any(Object),
                }),
            }),
        );
        expect(
            useSettingsStore.getState().snapshotMetas[year]?.filing?.reference,
        ).toBe("synthetic-123");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    it("keeps the filing unrecorded and the dialog open when the atomic save fails", async () => {
        vi.mocked(apiClient.saveSettings).mockRejectedValue(
            new Error("conflict"),
        );
        const year = DEFAULT_BELGIAN_TAX_PROFILE.taxYear;
        useSettingsStore.getState().updateProfile({ profileConfigured: true });
        render(
            <MarkAsFiledDialog
                year={year}
                trigger={<button>Record filing</button>}
            />,
        );
        fireEvent.click(screen.getByText("Record filing"));
        fireEvent.click(
            screen.getByRole("button", { name: "tax.markFiled.confirm" }),
        );
        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "settings.saveFailed",
            ),
        );
        expect(useSettingsStore.getState().isYearFiled(year)).toBe(false);
        expect(useSettingsStore.getState().snapshots[year]).toBeUndefined();
        expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
});
