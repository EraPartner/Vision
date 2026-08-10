import { describe, expect, test } from "vitest";
import {
  appDateFormatToDateFnsPattern,
  appLanguageToLocale,
  formatDate,
  formatMonthLabelWithLocale,
  formatMonthYearWithAppSettings,
  formatDateTimeStringWithAppSettings,
  formatDateWithAppSettings,
  formatDateStringWithAppSettings,
  weekStartsOnFromSetting,
} from "./dateUtils";

describe("dateUtils app settings helpers", () => {
  test("maps supported app date formats", () => {
    expect(appDateFormatToDateFnsPattern("DD/MM/YYYY")).toBe("dd/MM/yyyy");
    expect(appDateFormatToDateFnsPattern("MM/DD/YYYY")).toBe("MM/dd/yyyy");
    expect(appDateFormatToDateFnsPattern("YYYY-MM-DD")).toBe("yyyy-MM-dd");
    expect(appDateFormatToDateFnsPattern("DD.MM.YYYY")).toBe("dd.MM.yyyy");
    expect(appDateFormatToDateFnsPattern("DD-MM-YYYY")).toBe("dd-MM-yyyy");
  });

  test("formats a date using selected app date format", () => {
    const sampleDate = new Date(2026, 2, 23); // 2026-03-23
    expect(formatDateWithAppSettings(sampleDate, "DD/MM/YYYY")).toBe("23/03/2026");
    expect(formatDateWithAppSettings(sampleDate, "MM/DD/YYYY")).toBe("03/23/2026");
    expect(formatDateWithAppSettings(sampleDate, "YYYY-MM-DD")).toBe("2026-03-23");
  });

  test("maps start-of-week setting to calendar value", () => {
    expect(weekStartsOnFromSetting("monday")).toBe(1);
    expect(weekStartsOnFromSetting("sunday")).toBe(0);
    expect(weekStartsOnFromSetting(undefined)).toBe(1);
  });

  test("formats date strings using app settings format", () => {
    expect(formatDateStringWithAppSettings("2026-03-23", "DD/MM/YYYY")).toBe("23/03/2026");
    expect(formatDateStringWithAppSettings("2026-03-23T10:30:00Z", "YYYY-MM-DD")).toBe("2026-03-23");
  });

  test("returns original value for unparsable date strings", () => {
    expect(formatDateStringWithAppSettings("not-a-date", "DD/MM/YYYY")).toBe("not-a-date");
  });

  test("formats date-time strings using app date settings", () => {
    expect(formatDateTimeStringWithAppSettings("2026-03-23T10:30:00Z", "YYYY-MM-DD", "en-US")).toMatch(/^2026-03-23\s/);
  });

  test("formats month-year labels semantically by app date format", () => {
    const sampleDate = new Date(2026, 2, 23); // 2026-03-23
    expect(formatMonthYearWithAppSettings(sampleDate, "DD/MM/YYYY", "en-US")).toBe("03/2026");
    expect(formatMonthYearWithAppSettings(sampleDate, "YYYY-MM-DD", "en-US")).toBe("2026-03");
    expect(formatMonthYearWithAppSettings(sampleDate, "DD.MM.YYYY", "en-US")).toBe("03.2026");
    expect(formatMonthYearWithAppSettings(sampleDate, "DD-MM-YYYY", "en-US")).toBe("03-2026");
  });

  test("formats month-only labels via locale helper", () => {
    const sampleDate = new Date(2026, 2, 23); // March
    expect(formatMonthLabelWithLocale(sampleDate, "en-US", "short")).toBe("Mar");
  });
});

describe("appLanguageToLocale", () => {
  test("maps the app languages to month-name locales", () => {
    expect(appLanguageToLocale("nl")).toBe("nl-NL");
    expect(appLanguageToLocale("en")).toBe("en-US");
  });

  test("falls back to English for anything unknown", () => {
    expect(appLanguageToLocale("de")).toBe("en-US");
    expect(appLanguageToLocale("")).toBe("en-US");
  });

  test("is distinct from the number-format locale — 'eu' must not yield German months", () => {
    // numberFormatToLocale('eu') is 'de-DE'; month names must follow the UI
    // language instead, or the Dutch UI renders "Mrz"/"Mai" on its charts.
    const d = new Date(2026, 4, 5); // May 2026
    expect(formatDate(d, "MMM yyyy", appLanguageToLocale("nl"))).toBe("mei 2026");
    expect(formatDate(d, "MMM yyyy", appLanguageToLocale("en"))).toBe("May 2026");
    expect(formatDate(d, "MMM yyyy", "de-DE")).toBe("Mai 2026");
  });
});
