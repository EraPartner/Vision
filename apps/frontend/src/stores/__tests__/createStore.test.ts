// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { create, shallow, useShallow } from "@/stores/createStore";

interface Counter {
    count: number;
    tags: string[];
    inc: () => void;
}

const makeStore = () =>
    create<Counter>((set) => ({
        count: 0,
        tags: ["a"],
        inc: () => set((state) => ({ count: state.count + 1 })),
    }));

describe("create", () => {
    it("merges partial updates and notifies with the previous state", () => {
        const store = makeStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);
        store.getState().inc();
        expect(store.getState().count).toBe(1);
        expect(store.getState().tags).toEqual(["a"]);
        expect(listener).toHaveBeenCalledWith(
            expect.objectContaining({ count: 1 }),
            expect.objectContaining({ count: 0 }),
        );
        unsubscribe();
        store.setState({ count: 5 });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getInitialState().count).toBe(0);
    });

    it("skips listeners for an identical state and replaces when asked", () => {
        const store = makeStore();
        const listener = vi.fn();
        store.subscribe(listener);
        store.setState((state) => state);
        expect(listener).not.toHaveBeenCalled();
        const next = { count: 9, tags: [], inc: () => undefined };
        store.setState(next, true);
        expect(store.getState()).toBe(next);
    });

    it("re-renders hook users on change", () => {
        const store = makeStore();
        const { result } = renderHook(() => store((state) => state.count));
        expect(result.current).toBe(0);
        act(() => store.getState().inc());
        expect(result.current).toBe(1);
    });

    it("keeps a shallow-equal selector result stable with useShallow", () => {
        const store = makeStore();
        const { result } = renderHook(() => store(useShallow((state) => [...state.tags])));
        const first = result.current;
        act(() => store.getState().inc());
        expect(result.current).toBe(first);
        act(() => store.setState({ tags: ["a", "b"] }));
        expect(result.current).toEqual(["a", "b"]);
    });
});

describe("shallow", () => {
    it("compares own entries, arrays, maps and sets", () => {
        expect(shallow({ a: 1 }, { a: 1 })).toBe(true);
        expect(shallow({ a: 1 }, { a: 2 })).toBe(false);
        expect(shallow([1, 2], [1, 2])).toBe(true);
        expect(shallow([1, 2], [1])).toBe(false);
        expect(shallow(new Map([["k", 1]]), new Map([["k", 1]]))).toBe(true);
        expect(shallow(new Set([1]), new Set([2]))).toBe(false);
        expect(shallow({}, [])).toBe(false);
    });
});
