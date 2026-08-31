// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ShaderAurora } from "@/components/layout/ShaderAurora";

// jsdom has no WebGL: canvas.getContext('webgl') returns null, which IS the
// component's real failure path — these tests pin down that the fallback
// (CSS blobs keep animating, canvas stays inert) never throws, including
// across staticAtmosphere transitions arriving after a failed init.
describe("ShaderAurora — WebGL-unavailable fallback path", () => {
    it("renders the canvas and survives init without a WebGL context", () => {
        const { container } = render(<ShaderAurora staticAtmosphere={false} />);
        const canvas = container.querySelector("canvas");
        expect(canvas).not.toBeNull();
        expect(canvas!.getAttribute("aria-hidden")).toBe("true");
        expect(document.documentElement).not.toHaveClass("fx-webgl-live");
    });

    it("ignores staticAtmosphere toggles when the context failed (blobs are the fallback)", () => {
        const { rerender } = render(<ShaderAurora staticAtmosphere={false} />);
        expect(() => {
            rerender(<ShaderAurora staticAtmosphere={true} />);
            rerender(<ShaderAurora staticAtmosphere={false} />);
        }).not.toThrow();
    });

    it("unmounts cleanly", () => {
        const { unmount } = render(<ShaderAurora staticAtmosphere={true} />);
        expect(() => unmount()).not.toThrow();
        expect(document.documentElement).not.toHaveClass("fx-webgl-live");
    });
});
