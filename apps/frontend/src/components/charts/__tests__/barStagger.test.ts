import { describe, expect, it } from "vitest";
import { barStaggerDelay } from "../barStagger";

describe("barStaggerDelay", () => {
    it("matches index * 15ms up to 80 bars", () => {
        for (const n of [2, 12, 80]) {
            for (let i = 0; i < n; i++) {
                expect(barStaggerDelay(i, n)).toBeCloseTo(i * 0.015, 10);
            }
        }
    });

    it("keeps the whole wave under 1.2s for long series", () => {
        expect(barStaggerDelay(399, 400)).toBeLessThan(1.2);
        expect(barStaggerDelay(399, 400)).toBeCloseTo((399 / 400) * 1.2, 10);
    });

    it("guards empty and single-bar series", () => {
        expect(barStaggerDelay(0, 0)).toBe(0);
        expect(barStaggerDelay(0, 1)).toBe(0);
    });
});
