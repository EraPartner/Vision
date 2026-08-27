// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSettingsStore, DEFAULT_APP_SETTINGS } from "@/stores/settingsStore";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";

beforeEach(() => {
    useSettingsStore.setState({ appSettings: DEFAULT_APP_SETTINGS, isAppSettingsLoading: false });
});

describe("useChartCurrencyFormatter", () => {
    it("returns the default currency from app settings", () => {
        const { result } = renderHook(() => useChartCurrencyFormatter());
        expect(result.current.currency).toBe("EUR");
    });

    it("returns the euro symbol for EUR", () => {
        const { result } = renderHook(() => useChartCurrencyFormatter());
        expect(result.current.currencySymbol).toBe("€");
    });

    it("formatCurrency formats a number as EUR", () => {
        const { result } = renderHook(() => useChartCurrencyFormatter());
        const formatted = result.current.formatCurrency(1234.56);
        expect(formatted).toContain("1");
        expect(formatted).toContain("234");
    });

    it("formatCompact returns display and full strings", () => {
        const { result } = renderHook(() => useChartCurrencyFormatter());
        const compact = result.current.formatCompact(1_500_000);
        expect(compact.display).toBeDefined();
        expect(compact.full).toBeDefined();
        expect(typeof compact.isCompact).toBe("boolean");
    });

    it("keeps ordinary EU axis thousands bounded without losing locale ordering", () => {
        const { result } = renderHook(() => useChartCurrencyFormatter());
        expect(result.current.formatAxisCompact(1_500)).toBe("1,5k\u00a0€");
        expect(result.current.formatAxisCompact(100_000)).toBe("100k\u00a0€");
        expect(result.current.formatAxisCompact(-1_500_000)).toBe("-1,5M\u00a0€");
    });

    it("keeps US currency ordering and decimal separator on axis labels", () => {
        useSettingsStore.setState({
            appSettings: { ...DEFAULT_APP_SETTINGS, numberFormat: "us", defaultCurrency: "USD" },
        });
        const { result } = renderHook(() => useChartCurrencyFormatter());
        expect(result.current.formatAxisCompact(1_500)).toBe("$1.5k");
        expect(result.current.formatAxisCompact(100_000)).toBe("$100k");
    });

    it("reflects currency change in store", () => {
        useSettingsStore.setState({
            appSettings: { ...DEFAULT_APP_SETTINGS, defaultCurrency: "USD" },
        });
        const { result } = renderHook(() => useChartCurrencyFormatter());
        expect(result.current.currency).toBe("USD");
        expect(result.current.currencySymbol).toBe("$");
    });

    it("degrades every chart formatter instead of throwing for invalid injected settings", () => {
        useSettingsStore.setState({
            appSettings: {
                ...DEFAULT_APP_SETTINGS,
                defaultCurrency: "US",
                showDecimalPlaces: -1,
            },
        });

        const { result } = renderHook(() => useChartCurrencyFormatter());
        expect(result.current.formatCurrency(1234.56)).toBe("1234.56");
        expect(result.current.formatCompact(1234.56)).toEqual({
            display: "1234.56",
            full: "1234.56",
            isCompact: false,
            parts: [{ type: "literal", value: "1234.56" }],
        });
        expect(result.current.formatAxisCompact(1234.56)).toBe("1234.56");
    });
});
