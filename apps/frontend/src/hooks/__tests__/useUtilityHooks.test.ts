// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebounce } from "@/hooks/useDebounce";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useIsMobile } from "@/hooks/use-mobile";

function setupMatchMedia(innerWidth: number) {
    Object.defineProperty(window, "innerWidth", { value: innerWidth, writable: true, configurable: true });
    Object.defineProperty(window, "matchMedia", {
        writable: true,
        configurable: true,
        value: vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })),
    });
}

describe("useDebounce", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("returns initial value immediately", () => {
        const { result } = renderHook(() => useDebounce("hello", 300));
        expect(result.current).toBe("hello");
    });

    it("does not update before delay elapses", () => {
        const { result, rerender } = renderHook(
            ({ value }: { value: string }) => useDebounce(value, 300),
            { initialProps: { value: "hello" } },
        );
        rerender({ value: "world" });
        expect(result.current).toBe("hello");
    });

    it("updates after delay elapses", () => {
        const { result, rerender } = renderHook(
            ({ value }: { value: string }) => useDebounce(value, 300),
            { initialProps: { value: "hello" } },
        );
        rerender({ value: "world" });
        act(() => vi.advanceTimersByTime(300));
        expect(result.current).toBe("world");
    });

    it("resets timer on rapid value changes", () => {
        const { result, rerender } = renderHook(
            ({ value }: { value: string }) => useDebounce(value, 300),
            { initialProps: { value: "a" } },
        );
        rerender({ value: "ab" });
        act(() => vi.advanceTimersByTime(200));
        rerender({ value: "abc" });
        act(() => vi.advanceTimersByTime(200));
        expect(result.current).toBe("a");
        act(() => vi.advanceTimersByTime(100));
        expect(result.current).toBe("abc");
    });
});

describe("useOnlineStatus", () => {
    it("returns true by default", () => {
        const { result } = renderHook(() => useOnlineStatus());
        expect(result.current).toBe(true);
    });

    it("returns false after offline event", () => {
        const { result } = renderHook(() => useOnlineStatus());
        act(() => { window.dispatchEvent(new Event("offline")); });
        expect(result.current).toBe(false);
    });

    it("returns true after coming back online", () => {
        const { result } = renderHook(() => useOnlineStatus());
        act(() => { window.dispatchEvent(new Event("offline")); });
        act(() => { window.dispatchEvent(new Event("online")); });
        expect(result.current).toBe(true);
    });
});

describe("useIsMobile", () => {
    it("returns true when innerWidth is below the breakpoint", () => {
        setupMatchMedia(375);
        const { result } = renderHook(() => useIsMobile());
        expect(result.current).toBe(true);
    });

    it("returns false when innerWidth is above the breakpoint", () => {
        setupMatchMedia(1024);
        const { result } = renderHook(() => useIsMobile());
        expect(result.current).toBe(false);
    });

    it("returns false at exactly the breakpoint (768)", () => {
        setupMatchMedia(768);
        const { result } = renderHook(() => useIsMobile());
        expect(result.current).toBe(false);
    });
});
