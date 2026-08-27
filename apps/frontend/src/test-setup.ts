import "@testing-library/jest-dom";
import { afterAll, afterEach, beforeAll } from "vitest";
import { cleanup, configure } from "@testing-library/react";
import { server } from "./test/msw/server";

// Warm dynamic-import cache for locales so LanguageProvider's lazy load
// resolves synchronously in tests. Prevents flaky findByText timeouts on
// slower CI runners where the first dynamic import can exceed 1s.
await Promise.all([import("./locales/en"), import("./locales/nl")]);

// CI runners on GitHub Actions are ~3x slower than local. Bump RTL's
// async-utility timeout so findBy*/waitFor calls have headroom for chains
// like loading→fetch→re-render that can exceed the 1s default under load.
configure({ asyncUtilTimeout: 5000 });

// Polyfills for Radix UI in jsdom (jsdom tests only — node-env tests have no window).
if (typeof window !== "undefined") {
    // Node's experimental global localStorage can be present but undefined when
    // no --localstorage-file is configured. It shadows jsdom's implementation
    // in Vitest workers, so install a deterministic per-worker browser store.
    const values = new Map<string, string>();
    const localStorage: Storage = {
        get length() {
            return values.size;
        },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => Array.from(values.keys())[index] ?? null,
        removeItem: (key) => values.delete(key),
        setItem: (key, value) => values.set(key, String(value)),
    };
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: localStorage,
    });

    window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    window.HTMLElement.prototype.scrollIntoView = () => {};

    // jsdom implements window.scrollTo but not Element.prototype.scrollTo, so
    // any component that scrolls its own container (ChatMessageList's
    // follow-the-stream auto-scroll) throws. jsdom does no layout, so a stub
    // that records the requested offset is as faithful as it can get.
    if (typeof Element.prototype.scrollTo !== "function") {
        Element.prototype.scrollTo = function scrollTo(
            this: Element,
            options?: ScrollToOptions | number,
            y?: number,
        ) {
            const top = typeof options === "number" ? y : options?.top;
            const left = typeof options === "number" ? options : options?.left;
            if (typeof top === "number") this.scrollTop = top;
            if (typeof left === "number") this.scrollLeft = left;
        } as typeof Element.prototype.scrollTo;
    }

    // ResizeObserver polyfill — required by @visx/responsive (ParentSize) and other
    // chart libraries that use ResizeObserver. jsdom does not provide this browser API.
    if (typeof window.ResizeObserver === "undefined") {
        window.ResizeObserver = class ResizeObserver {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }
}

beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
    cleanup();
    server.resetHandlers();
    if (typeof localStorage !== "undefined") localStorage.clear();
});

afterAll(() => {
    server.close();
});
