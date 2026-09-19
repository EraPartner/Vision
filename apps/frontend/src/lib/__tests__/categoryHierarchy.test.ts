import { describe, expect, it } from "vitest";
import { matchesCategorySelection } from "@/lib/categoryHierarchy";

describe("matchesCategorySelection", () => {
    it("matches a selected ancestor at any depth", () => {
        const selected = new Set([2]);
        expect(
            matchesCategorySelection(
                { categoryId: 4, categoryPathIds: [1, 2, 3, 4] },
                selected,
            ),
        ).toBe(true);
        expect(
            matchesCategorySelection(
                { categoryId: 5, categoryPathIds: [1, 5] },
                selected,
            ),
        ).toBe(false);
    });

    it("counts an observation once when both ancestor and leaf are selected", () => {
        const selected = new Set([1, 4]);
        expect(
            matchesCategorySelection(
                { categoryId: 4, categoryPathIds: [1, 2, 3, 4] },
                selected,
            ),
        ).toBe(true);
    });

    it("falls back to exact IDs for cached legacy rows and rejects uncategorized rows", () => {
        expect(matchesCategorySelection({ categoryId: 4 }, new Set([4]))).toBe(
            true,
        );
        expect(matchesCategorySelection({ categoryId: 4 }, new Set([1]))).toBe(
            false,
        );
        expect(
            matchesCategorySelection({ categoryId: null }, new Set([1])),
        ).toBe(false);
    });
});
