import { describe, expect, it } from "vitest";
import { isToolResultPayload } from "../toolResultPayload";

describe("isToolResultPayload", () => {
    it("accepts the stored tool envelope", () => {
        expect(isToolResultPayload({ ok: true, data: [] })).toBe(true);
        expect(isToolResultPayload({ ok: false, error: "boom" })).toBe(true);
    });

    it("rejects NULL, scalars and objects without a boolean ok", () => {
        expect(isToolResultPayload(null)).toBe(false);
        expect(isToolResultPayload(undefined)).toBe(false);
        expect(isToolResultPayload("done")).toBe(false);
        expect(isToolResultPayload({ data: [] })).toBe(false);
        expect(isToolResultPayload({ ok: "yes" })).toBe(false);
    });
});
