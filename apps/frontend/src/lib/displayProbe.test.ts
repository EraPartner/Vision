/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    large: { value: true },
    builtIn: vi.fn<() => Promise<boolean | null>>(),
    focused: { value: true },
}));

vi.mock("@/lib/visualEffects", () => ({
    currentDisplayIsLarge: () => mocks.large.value,
}));
vi.mock("@/lib/api/electron", () => ({
    canCheckBuiltInDisplay: () => true,
    getDisplayIsBuiltIn: mocks.builtIn,
}));

import {
    DISPLAY_POLL_BLURRED_MS,
    DISPLAY_POLL_FOCUSED_MS,
    getDisplayIsLargeSnapshot,
    subscribeDisplayProbe,
} from "./displayProbe";

function setHidden(hidden: boolean) {
    Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
    document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
    vi.useFakeTimers();
    mocks.builtIn.mockReset().mockResolvedValue(false);
    mocks.focused.value = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => mocks.focused.value);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("displayProbe", () => {
    it("shares one poll between subscribers and assumes built-in until main answers", async () => {
        const a = vi.fn();
        const b = vi.fn();
        const offA = subscribeDisplayProbe(a);
        const offB = subscribeDisplayProbe(b);
        expect(getDisplayIsLargeSnapshot()).toBe(false);
        expect(mocks.builtIn).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(0);
        expect(getDisplayIsLargeSnapshot()).toBe(true);
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(DISPLAY_POLL_FOCUSED_MS);
        expect(mocks.builtIn).toHaveBeenCalledTimes(2);
        offA();
        offB();
        await vi.advanceTimersByTimeAsync(DISPLAY_POLL_BLURRED_MS);
        expect(mocks.builtIn).toHaveBeenCalledTimes(2);
    });

    it("slows down while blurred and stops while hidden", async () => {
        const off = subscribeDisplayProbe(vi.fn());
        expect(mocks.builtIn).toHaveBeenCalledTimes(1);

        mocks.focused.value = false;
        window.dispatchEvent(new Event("blur"));
        await vi.advanceTimersByTimeAsync(DISPLAY_POLL_BLURRED_MS - 1);
        expect(mocks.builtIn).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(mocks.builtIn).toHaveBeenCalledTimes(2);

        setHidden(true);
        await vi.advanceTimersByTimeAsync(DISPLAY_POLL_BLURRED_MS * 4);
        expect(mocks.builtIn).toHaveBeenCalledTimes(2);

        mocks.focused.value = true;
        setHidden(false);
        expect(mocks.builtIn).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(DISPLAY_POLL_FOCUSED_MS);
        expect(mocks.builtIn).toHaveBeenCalledTimes(4);
        off();
    });
});
