// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
    getSetting: vi.fn(),
    saveSetting: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ apiClient: apiMocks }));
vi.mock("@/lib/logger", () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

let useWidgetVisibility: typeof import("@/hooks/useWidgetVisibility").useWidgetVisibility;
let useSettingsStore: typeof import("@/stores/settingsStore").useSettingsStore;
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

describe("useWidgetVisibility persistence feedback", () => {
    beforeEach(async () => {
        vi.resetModules();
        ({ useWidgetVisibility } = await import("@/hooks/useWidgetVisibility"));
        ({ useSettingsStore } = await import("@/stores/settingsStore"));
        vi.useFakeTimers();
        vi.clearAllMocks();
        apiMocks.getSetting.mockResolvedValue({ value: {} });
        apiMocks.saveSetting.mockResolvedValue(undefined);
        useSettingsStore.setState({ settingsSaveErrorNonce: 0 });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("signals rejected saves without rolling back local visibility", async () => {
        const { result } = renderHook(() =>
            useWidgetVisibility("dashboard-save-feedback", [
                { id: "summary", defaultVisible: true },
            ]),
        );

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
            await Promise.resolve();
        });
        expect(result.current.isLoaded).toBe(true);

        act(() => result.current.setWidgetVisible("summary", false));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });
        expect(apiMocks.saveSetting).toHaveBeenCalledTimes(1);
        expect(useSettingsStore.getState().settingsSaveErrorNonce).toBe(0);

        apiMocks.saveSetting.mockRejectedValueOnce(new Error("save failed"));
        act(() => result.current.setWidgetVisible("summary", true));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });

        expect(result.current.isVisible("summary")).toBe(true);
        expect(useSettingsStore.getState().settingsSaveErrorNonce).toBe(1);
    });
    it("persists a toggle after the page unmounts and combines changes from another page", async () => {
        const first = renderHook(() =>
            useWidgetVisibility("navigate-a", [{ id: "one" }]),
        );
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        act(() => first.result.current.setWidgetVisible("one", false));
        first.unmount();
        const second = renderHook(() =>
            useWidgetVisibility("navigate-b", [{ id: "two" }]),
        );
        act(() => second.result.current.setWidgetVisible("two", false));
        second.unmount();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });
        expect(apiMocks.saveSetting).toHaveBeenLastCalledWith(
            "widget_visibility",
            expect.objectContaining({
                "navigate-a": { one: false },
                "navigate-b": { two: false },
            }),
        );
    });
    it("merges edits made before hydration with untouched backend pages and widgets", async () => {
        const read = deferred<{
            value: Record<string, Record<string, boolean>>;
        }>();
        apiMocks.getSetting.mockReturnValueOnce(read.promise);
        const first = renderHook(() =>
            useWidgetVisibility("dashboard", [{ id: "summary" }]),
        );
        act(() => first.result.current.setWidgetVisible("summary", false));
        const second = renderHook(() =>
            useWidgetVisibility("statistics", [{ id: "chart" }]),
        );
        act(() => second.result.current.setWidgetVisible("chart", false));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });
        expect(apiMocks.saveSetting).not.toHaveBeenCalled();
        await act(async () => {
            read.resolve({
                value: {
                    dashboard: { summary: true, balances: false },
                    portfolioTax: { income: false },
                },
            });
        });
        expect(first.result.current.isVisible("summary")).toBe(false);
        expect(first.result.current.isLoaded).toBe(true);
        expect(second.result.current.isLoaded).toBe(true);
        first.unmount();
        second.unmount();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });
        expect(apiMocks.saveSetting).toHaveBeenCalledExactlyOnceWith(
            "widget_visibility",
            {
                dashboard: { summary: false, balances: false },
                statistics: { chart: false },
                portfolioTax: { income: false },
            },
        );
    });
    it("keeps ordered resets and all-widget edits made before hydration", async () => {
        const read = deferred<{
            value: Record<string, Record<string, boolean>>;
        }>();
        apiMocks.getSetting.mockReturnValueOnce(read.promise);
        const { result } = renderHook(() =>
            useWidgetVisibility("dashboard", [
                { id: "summary" },
                { id: "balances", defaultVisible: false },
            ]),
        );
        act(() => {
            result.current.setAllVisible(false);
            result.current.resetToDefaults();
            result.current.setWidgetVisible("summary", false);
        });
        await act(async () => {
            read.resolve({
                value: {
                    dashboard: { summary: true, balances: true },
                    statistics: { chart: false },
                },
            });
        });
        expect(result.current.isVisible("summary")).toBe(false);
        expect(result.current.isVisible("balances")).toBe(false);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });
        expect(apiMocks.saveSetting).toHaveBeenLastCalledWith(
            "widget_visibility",
            { dashboard: { summary: false }, statistics: { chart: false } },
        );
    });
    it("does not overwrite unknown data after a read failure and retries on a later edit", async () => {
        const read = deferred<{
            value: Record<string, Record<string, boolean>>;
        }>();
        apiMocks.getSetting.mockReturnValueOnce(read.promise);
        const { result } = renderHook(() =>
            useWidgetVisibility("dashboard", [
                { id: "summary" },
                { id: "balances" },
            ]),
        );
        act(() => result.current.setWidgetVisible("summary", false));
        await act(async () => {
            read.reject(new Error("offline"));
        });
        expect(result.current.isLoaded).toBe(false);
        expect(result.current.isVisible("summary")).toBe(false);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });
        expect(apiMocks.saveSetting).not.toHaveBeenCalled();
        expect(useSettingsStore.getState().settingsSaveErrorNonce).toBe(1);
        apiMocks.getSetting.mockResolvedValueOnce({
            value: { statistics: { chart: false } },
        });
        await act(async () =>
            result.current.setWidgetVisible("balances", false),
        );
        expect(result.current.isLoaded).toBe(true);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });
        expect(apiMocks.saveSetting).toHaveBeenCalledExactlyOnceWith(
            "widget_visibility",
            {
                dashboard: { summary: false, balances: false },
                statistics: { chart: false },
            },
        );
    });
    it("retains pending edits for retry after unmount and rejects malformed saved maps", async () => {
        apiMocks.getSetting.mockResolvedValueOnce({
            value: { statistics: "invalid" },
        });
        const first = renderHook(() =>
            useWidgetVisibility("dashboard", [{ id: "summary" }]),
        );
        act(() => first.result.current.resetToDefaults());
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });
        expect(apiMocks.saveSetting).not.toHaveBeenCalled();
        first.unmount();
        apiMocks.getSetting.mockResolvedValueOnce({
            value: {
                dashboard: { summary: false },
                statistics: { chart: false },
            },
        });
        const second = renderHook(() =>
            useWidgetVisibility("dashboard", [{ id: "summary" }]),
        );
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });
        expect(second.result.current.isVisible("summary")).toBe(true);
        expect(apiMocks.saveSetting).toHaveBeenCalledExactlyOnceWith(
            "widget_visibility",
            { statistics: { chart: false } },
        );
    });
});
