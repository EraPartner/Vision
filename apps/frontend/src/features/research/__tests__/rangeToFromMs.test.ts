import { describe, expect, it } from "vitest";
import { rangeToFromMs } from "@/features/research/useMarketLookupData";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 26);

describe("rangeToFromMs", () => {
    it("maps every research range to a window start", () => {
        expect(rangeToFromMs("1d", NOW)).toBe(NOW - DAY_MS);
        expect(rangeToFromMs("5d", NOW)).toBe(NOW - 5 * DAY_MS);
        expect(rangeToFromMs("1mo", NOW)).toBe(NOW - 30 * DAY_MS);
        expect(rangeToFromMs("3mo", NOW)).toBe(NOW - 91 * DAY_MS);
        expect(rangeToFromMs("6mo", NOW)).toBe(NOW - 182 * DAY_MS);
        expect(rangeToFromMs("1y", NOW)).toBe(NOW - 365 * DAY_MS);
        expect(rangeToFromMs("2y", NOW)).toBe(NOW - 2 * 365 * DAY_MS);
        expect(rangeToFromMs("5y", NOW)).toBe(NOW - 5 * 365 * DAY_MS);
        expect(rangeToFromMs("max", NOW)).toBe(0);
    });
});
