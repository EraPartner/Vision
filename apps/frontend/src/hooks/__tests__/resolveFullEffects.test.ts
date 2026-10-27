import { describe, expect, it } from "vitest";
import { resolveFullEffects } from "@/hooks/useVisualEffectsTier";

describe("resolveFullEffects", () => {
    it("turns auto on for the standard tier only", () => {
        expect(resolveFullEffects("auto", "standard")).toBe(true);
        expect(resolveFullEffects("auto", "reduced")).toBe(false);
        expect(resolveFullEffects("auto", "enhanced")).toBe(false);
    });

    it("honours an explicit choice on every tier", () => {
        expect(resolveFullEffects("on", "enhanced")).toBe(true);
        expect(resolveFullEffects("off", "standard")).toBe(false);
    });
});
