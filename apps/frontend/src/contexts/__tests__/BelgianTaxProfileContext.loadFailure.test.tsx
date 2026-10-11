// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { http } from "msw";
import { server } from "@/test/msw/server";
import { ok, settingsWithBaselines } from "@/test/msw/handlers";
import { apiClient } from "@/lib/api";
import logger from "@/lib/logger";
import { SettingsPreloadProvider } from "@/contexts/SettingsPreloadContext";
import {
    BelgianTaxProfileProvider,
    useBelgianTaxProfile,
} from "@/contexts/BelgianTaxProfileContext";

vi.mock("@/lib/belgianTax/loadHouseholdRuntime", () => ({
    loadHouseholdRuntime: vi.fn(() =>
        Promise.reject(new Error("Failed to fetch dynamically imported module")),
    ),
}));

const API_BASE = "http://localhost:3002";

function Wrapper({ children }: { children: ReactNode }) {
    return (
        <SettingsPreloadProvider>
            <BelgianTaxProfileProvider>{children}</BelgianTaxProfileProvider>
        </SettingsPreloadProvider>
    );
}

describe("BelgianTaxProfileContext when the household engine fails to load", () => {
    beforeEach(() => {
        server.use(
            http.get(`${API_BASE}/api/settings`, () =>
                ok(
                    settingsWithBaselines({
                        belgian_tax_profile: { grossAnnualIncome: 60_000 },
                    }),
                ),
            ),
        );
        vi.spyOn(apiClient, "saveSetting").mockResolvedValue(
            undefined as never,
        );
        vi.spyOn(logger, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("clears loading, exposes the error state and writes nothing", async () => {
        const { result } = renderHook(() => useBelgianTaxProfile(), {
            wrapper: Wrapper,
        });
        await waitFor(() =>
            expect(result.current.householdLoadFailed).toBe(true),
        );
        expect(result.current.isLoading).toBe(false);
        expect(result.current.household).toBeNull();
        expect(logger.error).toHaveBeenCalledWith(
            "Failed to load the Belgian tax household engine:",
            expect.any(Error),
        );

        act(() => result.current.updateProfile({ grossAnnualIncome: 1 }));
        act(() => result.current.freezeCalculation(2024));
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 550));
        });
        expect(apiClient.saveSetting).not.toHaveBeenCalled();
    });
});
