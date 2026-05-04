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
    window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    window.HTMLElement.prototype.scrollIntoView = () => {};

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
});

afterAll(() => {
    server.close();
});
