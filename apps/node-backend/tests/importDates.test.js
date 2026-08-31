import { describe, expect, it } from "vitest";
import { parsedDateToYmd } from "../src/lib/importDates.js";

describe("parsedDateToYmd", () => {
  it("extracts adapter-created Date values on the UTC calendar", () => {
    expect(parsedDateToYmd(new Date(Date.UTC(2026, 5, 1, 23, 30)))).toBe(
      "2026-06-01",
    );
  });

  it("passes normalized string prefixes and rejects unsupported values", () => {
    expect(parsedDateToYmd("2026-06-01T12:00:00Z")).toBe("2026-06-01");
    expect(parsedDateToYmd(new Date(Number.NaN))).toBeUndefined();
    expect(parsedDateToYmd(0)).toBeUndefined();
  });
});
