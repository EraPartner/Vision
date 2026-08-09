// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, render } from "@testing-library/react";
import { useSettingsStore, DEFAULT_APP_SETTINGS } from "@/stores/settingsStore";
import { useCurrencyFormatter, useCurrencyPartsFormatter } from "@/hooks/useCurrencyFormatter";
import { Money } from "@/components/shared/Money";

beforeEach(() => {
    useSettingsStore.setState({ appSettings: DEFAULT_APP_SETTINGS, isAppSettingsLoading: false });
});

describe("useCurrencyPartsFormatter — malformed currency degrades like Money", () => {
    it("returns a bare-number literal instead of throwing RangeError", () => {
        // `new Intl.NumberFormat(locale, { currency: "US" })` throws RangeError:
        // a currency code must be three alphabetic characters. Without a guard
        // this escapes into the React error boundary.
        const { result } = renderHook(() => useCurrencyPartsFormatter());
        expect(() => result.current(1234.56, { currency: "US" })).not.toThrow();
        expect(result.current(1234.56, { currency: "US" })).toEqual([
            { type: "literal", value: "1234.56" },
        ]);
    });

    it("degrades to the exact same output Money produces for the same bad code", () => {
        const { result } = renderHook(() => useCurrencyPartsFormatter());
        const hookText = result.current(1234.56, { currency: "US" })
            .map((p) => p.value)
            .join("");

        const { container } = render(<Money amount={1234.56} currency="US" />);

        // Both paths must fall back to the same bare number — a code that
        // renders on one surface must not crash the other.
        expect(hookText).toBe(container.textContent);
        expect(hookText).toBe("1234.56");
    });

    it("degrades for a negative amount too, keeping the minus sign", () => {
        const { result } = renderHook(() => useCurrencyPartsFormatter());
        expect(result.current(-42.5, { currency: "US" })).toEqual([
            { type: "literal", value: "-42.5" },
        ]);
    });

    it("still formats a valid currency normally", () => {
        const { result } = renderHook(() => useCurrencyPartsFormatter());
        const parts = result.current(1234.56, { currency: "EUR" });
        expect(parts.length).toBeGreaterThan(1);
        expect(parts.some((p) => p.type === "currency" && p.value === "€")).toBe(true);
    });

    it("does not poison the cache — a valid code still works after a bad one", () => {
        const { result } = renderHook(() => useCurrencyPartsFormatter());
        result.current(1, { currency: "US" });
        const parts = result.current(1234.56, { currency: "EUR" });
        expect(parts.some((p) => p.type === "currency")).toBe(true);
    });
});

describe("useCurrencyFormatter (string path) — malformed currency degrades like the parts sibling", () => {
    it("returns the bare number instead of throwing RangeError", () => {
        // Pages pair this string formatter with the guarded parts formatter on
        // the same currency (StocksPage's fmt/fmtParts, the forecast chart axis
        // beside its odometer). Unguarded, the string path threw into the error
        // boundary and took the page down even though the parts path degraded.
        const { result } = renderHook(() => useCurrencyFormatter("US"));
        expect(() => result.current(1234.56)).not.toThrow();
        expect(result.current(1234.56)).toBe("1234.56");
    });

    it("degrades to the exact text the parts hook and Money produce for the same bad code", () => {
        const str = renderHook(() => useCurrencyFormatter()).result.current;
        const parts = renderHook(() => useCurrencyPartsFormatter()).result.current;
        const partsText = parts(1234.56, { currency: "US" })
            .map((p) => p.value)
            .join("");
        const { container } = render(<Money amount={1234.56} currency="US" />);
        expect(str(1234.56, "US")).toBe(partsText);
        expect(str(1234.56, "US")).toBe(container.textContent);
    });

    it("degrades on out-of-range decimals too, keeping sign", () => {
        const { result } = renderHook(() => useCurrencyFormatter());
        expect(result.current(-42.5, "EUR", -1)).toBe("-42.5");
        expect(result.current(1234.56, "EUR", 101)).toBe("1234.56");
    });

    it("does not poison the cache — a valid code still works after a bad one", () => {
        const { result } = renderHook(() => useCurrencyFormatter());
        result.current(1, "US");
        expect(result.current(1234.56, "EUR")).toBe("1.234,56\u00a0€");
    });

    it("still formats a valid currency normally", () => {
        const { result } = renderHook(() => useCurrencyFormatter());
        expect(result.current(1234.56, "EUR")).toBe("1.234,56\u00a0€");
        expect(result.current(1234.56, "USD", 0)).toBe("1.235\u00a0$");
    });
});
