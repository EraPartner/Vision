// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { ShaderAurora } from "@/components/layout/ShaderAurora";
import { must } from "@/test/must";

// jsdom has no WebGL: canvas.getContext('webgl') returns null, which IS the
// component's real failure path — these tests pin down that the fallback
// (CSS blobs keep animating, canvas stays inert) never throws, including
// across staticAtmosphere transitions arriving after a failed init.
describe("ShaderAurora — WebGL-unavailable fallback path", () => {
    it("renders the canvas and survives init without a WebGL context", () => {
        const { container } = render(<ShaderAurora staticAtmosphere={false} blobDrift={false} />);
        const canvas = container.querySelector("canvas");
        expect(canvas).not.toBeNull();
        expect(must(canvas).getAttribute("aria-hidden")).toBe("true");
        expect(document.documentElement).not.toHaveClass("fx-webgl-live");
    });

    it("ignores staticAtmosphere toggles when the context failed (blobs are the fallback)", () => {
        const { rerender } = render(<ShaderAurora staticAtmosphere={false} blobDrift={false} />);
        expect(() => {
            rerender(<ShaderAurora staticAtmosphere={true} blobDrift={false} />);
            rerender(<ShaderAurora staticAtmosphere={false} blobDrift={false} />);
        }).not.toThrow();
    });

    it("unmounts cleanly", () => {
        const { unmount } = render(<ShaderAurora staticAtmosphere={true} blobDrift={false} />);
        expect(() => unmount()).not.toThrow();
        expect(document.documentElement).not.toHaveClass("fx-webgl-live");
    });
});

describe("ShaderAurora live accessibility preference", () => {
    it("stops animation on Reduce Motion, resumes when allowed, and removes the listener", () => {
        const media = new EventTarget() as EventTarget & { matches: boolean };
        media.matches = false;
        const frames = vi.fn(() => 1);
        const cancel = vi.fn();
        const draw = vi.fn();
        const noop = () => undefined;
        const gl = new Proxy(
            {},
            {
                get: (_target, key) =>
                    key === "drawArrays"
                        ? draw
                        : String(key).startsWith("create") ||
                            key === "getUniformLocation"
                          ? () => ({})
                          : key === "getShaderParameter" ||
                              key === "getProgramParameter"
                            ? () => true
                            : key === "getExtension"
                              ? () => null
                              : noop,
            },
        );
        const context = vi
            .spyOn(HTMLCanvasElement.prototype, "getContext")
            .mockReturnValue(gl as never);
        const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
        vi.stubGlobal("matchMedia", () => media);
        vi.stubGlobal("requestAnimationFrame", frames);
        vi.stubGlobal("cancelAnimationFrame", cancel);
        const { unmount } = render(<ShaderAurora staticAtmosphere={false} blobDrift={false} />);
        expect(frames).toHaveBeenCalledOnce();
        act(() => {
            media.matches = true;
            media.dispatchEvent(new Event("change"));
        });
        expect(cancel).toHaveBeenCalled();
        expect(draw).toHaveBeenCalled();
        act(() => {
            media.matches = false;
            media.dispatchEvent(new Event("change"));
        });
        expect(frames).toHaveBeenCalledTimes(2);
        unmount();
        const count = draw.mock.calls.length;
        media.matches = true;
        media.dispatchEvent(new Event("change"));
        expect(draw).toHaveBeenCalledTimes(count);
        context.mockRestore();
        focus.mockRestore();
        vi.unstubAllGlobals();
    });
});
