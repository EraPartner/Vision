// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModelResidency } from "@/hooks/useModelResidency";
import { server } from "@/test/msw/server";
import { noContent } from "@/test/msw/handlers";

const API_BASE = "http://localhost:3002";

// Handlers only record the request; nothing is fetched inside a handler, so
// nothing can outlive the test's teardown.
let posts: string[] = [];

beforeEach(() => {
    posts = [];
    server.use(
        http.post(`${API_BASE}/api/ai/model/warm`, async ({ request }) => {
            const body = (await request.json()) as { model: string };
            posts.push(`warm:${body.model}`);
            return noContent();
        }),
        http.post(`${API_BASE}/api/ai/model/release`, async ({ request }) => {
            const body = (await request.json()) as { model: string };
            posts.push(`release:${body.model}`);
            return noContent();
        }),
    );
    // Fake only the timers the hook uses; MSW and fetch stay real.
    vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
});

afterEach(async () => {
    // Unmount first: the release it sends must land before the next test.
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await new Promise((resolve) => setTimeout(resolve, 20));
});

async function settle() {
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0));
}

describe("useModelResidency", () => {
    it("warms the model 2 s after mount, not before", async () => {
        renderHook(() => useModelResidency("llama3.1:8b", true));
        await vi.advanceTimersByTimeAsync(1_999);
        expect(posts).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        await settle();
        expect(posts).toEqual(["warm:llama3.1:8b"]);
    });

    it("re-warms every 4 minutes while visible and skips hidden ticks", async () => {
        renderHook(() => useModelResidency("m", true));
        await vi.advanceTimersByTimeAsync(2_000);
        await vi.waitFor(() => expect(posts).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(4 * 60_000);
        await vi.waitFor(() => expect(posts).toHaveLength(2));

        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        await vi.advanceTimersByTimeAsync(4 * 60_000);
        expect(posts).toHaveLength(2);
    });

    it("releases on unmount and clears its timers", async () => {
        const { unmount } = renderHook(() => useModelResidency("m", true));
        await vi.advanceTimersByTimeAsync(2_000);
        await vi.waitFor(() => expect(posts).toEqual(["warm:m"]));
        unmount();
        await vi.waitFor(() => expect(posts).toEqual(["warm:m", "release:m"]));
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(posts).toEqual(["warm:m", "release:m"]);
    });

    it("releases the previous model when the model changes", async () => {
        const { rerender } = renderHook(
            ({ model }) => useModelResidency(model, true),
            { initialProps: { model: "a" } },
        );
        await vi.advanceTimersByTimeAsync(2_000);
        await vi.waitFor(() => expect(posts).toEqual(["warm:a"]));
        rerender({ model: "b" });
        await vi.waitFor(() => expect(posts).toContain("release:a"));
        await vi.advanceTimersByTimeAsync(2_000);
        await vi.waitFor(() => expect(posts).toContain("warm:b"));
    });

    it("sends nothing when unmounted before the first warm", async () => {
        const { unmount } = renderHook(() => useModelResidency("m", true));
        await vi.advanceTimersByTimeAsync(1_000);
        unmount();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(posts).toEqual([]);
    });

    it("skips the Apple model, a missing model and an unreachable Ollama", async () => {
        renderHook(() => useModelResidency("apple-foundation", true));
        renderHook(() => useModelResidency(null, true));
        renderHook(() => useModelResidency("m", false));
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(posts).toEqual([]);
    });
});
