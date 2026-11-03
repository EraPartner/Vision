// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarDaysUntil, todayLocal, todayYmd } from "@/lib/timezone";

afterEach(() => vi.useRealTimers());

describe("timezone utilities", () => {
  it("todayLocal returns today at local midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 22, 14, 30, 45, 500)); // local 22 Jun 2026 14:30
    const d = todayLocal();
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(22);
  });

  it("todayYmd zero-pads month and day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 9, 0, 0)); // 5 Jan 2026
    expect(todayYmd()).toBe("2026-01-05");
  });

  it("calendarDaysUntil counts calendar days at any time of day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 23, 59)); // 1 Jan 23:59 local
    expect(calendarDaysUntil("2026-01-01")).toBe(0);
    expect(calendarDaysUntil("2026-01-02")).toBe(1);
    expect(calendarDaysUntil("2025-12-30")).toBe(-2);
  });

  it("calendarDaysUntil is not moved by a 23- or 25-hour DST day", () => {
    const previousTz = process.env.TZ;
    process.env.TZ = "Europe/Helsinki";
    try {
      // 25-hour day on 25 Oct 2026: elapsed-hours ceil used to say 3.
      expect(calendarDaysUntil("2026-10-26", new Date(2026, 9, 24, 0, 30))).toBe(2);
      // 23-hour day on 29 Mar 2026: elapsed-hours ceil used to say 1.
      expect(calendarDaysUntil("2026-03-30", new Date(2026, 2, 28, 23, 30))).toBe(2);
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });
});
