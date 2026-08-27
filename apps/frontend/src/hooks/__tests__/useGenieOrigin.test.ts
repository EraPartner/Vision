// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useGenieOrigin } from "@/hooks/useGenieOrigin";

function dialogNode() {
    const node = document.createElement("div");
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
        x: 20,
        y: 50,
        left: 20,
        top: 50,
        right: 220,
        bottom: 150,
        width: 200,
        height: 100,
        toJSON: () => ({}),
    });
    return node;
}

function pointerDown(x: number, y: number) {
    window.dispatchEvent(new MouseEvent("pointerdown", { clientX: x, clientY: y }));
}

afterEach(() => vi.restoreAllMocks());

describe("useGenieOrigin", () => {
    it("sets element-relative exit variables after a recent pointerdown", () => {
        const now = vi.spyOn(performance, "now").mockReturnValue(100);
        pointerDown(120, 90);
        now.mockReturnValue(200);
        const { result } = renderHook(() => useGenieOrigin());
        const node = dialogNode();

        result.current(node);

        expect(node.style.getPropertyValue("--genie-origin")).toBe("100px 40px");
        expect(node.style.getPropertyValue("--genie-scale")).toBe("0.5");
        expect(node.style.getPropertyValue("--genie-y")).toBe("0px");
    });

    it("leaves the neutral fallback intact for a stale pointerdown", () => {
        const now = vi.spyOn(performance, "now").mockReturnValue(100);
        pointerDown(120, 90);
        now.mockReturnValue(1701);
        const { result } = renderHook(() => useGenieOrigin());
        const node = dialogNode();

        result.current(node);

        expect(node.style.getPropertyValue("--genie-origin")).toBe("");
    });

    it("does not set variables before layout has a nonzero size", () => {
        const now = vi.spyOn(performance, "now").mockReturnValue(100);
        pointerDown(120, 90);
        now.mockReturnValue(200);
        const { result } = renderHook(() => useGenieOrigin());
        const node = document.createElement("div");

        result.current(node);

        expect(node.style.getPropertyValue("--genie-origin")).toBe("");
    });
});
