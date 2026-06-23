// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { todayLocal, todayYmd, daysBetween } from "@/lib/timezone";

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

  it("daysBetween returns fractional elapsed days", () => {
    const from = new Date(2026, 0, 1, 0, 0, 0);
    const to = new Date(2026, 0, 2, 12, 0, 0); // +1.5 days
    expect(daysBetween(from, to)).toBeCloseTo(1.5, 5);
  });

  it("daysBetween is negative when to precedes from", () => {
    const from = new Date(2026, 0, 3);
    const to = new Date(2026, 0, 1);
    expect(daysBetween(from, to)).toBeCloseTo(-2, 5);
  });
});
