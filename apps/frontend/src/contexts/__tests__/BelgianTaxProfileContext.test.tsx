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
});
