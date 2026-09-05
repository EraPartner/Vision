// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BELGIAN_TAX_PROFILE } from "@/stores/belgianTaxStore";
import type { BelgianTaxProfile } from "@/lib/belgianTax";

const testState = vi.hoisted(() => ({
    profile: undefined as BelgianTaxProfile | undefined,
    snapshots: {},
    snapshotMetas: {},
    years: [
        {
            year: 2026,
            isCurrent: true,
            hasSnapshot: false,
            hasTransactions: true,
            isFiled: false,
            hasFrozenCalculation: false,
        },
        {
            year: 2025,
            isCurrent: false,
            hasSnapshot: false,
            hasTransactions: true,
            isFiled: false,
            hasFrozenCalculation: false,
        },
        {
            year: 2024,
            isCurrent: false,
            hasSnapshot: false,
            hasTransactions: true,
            isFiled: false,
            hasFrozenCalculation: false,
        },
    ],
}));
const spies = vi.hoisted(() => ({ compute: vi.fn() }));

vi.mock("@/lib/belgianTax", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/belgianTax")>();
    return {
        ...actual,
        computeBelgianPIT: (profile: BelgianTaxProfile) => {
            spies.compute(profile);
            return actual.computeBelgianPIT(profile);
        },
    };
});

vi.mock("@/contexts/BelgianTaxProfileContext", () => ({
    useBelgianTaxProfile: (selector: (state: object) => unknown) =>
        selector({
            viewedYear: 2026,
            setViewedYear: vi.fn(),
            profile: testState.profile,
            snapshots: testState.snapshots,
            snapshotMetas: testState.snapshotMetas,
        }),
}));
vi.mock("@/hooks/useAvailableTaxYears", () => ({
    useAvailableTaxYears: () => testState.years,
}));
vi.mock("@/stores/hydration/LanguageHydration", () => ({
    useLanguage: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
    useCurrencyFormatter: () => (value: number) => String(value),
    usePercentFormatter: () => (value: number) => String(value),
}));

import { MultiYearTrendStrip } from "@/features/tax/MultiYearTrendStrip";

describe("MultiYearTrendStrip calculation scheduling", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        testState.profile = { ...DEFAULT_BELGIAN_TAX_PROFILE };
        spies.compute.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("coalesces rapid profile edits before recomputing every displayed year", () => {
        const { rerender } = render(<MultiYearTrendStrip />);
        const initialCalls = spies.compute.mock.calls.length;

        testState.profile = {
            ...testState.profile!,
            grossAnnualIncome: 10_000,
        };
        rerender(<MultiYearTrendStrip />);
        testState.profile = { ...testState.profile, grossAnnualIncome: 20_000 };
        rerender(<MultiYearTrendStrip />);
        expect(spies.compute).toHaveBeenCalledTimes(initialCalls);

        act(() => vi.advanceTimersByTime(300));
        expect(spies.compute).toHaveBeenCalledTimes(
            initialCalls + testState.years.length,
        );
    });
});
