import "@testing-library/jest-dom";
import { afterAll, afterEach, beforeAll } from "vitest";
import { cleanup } from "@testing-library/react";
import { server } from "./test/msw/server";

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
