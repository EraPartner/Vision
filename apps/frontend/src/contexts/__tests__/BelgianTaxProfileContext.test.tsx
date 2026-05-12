// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { type ReactNode } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { http } from "msw";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { apiClient } from "@/lib/api";
import { SettingsPreloadProvider } from "@/contexts/SettingsPreloadContext";
import {
    BelgianTaxProfileProvider,
    useBelgianTaxProfile,
} from "@/contexts/BelgianTaxProfileContext";

const API_BASE = "http://localhost:3002";

function makeWrapper() {
    return function Wrapper({ children }: { children: ReactNode }) {
        return (
            <SettingsPreloadProvider>
                <BelgianTaxProfileProvider>{children}</BelgianTaxProfileProvider>
            </SettingsPreloadProvider>
        );
    };
}

describe("BelgianTaxProfileContext", () => {
    beforeEach(() => {
        server.use(http.get(`${API_BASE}/api/settings`, () => ok({})));
        vi.spyOn(apiClient, "saveSetting").mockResolvedValue(undefined as never);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("throws when used outside BelgianTaxProfileProvider", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(() => renderHook(() => useBelgianTaxProfile())).toThrow(
            "useBelgianTaxProfile must be used within BelgianTaxProfileProvider",
        );
        spy.mockRestore();
    });

    it("isLoading is true on initial render before preload resolves", () => {
        const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
        expect(result.current.isLoading).toBe(true);
    });

    it("isLoading becomes false after preload resolves", async () => {
        const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
    });

    it("default profile has grossAnnualIncome of 0", async () => {
        const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.profile.grossAnnualIncome).toBe(0);
        expect(result.current.profile.dependentChildren).toBe(0);
    });

    it("updateProfile merges partial updates into the current profile", async () => {
        const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        act(() => result.current.updateProfile({ grossAnnualIncome: 50000 }));
        expect(result.current.profile.grossAnnualIncome).toBe(50000);
        expect(result.current.profile.dependentChildren).toBe(0);
    });

    it("resetProfile restores the default profile", async () => {
        const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        act(() => result.current.updateProfile({ grossAnnualIncome: 80000 }));
        act(() => result.current.resetProfile());
        expect(result.current.profile.grossAnnualIncome).toBe(0);
    });

    it("calculation is always defined", async () => {
        const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.calculation).toBeDefined();
    });

    it("merges preloaded profile data with defaults", async () => {
        server.use(
            http.get(`${API_BASE}/api/settings`, () =>
                ok({ belgian_tax_profile: { grossAnnualIncome: 60000, region: "brussels" } }),
            ),
        );
        const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.profile.grossAnnualIncome).toBe(60000);
        expect(result.current.profile.region).toBe("brussels");
        expect(result.current.profile.employmentType).toBe("employee");
    });

    describe("historical year viewer", () => {
        it("defaults viewedYear to the live profile's taxYear", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            expect(result.current.viewedYear).toBe(result.current.profile.taxYear);
            expect(result.current.isViewingHistorical).toBe(false);
        });

        it("setViewedYear marks isViewingHistorical when year differs from the live profile", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            const liveYear = result.current.profile.taxYear;
            act(() => result.current.setViewedYear(liveYear - 1));
            expect(result.current.viewedYear).toBe(liveYear - 1);
            expect(result.current.isViewingHistorical).toBe(true);
        });

        it("auto-snapshots the outgoing profile when taxYear advances", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            const startYear = result.current.profile.taxYear;
            act(() => result.current.updateProfile({ grossAnnualIncome: 50000 }));
            act(() => result.current.updateProfile({ taxYear: startYear + 1 }));
            expect(result.current.snapshots[startYear]).toBeDefined();
            expect(result.current.snapshots[startYear].grossAnnualIncome).toBe(50000);
            expect(result.current.snapshots[startYear].taxYear).toBe(startYear);
            // The live profile carries the new year and existing values.
            expect(result.current.profile.taxYear).toBe(startYear + 1);
            expect(result.current.profile.grossAnnualIncome).toBe(50000);
        });

        it("does not overwrite an existing snapshot on rollover", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            const startYear = result.current.profile.taxYear;
            act(() => result.current.updateProfile({ grossAnnualIncome: 50000 }));
            // First rollover seeds the snapshot.
            act(() => result.current.updateProfile({ taxYear: startYear + 1 }));
            // Update live profile, then roll back to startYear and back forward — the
            // existing snapshot must survive (we never archive a *newer* state on top).
            act(() => result.current.updateProfile({ grossAnnualIncome: 99999 }));
            act(() => result.current.updateProfile({ taxYear: startYear }));
            act(() => result.current.updateProfile({ taxYear: startYear + 1 }));
            expect(result.current.snapshots[startYear].grossAnnualIncome).toBe(50000);
        });

        it("does not auto-snapshot when taxYear decreases", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            const startYear = result.current.profile.taxYear;
            act(() => result.current.updateProfile({ taxYear: startYear - 1 }));
            expect(result.current.snapshots[startYear]).toBeUndefined();
        });

        it("profileForYear returns the snapshot when present", async () => {
            server.use(
                http.get(`${API_BASE}/api/settings`, () =>
                    ok({
                        belgian_tax_profile: { taxYear: 2026, grossAnnualIncome: 60000 },
                        belgian_tax_profile_snapshots_v1: {
                            2024: { ...{ taxYear: 2024, grossAnnualIncome: 45000, region: "wallonia" } },
                        },
                    }),
                ),
            );
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            const snapshot = result.current.profileForYear(2024);
            expect(snapshot.taxYear).toBe(2024);
            expect(snapshot.grossAnnualIncome).toBe(45000);
            expect(snapshot.region).toBe("wallonia");
        });

        it("profileForYear falls back to live profile with overridden year when no snapshot", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            act(() => result.current.updateProfile({ grossAnnualIncome: 70000 }));
            const fallback = result.current.profileForYear(2022);
            expect(fallback.taxYear).toBe(2022);
            expect(fallback.grossAnnualIncome).toBe(70000);
        });

        it("createSnapshotFromLive seeds a snapshot without touching existing ones", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            act(() => result.current.updateProfile({ grossAnnualIncome: 55000 }));
            act(() => result.current.createSnapshotFromLive(2023));
            expect(result.current.snapshots[2023]).toBeDefined();
            expect(result.current.snapshots[2023].taxYear).toBe(2023);
            expect(result.current.snapshots[2023].grossAnnualIncome).toBe(55000);
            // Re-seeding is a no-op.
            act(() => result.current.updateProfile({ grossAnnualIncome: 99999 }));
            act(() => result.current.createSnapshotFromLive(2023));
            expect(result.current.snapshots[2023].grossAnnualIncome).toBe(55000);
        });

        it("updateSnapshot patches an existing snapshot and forces taxYear to remain pinned", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            act(() => result.current.createSnapshotFromLive(2024));
            // Attempt to set a different taxYear via the patch — it must be coerced back.
            act(() => result.current.updateSnapshot(2024, { grossAnnualIncome: 33000, taxYear: 2099 }));
            expect(result.current.snapshots[2024].grossAnnualIncome).toBe(33000);
            expect(result.current.snapshots[2024].taxYear).toBe(2024);
        });

        it("updateSnapshot is a no-op when the snapshot does not exist", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            act(() => result.current.updateSnapshot(2019, { grossAnnualIncome: 1234 }));
            expect(result.current.snapshots[2019]).toBeUndefined();
        });

        it("calculationForYear recomputes via computeBelgianPIT with the resolved profile", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            act(() => result.current.updateProfile({ grossAnnualIncome: 60000 }));
            act(() => result.current.createSnapshotFromLive(2023));
            act(() => result.current.updateSnapshot(2023, { grossAnnualIncome: 40000 }));
            const liveYear = result.current.profile.taxYear;
            const calc2023 = result.current.calculationForYear(2023);
            const calcLive = result.current.calculationForYear(liveYear);
            expect(calc2023.grossIncome).toBe(40000);
            expect(calcLive.grossIncome).toBe(60000);
        });
    });

    describe("snapshot meta: freeze / file / audit history", () => {
        it("appends a 'created' history entry when a snapshot is seeded", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            act(() => result.current.createSnapshotFromLive(2023));
            const history = result.current.getSnapshotHistory(2023);
            expect(history).toHaveLength(1);
            expect(history[0].kind).toBe("created");
            expect(typeof history[0].at).toBe("string");
        });

        it("appends a 'created' entry on auto-rollover", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            const startYear = result.current.profile.taxYear;
            act(() => result.current.updateProfile({ grossAnnualIncome: 50000 }));
            act(() => result.current.updateProfile({ taxYear: startYear + 1 }));
            const history = result.current.getSnapshotHistory(startYear);
            expect(history).toHaveLength(1);
            expect(history[0].kind).toBe("created");
        });

        it("appends a 'patched' entry with the diff when a snapshot is updated", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            act(() => result.current.createSnapshotFromLive(2023));
            act(() => result.current.updateSnapshot(2023, { grossAnnualIncome: 55555, region: "brussels" }));
            const history = result.current.getSnapshotHistory(2023);
            expect(history).toHaveLength(2);
            expect(history[1].kind).toBe("patched");
            expect(history[1].changes).toEqual({ grossAnnualIncome: 55555, region: "brussels" });
        });

        it("does not append a 'patched' entry for a year with no snapshot", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            act(() => result.current.updateSnapshot(2019, { grossAnnualIncome: 1234 }));
            expect(result.current.getSnapshotHistory(2019)).toEqual([]);
        });

        it("does not record a 'patched' entry when the only diff field is taxYear", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            act(() => result.current.createSnapshotFromLive(2023));
            act(() => result.current.updateSnapshot(2023, { taxYear: 2099 }));
            // Only the 'created' entry — the taxYear-only patch is coerced and skipped.
            expect(result.current.getSnapshotHistory(2023)).toHaveLength(1);
        });

        it("freezeCalculation captures the current calc and appends 'frozen'", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            act(() => result.current.updateProfile({ grossAnnualIncome: 60000 }));
            act(() => result.current.createSnapshotFromLive(2023));
            act(() => result.current.updateSnapshot(2023, { grossAnnualIncome: 40000 }));
            act(() => result.current.freezeCalculation(2023));
            const frozen = result.current.getFrozenCalculation(2023);
            expect(frozen).not.toBeNull();
            expect(frozen!.grossIncome).toBe(40000);
            const lastEntry = result.current.getSnapshotHistory(2023).at(-1)!;
            expect(lastEntry.kind).toBe("frozen");
        });

        it("displayCalculationForYear returns the frozen calc when one exists", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            act(() => result.current.updateProfile({ grossAnnualIncome: 60000 }));
            act(() => result.current.createSnapshotFromLive(2023));
            act(() => result.current.updateSnapshot(2023, { grossAnnualIncome: 40000 }));
            act(() => result.current.freezeCalculation(2023));
            // Mutate the snapshot AFTER freezing — display calc should keep the frozen value,
            // live calc should reflect the new input. This is the engine-drift protection.
            act(() => result.current.updateSnapshot(2023, { grossAnnualIncome: 70000 }));
            expect(result.current.displayCalculationForYear(2023).grossIncome).toBe(40000);
            expect(result.current.calculationForYear(2023).grossIncome).toBe(70000);
        });

        it("unfreezeCalculation clears the frozen calc and falls back to live", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            act(() => result.current.updateProfile({ grossAnnualIncome: 60000 }));
            act(() => result.current.createSnapshotFromLive(2023));
            act(() => result.current.freezeCalculation(2023));
            expect(result.current.getFrozenCalculation(2023)).not.toBeNull();
            act(() => result.current.unfreezeCalculation(2023));
            expect(result.current.getFrozenCalculation(2023)).toBeNull();
            const lastEntry = result.current.getSnapshotHistory(2023).at(-1)!;
            expect(lastEntry.kind).toBe("unfrozen");
        });

        it("markYearAsFiled sets filing, freezes calc, and appends 'filed'", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            act(() => result.current.updateProfile({ grossAnnualIncome: 60000 }));
            act(() => result.current.createSnapshotFromLive(2023));
            act(() => result.current.markYearAsFiled(2023, "Tax-on-Web 2024-XYZ"));
            expect(result.current.isYearFiled(2023)).toBe(true);
            const meta = result.current.metaForYear(2023);
            expect(meta?.filing?.reference).toBe("Tax-on-Web 2024-XYZ");
            expect(meta?.frozenCalculation).toBeDefined();
            const lastEntry = result.current.getSnapshotHistory(2023).at(-1)!;
            expect(lastEntry.kind).toBe("filed");
            expect(lastEntry.reference).toBe("Tax-on-Web 2024-XYZ");
        });

        it("markYearAsFiled preserves an existing frozen calculation", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            act(() => result.current.updateProfile({ grossAnnualIncome: 60000 }));
            act(() => result.current.createSnapshotFromLive(2023));
            // Freeze with one income value, then change the snapshot, then file.
            act(() => result.current.freezeCalculation(2023));
            const frozenAtFreeze = result.current.getFrozenCalculation(2023)!.grossIncome;
            act(() => result.current.updateSnapshot(2023, { grossAnnualIncome: 99999 }));
            act(() => result.current.markYearAsFiled(2023));
            expect(result.current.getFrozenCalculation(2023)!.grossIncome).toBe(frozenAtFreeze);
        });

        it("unmarkYearAsFiled clears filing but keeps frozen calc", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            act(() => result.current.createSnapshotFromLive(2023));
            act(() => result.current.markYearAsFiled(2023));
            expect(result.current.isYearFiled(2023)).toBe(true);
            act(() => result.current.unmarkYearAsFiled(2023));
            expect(result.current.isYearFiled(2023)).toBe(false);
            expect(result.current.getFrozenCalculation(2023)).not.toBeNull();
            const lastEntry = result.current.getSnapshotHistory(2023).at(-1)!;
            expect(lastEntry.kind).toBe("unfiled");
        });

        it("freeze on a year without a snapshot still records meta and history", async () => {
            const { result } = renderHook(() => useBelgianTaxProfile(), { wrapper: makeWrapper() });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            // No snapshot for 2022 — should freeze the estimate calc.
            act(() => result.current.updateProfile({ grossAnnualIncome: 55000 }));
            act(() => result.current.freezeCalculation(2022));
            expect(result.current.getFrozenCalculation(2022)).not.toBeNull();
            expect(result.current.getFrozenCalculation(2022)!.grossIncome).toBe(55000);
        });
    });
});
