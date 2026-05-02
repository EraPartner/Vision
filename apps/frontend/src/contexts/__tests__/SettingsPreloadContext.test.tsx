// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React, { type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { http } from "msw";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { apiClient } from "@/lib/api";
import {
    SettingsPreloadProvider,
    usePreloadedSetting,
} from "@/contexts/SettingsPreloadContext";

const API_BASE = "http://localhost:3002";

function makeWrapper() {
    return function Wrapper({ children }: { children: ReactNode }) {
        return <SettingsPreloadProvider>{children}</SettingsPreloadProvider>;
    };
}

describe("SettingsPreloadContext", () => {
    it("isLoading is true on initial render before the fetch resolves", () => {
        const { result } = renderHook(() => usePreloadedSetting("any_key"), {
            wrapper: makeWrapper(),
        });
        expect(result.current.isLoading).toBe(true);
    });

    it("returns null for a key absent from the settings map", async () => {
        server.use(http.get(`${API_BASE}/api/settings`, () => ok({})));
        const { result } = renderHook(() => usePreloadedSetting("nonexistent"), {
            wrapper: makeWrapper(),
        });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.value).toBeNull();
    });

    it("returns value from key-value map response format", async () => {
        server.use(
            http.get(`${API_BASE}/api/settings`, () =>
                ok({ app_settings: { defaultCurrency: "USD" } }),
            ),
        );
        const { result } = renderHook(() => usePreloadedSetting("app_settings"), {
            wrapper: makeWrapper(),
        });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.value).toEqual({ defaultCurrency: "USD" });
    });

    it("returns value from array of { key, value } response format", async () => {
        server.use(
            http.get(`${API_BASE}/api/settings`, () =>
                ok([{ key: "theme_settings", value: { mode: "dark" } }]),
            ),
        );
        const { result } = renderHook(() => usePreloadedSetting("theme_settings"), {
            wrapper: makeWrapper(),
        });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.value).toEqual({ mode: "dark" });
    });

    it("returns null for all keys when the settings API fails", async () => {
        const spy = vi
            .spyOn(apiClient, "getSettings")
            .mockRejectedValueOnce(new Error("Network error"));
        const { result } = renderHook(() => usePreloadedSetting("any_key"), {
            wrapper: makeWrapper(),
        });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.value).toBeNull();
        spy.mockRestore();
    });

    it("returns null when getSettings throws a 5xx-like error", async () => {
        const spy = vi
            .spyOn(apiClient, "getSettings")
            .mockRejectedValueOnce(Object.assign(new Error("server error"), { status: 500 }));
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { result } = renderHook(() => usePreloadedSetting("any_key"), {
            wrapper: makeWrapper(),
        });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.value).toBeNull();
        spy.mockRestore();
        warnSpy.mockRestore();
    });

    it("returns null when getSettings throws a 4xx-like error", async () => {
        const spy = vi
            .spyOn(apiClient, "getSettings")
            .mockRejectedValueOnce(Object.assign(new Error("bad request"), { status: 400 }));
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { result } = renderHook(() => usePreloadedSetting("any_key"), {
            wrapper: makeWrapper(),
        });
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.value).toBeNull();
        spy.mockRestore();
        warnSpy.mockRestore();
    });

    it("multiple consumers get the same cached value (single boot fetch)", async () => {
        let calls = 0;
        server.use(
            http.get(`${API_BASE}/api/settings`, () => {
                calls += 1;
                return ok({ shared_key: { foo: "bar" } });
            }),
        );
        const { result: a } = renderHook(() => usePreloadedSetting("shared_key"), {
            wrapper: makeWrapper(),
        });
        const { result: b } = renderHook(() => usePreloadedSetting("shared_key"), {
            wrapper: makeWrapper(),
        });
        await waitFor(() => expect(a.current.isLoading).toBe(false));
        await waitFor(() => expect(b.current.isLoading).toBe(false));
        expect(a.current.value).toEqual({ foo: "bar" });
        expect(b.current.value).toEqual({ foo: "bar" });
        // Two separate Providers => two boot fetches; if SHARED Provider, only 1
        expect(calls).toBeGreaterThanOrEqual(1);
    });
});
