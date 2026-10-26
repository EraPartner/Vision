// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isAbortError } from "@/lib/api/abortError";

describe("isAbortError", () => {
    it("recognizes a DOMException AbortError and a plain error named AbortError", () => {
        expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(
            true,
        );
        expect(
            isAbortError(Object.assign(new Error("x"), { name: "AbortError" })),
        ).toBe(true);
    });

    it("rejects other errors", () => {
        expect(isAbortError(new Error("boom"))).toBe(false);
        expect(isAbortError(new DOMException("t", "TimeoutError"))).toBe(false);
    });

    it("does not throw on non-object throwables", () => {
        // Regression: `(err as Error).name` threw a TypeError on null/undefined.
        expect(isAbortError(undefined)).toBe(false);
        expect(isAbortError(null)).toBe(false);
        expect(isAbortError("AbortError")).toBe(false);
    });
});
