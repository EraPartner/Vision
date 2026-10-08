import { describe, expect, it } from "vitest";
import { allocateEvenly } from "@/features/splits/splitShares";

describe("allocateEvenly", () => {
    it("gives one person the whole amount", () => {
        expect(allocateEvenly(12.34, 1)).toEqual([12.34]);
    });

    it("splits evenly when the cents divide", () => {
        expect(allocateEvenly(30, 3)).toEqual([10, 10, 10]);
    });

    it("hands the leftover cents to the first shares so the total is exact", () => {
        expect(allocateEvenly(10, 3)).toEqual([3.34, 3.33, 3.33]);
        expect(allocateEvenly(10, 6)).toEqual([
            1.67, 1.67, 1.67, 1.67, 1.66, 1.66,
        ]);
        expect(allocateEvenly(0.05, 4)).toEqual([0.02, 0.01, 0.01, 0.01]);
    });

    it("returns nothing for zero or invalid part counts", () => {
        expect(allocateEvenly(10, 0)).toEqual([]);
        expect(allocateEvenly(10, 1.5)).toEqual([]);
    });
});
