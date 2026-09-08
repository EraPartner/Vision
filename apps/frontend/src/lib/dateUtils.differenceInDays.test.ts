import { describe, expect, it } from "vitest";
import { differenceInDays } from "./dateUtils";

describe("differenceInDays", () => {
    it.each([
        [new Date(2026, 2, 1, 23, 59), new Date(2026, 1, 28, 0, 1), 1],
        [new Date(2027, 0, 1, 0, 1), new Date(2026, 11, 31, 23, 59), 1],
        [new Date(2026, 2, 30, 12), new Date(2026, 2, 28, 12), 2],
        [new Date(2026, 9, 26, 12), new Date(2026, 9, 24, 12), 2],
        [new Date(2026, 5, 10, 8), new Date(2026, 5, 12, 20), -2],
    ])(
        "compares local calendar days without elapsed-hour drift",
        (left, right, expected) => {
            expect(differenceInDays(left, right)).toBe(expected);
        },
    );
});
