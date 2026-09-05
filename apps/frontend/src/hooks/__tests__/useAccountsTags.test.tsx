// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { createLanguageQueryWrapper } from "@/test/queryWrapper";
import { apiClient } from "@/lib/api";
import {
    useAccounts,
    useCreateAccount,
    useUpdateAccount,
    useMergeAccounts,
    useDeleteAccount,
} from "@/hooks/useAccounts";
import { useTags, useCreateTag } from "@/hooks/useTags";

vi.mock("sonner", () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));
import { toast } from "sonner";

const makeFullWrapper = createLanguageQueryWrapper;

afterEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// useAccounts (query)
// ---------------------------------------------------------------------------

describe("useAccounts", () => {
    it("returns accounts on success", async () => {
        vi.spyOn(apiClient, "getAccounts").mockResolvedValue({
            items: [{ id: 1 }],
            total: 1,
        } as never);
        const { result } = renderHook(() => useAccounts({ active: "all" }), {
            wrapper: makeFullWrapper(),
        });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data?.items[0].id).toBe(1);
    });

    it("surfaces an error", async () => {
        vi.spyOn(apiClient, "getAccounts").mockRejectedValue(new Error("fail"));
        const { result } = renderHook(() => useAccounts(), {
            wrapper: makeFullWrapper(),
        });
        await waitFor(() => expect(result.current.isError).toBe(true));
    });
});

describe("useCreateAccount", () => {
    it("calls createAccount and toasts success on success", async () => {
        const spy = vi
            .spyOn(apiClient, "createAccount")
            .mockResolvedValue({ id: 5 } as never);
        const { result } = renderHook(() => useCreateAccount(), {
            wrapper: makeFullWrapper(),
        });
        await act(async () => {
            await result.current.mutateAsync({ name: "X" } as never);
        });
        expect(spy).toHaveBeenCalledWith({ name: "X" });
        expect(toast.success).toHaveBeenCalled();
    });

    it("toasts an error on failure (error branch)", async () => {
        vi.spyOn(apiClient, "createAccount").mockRejectedValue(
            new Error("boom"),
        );
        const { result } = renderHook(() => useCreateAccount(), {
            wrapper: makeFullWrapper(),
        });
        await act(async () => {
            await result.current
                .mutateAsync({ name: "X" } as never)
                .catch(() => {});
        });
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
    });
});

describe("useUpdateAccount", () => {
    it("calls updateAccount with id + data", async () => {
        const spy = vi
            .spyOn(apiClient, "updateAccount")
            .mockResolvedValue({ id: 3 } as never);
        const { result } = renderHook(() => useUpdateAccount(), {
            wrapper: makeFullWrapper(),
        });
        await act(async () => {
            await result.current.mutateAsync({
                id: 3,
                data: { name: "Y" } as never,
            });
        });
        expect(spy).toHaveBeenCalledWith(3, { name: "Y" });
        expect(toast.success).toHaveBeenCalledWith("Account updated");
    });

    it("toasts an error on failure", async () => {
        vi.spyOn(apiClient, "updateAccount").mockRejectedValue(
            new Error("boom"),
        );
        const { result } = renderHook(() => useUpdateAccount(), {
            wrapper: makeFullWrapper(),
        });
        await act(async () => {
            await result.current
                .mutateAsync({ id: 3, data: {} as never })
                .catch(() => {});
        });
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
    });
});

