import { describe, expect, it } from "vitest";
import { bucketNextSevenDays, WINDOW_DAYS } from "@/features/planned/nextSevenDays";
import type { PlannedPayment } from "@/hooks/usePlannedPayments";

/**
 * The strip's window replaced the "Due this week" stat tile, so it has to keep
 * that tile's semantics exactly: active rows only, the due date parsed as a
 * LOCAL calendar day, and the span `0 <= daysUntilDue <= 7`. The date part is
 * the one with a history in this repo — `new Date("YYYY-MM-DD")` is UTC
 * midnight and lands a day early for anyone east of UTC.
 */

const TODAY = new Date(2026, 7, 14, 13, 45, 0, 0); // 14 Aug 2026, mid-afternoon local

function payment(overrides: Partial<PlannedPayment> & { id: number; due_date: string }): PlannedPayment {
    return {
        name: `Payment ${overrides.id}`,
        amount: -100,
        currency: "EUR",
        is_recurring: false,
        is_active: true,
        created_at: "2026-01-01T00:00:00Z",
        ...overrides,
    } as PlannedPayment;
}

describe("bucketNextSevenDays", () => {
    it("returns today plus the seven days after it, in order", () => {
        const buckets = bucketNextSevenDays([], TODAY);
        expect(buckets).toHaveLength(WINDOW_DAYS);
        expect(buckets.map((b) => b.offset)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(buckets.map((b) => b.date.getDate())).toEqual([14, 15, 16, 17, 18, 19, 20, 21]);
        // Every column is local midnight, so day arithmetic downstream is exact.
        expect(buckets.every((b) => b.date.getHours() === 0 && b.date.getMinutes() === 0)).toBe(true);
    });

    it("puts a payment on its own calendar day, not the day before", () => {
        // The date-shift regression: a UTC-midnight parse pushes 2026-08-16 into
        // the 15th for any timezone east of UTC.
        const [, , sixteenth] = bucketNextSevenDays([payment({ id: 1, due_date: "2026-08-16" })], TODAY);
        expect(sixteenth.items.map((p) => p.id)).toEqual([1]);
    });

    it("accepts an ISO timestamp due date by taking its calendar day", () => {
        const buckets = bucketNextSevenDays(
            [payment({ id: 2, due_date: "2026-08-17T00:00:00.000Z" })],
            TODAY,
        );
        expect(buckets[3].items.map((p) => p.id)).toEqual([2]);
    });

    it("keeps the tile's window: today (0) and +7 are in, −1 and +8 are out", () => {
        const buckets = bucketNextSevenDays(
            [
                payment({ id: 10, due_date: "2026-08-13" }), // yesterday — overdue, out
                payment({ id: 11, due_date: "2026-08-14" }), // today — in
                payment({ id: 12, due_date: "2026-08-21" }), // +7 — in
                payment({ id: 13, due_date: "2026-08-22" }), // +8 — out
            ],
            TODAY,
        );
        const ids = buckets.flatMap((b) => b.items.map((p) => p.id));
        expect(ids).toEqual([11, 12]);
    });

    it("excludes paused rows, exactly as the tile's is_active filter did", () => {
        const buckets = bucketNextSevenDays(
            [
                payment({ id: 20, due_date: "2026-08-15", is_active: false }),
                payment({ id: 21, due_date: "2026-08-15", is_active: true }),
            ],
            TODAY,
        );
        expect(buckets[1].items.map((p) => p.id)).toEqual([21]);
    });

    it("keeps executed rows in the window (the tile counted them too)", () => {
        const buckets = bucketNextSevenDays(
            [payment({ id: 30, due_date: "2026-08-14", is_executed: true })],
            TODAY,
        );
        expect(buckets[0].items.map((p) => p.id)).toEqual([30]);
    });

    it("drops rows with a missing or unparseable due date instead of throwing", () => {
        const buckets = bucketNextSevenDays(
            [
                payment({ id: 40, due_date: "" }),
                payment({ id: 41, due_date: "not-a-date" }),
                payment({ id: 42, due_date: undefined as unknown as string }),
            ],
            TODAY,
        );
        expect(buckets.flatMap((b) => b.items)).toEqual([]);
    });

    it("orders a day's items biggest outflow first", () => {
        const buckets = bucketNextSevenDays(
            [
                payment({ id: 50, due_date: "2026-08-15", amount: -20 }),
                payment({ id: 51, due_date: "2026-08-15", amount: 3000 }),
                payment({ id: 52, due_date: "2026-08-15", amount: -900 }),
            ],
            TODAY,
        );
        expect(buckets[1].items.map((p) => p.id)).toEqual([52, 50, 51]);
    });

    it("spans a month boundary without losing a day", () => {
        const endOfMonth = new Date(2026, 7, 28, 9, 0, 0, 0);
        const buckets = bucketNextSevenDays([payment({ id: 60, due_date: "2026-09-02" })], endOfMonth);
        expect(buckets.map((b) => b.date.getDate())).toEqual([28, 29, 30, 31, 1, 2, 3, 4]);
        expect(buckets[5].items.map((p) => p.id)).toEqual([60]);
    });
});
