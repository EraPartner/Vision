import { describe, expect, it } from "vitest";
import {
  APP_TIMEZONE,
  toAppTz,
  toUtc,
  toAppDateString,
  appDateStringToUtc,
  ymdToEpochDay,
  differenceInCalendarDaysYmd,
  addDaysYmd,
} from "../src/lib/timezone.js";

describe("timezone helpers", () => {
  it("defaults to Europe/Brussels when APP_TIMEZONE unset", () => {
    expect(APP_TIMEZONE).toBe("Europe/Brussels");
  });

  it("toAppTz splits UTC instant into zoned components", () => {
    const utc = new Date("2026-03-15T12:30:45Z");
    const zoned = toAppTz(utc, "Europe/Brussels");
    expect(zoned).toEqual({
      year: 2026,
      month: 3,
      day: 15,
      hour: 13,
      minute: 30,
      second: 45,
    });
  });

  it("toUtc round-trips zoned components (winter)", () => {
    const utc = toUtc(
      { year: 2026, month: 1, day: 31, hour: 0 },
      "Europe/Brussels",
    );
    expect(utc.toISOString()).toBe("2026-01-30T23:00:00.000Z");
  });

  it("toUtc round-trips zoned components (summer/DST)", () => {
    const utc = toUtc(
      { year: 2026, month: 7, day: 1, hour: 0 },
      "Europe/Brussels",
    );
    expect(utc.toISOString()).toBe("2026-06-30T22:00:00.000Z");
  });

  it("toUtc handles DST spring-forward boundary", () => {
    const before = toUtc(
      { year: 2026, month: 3, day: 29, hour: 1, minute: 30 },
      "Europe/Brussels",
    );
    const after = toUtc(
      { year: 2026, month: 3, day: 29, hour: 3, minute: 30 },
      "Europe/Brussels",
    );
    expect(after.getTime() - before.getTime()).toBe(60 * 60 * 1000);
  });

  it("toAppDateString formats zoned date", () => {
    const utc = new Date("2026-01-31T23:30:00Z");
    expect(toAppDateString(utc, "Europe/Brussels")).toBe("2026-02-01");
  });

  it("appDateStringToUtc parses date-only as start-of-day in zone", () => {
    const utc = appDateStringToUtc("2026-03-01", "Europe/Brussels");
    expect(utc.toISOString()).toBe("2026-02-28T23:00:00.000Z");
  });

  it("toAppTz normalizes hour=24 by rolling to next day", () => {
    // Midnight UTC on 2026-01-31 = 00:00 Brussels (winter UTC+1) reported as
    // hour=24 by some Intl impls on the prior day. Either way, output must be
    // a valid hour 0..23 with day correctly advanced.
    const utc = new Date("2026-01-31T23:00:00Z"); // 00:00 Brussels Feb 1
    const zoned = toAppTz(utc, "Europe/Brussels");
    expect(zoned.hour).toBeLessThan(24);
    expect(zoned.hour).toBe(0);
    expect(zoned.year).toBe(2026);
    expect(zoned.month).toBe(2);
    expect(zoned.day).toBe(1);
  });

  it("toAppTz handles year boundary at Dec 31 -> Jan 1 rollover", () => {
    const utc = new Date("2026-12-31T23:00:00Z"); // 00:00 Brussels Jan 1 2027
    const zoned = toAppTz(utc, "Europe/Brussels");
    expect(zoned.hour).toBe(0);
    expect(zoned.day).toBe(1);
    expect(zoned.month).toBe(1);
    expect(zoned.year).toBe(2027);
  });

  it("round-trip: UTC -> zoned components -> UTC is identity", () => {
    const input = new Date("2026-07-15T08:45:30Z");
    const zoned = toAppTz(input, "America/New_York");
    const back = toUtc(zoned, "America/New_York");
    expect(back.getTime()).toBe(input.getTime());
  });

  it("computes signed calendar-day differences across DST and leap days", () => {
    expect(differenceInCalendarDaysYmd("2026-03-28", "2026-03-28")).toBe(0);
    expect(differenceInCalendarDaysYmd("2026-03-28", "2026-03-30")).toBe(2);
    expect(differenceInCalendarDaysYmd("2026-03-30", "2026-03-28")).toBe(-2);
    expect(differenceInCalendarDaysYmd("2028-02-28", "2028-03-01")).toBe(2);
    expect(ymdToEpochDay("2026-11-02") - ymdToEpochDay("2026-10-31")).toBe(2);
    expect(differenceInCalendarDaysYmd("2026-12-31", "2027-01-01")).toBe(1);
  });

  it("adds signed calendar days without host timezone or low-year remapping", () => {
    expect(addDaysYmd("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysYmd("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDaysYmd("0099-12-31", 1)).toBe("0100-01-01");
    expect(() => addDaysYmd("2026-02-30", 1)).toThrow(TypeError);
    expect(() => addDaysYmd("2026-02-01", 1.5)).toThrow(TypeError);
  });

  it("rejects malformed, timestamp, out-of-range, and rolled calendar dates", () => {
    for (const value of [
      "2026-2-01",
      "2026-02-01T00:00:00Z",
      "2026-00-01",
      "2026-13-01",
      "2026-02-00",
      "2026-02-30",
    ]) {
      expect(() => ymdToEpochDay(value)).toThrow(TypeError);
    }
  });
});
