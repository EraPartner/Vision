// @vitest-environment jsdom
/**
 * Global mutation-error backstop (GlobalMutationErrorToaster).
 *
 * Verifies the three contracts:
 *  1. a mutation WITHOUT `onError` gets a localized toast (mapped copy, never
 *     the raw transport/backend message for machine-generated shapes),
 *  2. a mutation WITH a hook-level `onError` is left alone (no double toast),
 *  3. `meta.suppressErrorToast` silences the backstop for call sites that
 *     surface errors themselves (mutateAsync + catch, inline rendering).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";

import { createLanguageQueryWrapper } from "@/test/queryWrapper";
import { ApiClientError } from "@/lib/api/client";
import { ApiErrorCode } from "@vision/types";
import en from "@/locales/en";
import { GlobalMutationErrorToaster } from "@/components/shared/GlobalMutationErrorToaster";

vi.mock("sonner", () => ({
    toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
import { toast } from "sonner";

/** LanguageQueryWrapper with the backstop toaster mounted alongside the hook under test. */
function makeWrapper() {
    const Base = createLanguageQueryWrapper();
    return function BackstopWrapper({ children }: { children: ReactNode }) {
        return createElement(Base, null, createElement(GlobalMutationErrorToaster), children);
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(toast.error).mockClear();
});

/** Title + description of the most recent `toast.error(...)` call. */
function lastErrorToast(): { title: unknown; description: unknown } {
    const call = vi.mocked(toast.error).mock.calls.at(-1);
    return { title: call?.[0], description: (call?.[1] as { description?: unknown } | undefined)?.description };
}

describe("GlobalMutationErrorToaster", () => {
    it("toasts mapped localized copy when an onError-less mutation fails with a 5xx", async () => {
        const { result } = renderHook(
            () =>
                useMutation({
                    mutationFn: () =>
                        Promise.reject(
                            new ApiClientError({
                                status: 500,
                                code: ApiErrorCode.INTERNAL_SERVER_ERROR,
                                message: "Traceback (most recent call last): boom",
                            }),
                        ),
                }),
            { wrapper: makeWrapper() },
        );

        await act(async () => {
            result.current.mutate(undefined);
        });

        await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
        const { title, description } = lastErrorToast();
        expect(title).toBe(en["common.error"]);
        expect(description).toBe(en["apiError.server"]);
        expect(description).not.toContain("Traceback");
    });

    it("shows humanized network copy instead of the browser's raw fetch error", async () => {
        const { result } = renderHook(
            () =>
                useMutation({
                    mutationFn: () => Promise.reject(new TypeError("Failed to fetch")),
                }),
            { wrapper: makeWrapper() },
        );

        await act(async () => {
            result.current.mutate(undefined);
        });

        await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
        const { description } = lastErrorToast();
        expect(description).toBe(en["apiError.network"]);
        expect(description).not.toBe("Failed to fetch");
    });

    it("passes an authored backend 4xx detail through as the description", async () => {
        const authored = "statement_balance_date is required when a statement balance is set";
        const { result } = renderHook(
            () =>
                useMutation({
                    mutationFn: () =>
                        Promise.reject(
                            new ApiClientError({
                                status: 400,
                                code: ApiErrorCode.VALIDATION_ERROR,
                                message: authored,
                            }),
                        ),
                }),
            { wrapper: makeWrapper() },
        );

        await act(async () => {
            result.current.mutate(undefined);
        });

        await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
        expect(lastErrorToast().description).toBe(authored);
    });

    it("stays quiet when the mutation has a hook-level onError (no double toast)", async () => {
        const onError = vi.fn();
        const { result } = renderHook(
            () =>
                useMutation({
                    mutationFn: () => Promise.reject(new Error("boom")),
                    onError,
                }),
            { wrapper: makeWrapper() },
        );

        await act(async () => {
            result.current.mutate(undefined);
        });

        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(onError).toHaveBeenCalledTimes(1);
        expect(toast.error).not.toHaveBeenCalled();
    });

    it("stays quiet for meta.suppressErrorToast mutations handled via mutateAsync + catch", async () => {
        const { result } = renderHook(
            () =>
                useMutation({
                    mutationFn: () => Promise.reject(new Error("boom")),
                    meta: { suppressErrorToast: true },
                }),
            { wrapper: makeWrapper() },
        );

        let caught: unknown;
        await act(async () => {
            try {
                await result.current.mutateAsync(undefined);
            } catch (err) {
                caught = err;
            }
        });

        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(caught).toEqual(new Error("boom"));
        expect(toast.error).not.toHaveBeenCalled();
    });
});