describe("useMergeAccounts", () => {
    it("calls mergeAccounts and toasts success", async () => {
        const spy = vi
            .spyOn(apiClient, "mergeAccounts")
            .mockResolvedValue({
                into: 1,
                merged: [2],
                reassigned: {},
            } as never);
        const { result } = renderHook(() => useMergeAccounts(), {
            wrapper: makeFullWrapper(),
        });
        await act(async () => {
            await result.current.mutateAsync({ targetId: 1, sourceIds: [2] });
        });
        expect(spy).toHaveBeenCalledWith(1, [2]);
        expect(toast.success).toHaveBeenCalled();
    });

    it("toasts an error on failure", async () => {
        vi.spyOn(apiClient, "mergeAccounts").mockRejectedValue(
            new Error("boom"),
        );
        const { result } = renderHook(() => useMergeAccounts(), {
            wrapper: makeFullWrapper(),
        });
        await act(async () => {
            await result.current
                .mutateAsync({ targetId: 1, sourceIds: [2] })
                .catch(() => {});
        });
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
    });

    it("invalidates the repointed trees by key, never blanket", async () => {
        const invalidateSpy = vi.spyOn(
            QueryClient.prototype,
            "invalidateQueries",
        );
        vi.spyOn(apiClient, "mergeAccounts").mockResolvedValue({
            into: 1,
            merged: [2],
            reassigned: {},
        } as never);
        const { result } = renderHook(() => useMergeAccounts(), {
            wrapper: makeFullWrapper(),
        });
        await act(async () => {
            await result.current.mutateAsync({ targetId: 1, sourceIds: [2] });
        });
        // A merge must NOT fall back to the whole-cache blanket form invalidateQueries()
        // (called with no filter) — every call carries an explicit queryKey.
        expect(invalidateSpy).toHaveBeenCalled();
        for (const call of invalidateSpy.mock.calls) {
            expect(call[0]?.queryKey).toBeDefined();
        }
        const invalidatedKeys = invalidateSpy.mock.calls.map(
            (c) => c[0]?.queryKey?.[0],
        );
        // Account-derived, transaction, planned and portfolio trees are all covered.
        for (const key of [
            "accounts",
            "net-worth",
            "transactions",
            "upcomingPlannedPayments",
            "investments",
        ]) {
            expect(invalidatedKeys).toContain(key);
        }
        invalidateSpy.mockRestore();
    });
});

describe("useDeleteAccount", () => {
    it("calls deleteAccount and toasts success", async () => {
        const spy = vi
            .spyOn(apiClient, "deleteAccount")
            .mockResolvedValue(undefined as never);
        const { result } = renderHook(() => useDeleteAccount(), {
            wrapper: makeFullWrapper(),
        });
        await act(async () => {
            await result.current.mutateAsync(9);
        });
        expect(spy).toHaveBeenCalledWith(9);
        expect(toast.success).toHaveBeenCalled();
    });

    it("toasts an error on failure", async () => {
        vi.spyOn(apiClient, "deleteAccount").mockRejectedValue(
            new Error("409"),
        );
        const { result } = renderHook(() => useDeleteAccount(), {
            wrapper: makeFullWrapper(),
        });
        await act(async () => {
            await result.current.mutateAsync(9).catch(() => {});
        });
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
    });
});

// ---------------------------------------------------------------------------
// useTags
// ---------------------------------------------------------------------------

describe("useTags", () => {
    it("returns tags on success", async () => {
        vi.spyOn(apiClient, "getTags").mockResolvedValue({
            items: [{ id: 1, slug: "t" }],
            total: 1,
        } as never);
        const { result } = renderHook(() => useTags({ is_active: true }), {
            wrapper: makeFullWrapper(),
        });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data?.items[0].slug).toBe("t");
    });
});

describe("useCreateTag", () => {
    it("calls createTag on success", async () => {
        const spy = vi
            .spyOn(apiClient, "createTag")
            .mockResolvedValue({ id: 1, slug: "t" } as never);
        const { result } = renderHook(() => useCreateTag(), {
            wrapper: makeFullWrapper(),
        });
        await act(async () => {
            await result.current.mutateAsync({ slug: "t" } as never);
        });
        expect(spy).toHaveBeenCalledWith({ slug: "t" });
    });

    it("toasts an error on failure", async () => {
        vi.spyOn(apiClient, "createTag").mockRejectedValue(new Error("boom"));
        const { result } = renderHook(() => useCreateTag(), {
            wrapper: makeFullWrapper(),
        });
        await act(async () => {
            await result.current
                .mutateAsync({ name: "t" } as never)
                .catch(() => {});
        });
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
    });
});
