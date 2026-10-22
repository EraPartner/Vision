/**
 * Minimal external store with a React hook (ADR-245; replaces `zustand`).
 *
 * Same contract the settings and language stores used from zustand 5:
 * `create<T>(creator)` returns a hook `useStore(selector?)` that also carries
 * `getState`, `setState(partial | updater, replace?)`, `getInitialState` and
 * `subscribe(listener(state, previous))`. `setState` merges objects
 * shallowly unless `replace` is set and skips listeners when the next state is
 * `Object.is`-equal. `useShallow` keeps a selector's previous result while
 * it is shallow-equal, so object/array selectors do not re-render.
 */
import { useCallback, useRef, useSyncExternalStore } from "react";

type Listener<T> = (state: T, previous: T) => void;
type SetState<T> = (
    partial: T | Partial<T> | ((state: T) => T | Partial<T>),
    replace?: boolean,
) => void;

export interface StoreApi<T> {
    setState: SetState<T>;
    getState: () => T;
    getInitialState: () => T;
    subscribe: (listener: Listener<T>) => () => void;
}

/** A state creator; the unused type slots keep zustand's slice signature. */
export type StateCreator<T, _Mutators extends [] = [], _Out extends [] = [], U = T> = (
    set: SetState<T>,
    get: () => T,
    api: StoreApi<T>,
) => U;

export type UseBoundStore<T> = {
    (): T;
    <U>(selector: (state: T) => U): U;
} & StoreApi<T>;

export function createStore<T>(creator: StateCreator<T>): StoreApi<T> {
    let state: T;
    const listeners = new Set<Listener<T>>();
    const setState: SetState<T> = (partial, replace) => {
        const next =
            typeof partial === "function"
                ? (partial as (state: T) => T | Partial<T>)(state)
                : partial;
        if (Object.is(next, state)) return;
        const previous = state;
        state =
            (replace ?? (typeof next !== "object" || next === null))
                ? (next as T)
                : Object.assign({}, state, next);
        listeners.forEach((listener) => listener(state, previous));
    };
    const api: StoreApi<T> = {
        setState,
        getState: () => state,
        getInitialState: () => initialState,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    const initialState = (state = creator(setState, api.getState, api));
    return api;
}

const identity = <T,>(value: T) => value;

export function useStore<T, U>(api: StoreApi<T>, selector: (state: T) => U): U {
    return useSyncExternalStore(
        api.subscribe,
        useCallback(() => selector(api.getState()), [api, selector]),
        useCallback(() => selector(api.getInitialState()), [api, selector]),
    );
}

export function create<T>(creator: StateCreator<T>): UseBoundStore<T> {
    const api = createStore(creator);
    const useBoundStore = <U,>(selector: (state: T) => U = identity as (state: T) => U) =>
        useStore(api, selector);
    return Object.assign(useBoundStore, api);
}

function sameEntries(a: Map<unknown, unknown>, b: Map<unknown, unknown>): boolean {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) if (!b.has(key) || !Object.is(value, b.get(key))) return false;
    return true;
}

/** zustand's `shallow`: same prototype and Object.is-equal own entries or items. */
export function shallow(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    if (Symbol.iterator in a && Symbol.iterator in b) {
        if ("entries" in a && "entries" in b) {
            const toMap = (value: object) =>
                value instanceof Map
                    ? value
                    : new Map((value as { entries(): Iterable<[unknown, unknown]> }).entries());
            return sameEntries(toMap(a), toMap(b));
        }
        const left = (a as Iterable<unknown>)[Symbol.iterator]();
        const right = (b as Iterable<unknown>)[Symbol.iterator]();
        let nextLeft = left.next();
        let nextRight = right.next();
        while (!nextLeft.done && !nextRight.done) {
            if (!Object.is(nextLeft.value, nextRight.value)) return false;
            nextLeft = left.next();
            nextRight = right.next();
        }
        return Boolean(nextLeft.done) && Boolean(nextRight.done);
    }
    return sameEntries(new Map(Object.entries(a)), new Map(Object.entries(b)));
}

export function useShallow<S, U>(selector: (state: S) => U): (state: S) => U {
    const previous = useRef<U | undefined>(undefined);
    return (state) => {
        const next = selector(state);
        if (shallow(previous.current, next)) return previous.current as U;
        previous.current = next;
        return next;
    };
}
