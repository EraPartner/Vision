import { describe, expect, it } from "vitest";
import { parseAggregationDateRange } from "../src/lib/aggregationDateRange.js";

describe("parseAggregationDateRange", () => {
  it("returns canonical bounds", () => {
    expect(
      parseAggregationDateRange({
        start_date: "2024-10-01",
        end_date: "2026-09-07",
      }),
    ).toEqual({ startDate: "2024-10-01", endDate: "2026-09-07" });
  });

  it("accepts legacy aliases while canonical keys take precedence", () => {
    expect(
      parseAggregationDateRange({
        start: "2020-01-01",
        end: "2020-12-31",
        start_date: "2024-10-01",
        end_date: "2026-09-07",
      }),
    ).toEqual({ startDate: "2024-10-01", endDate: "2026-09-07" });
  });

  it("rejects malformed and reversed ranges", () => {
    expect(() =>
      parseAggregationDateRange({ start_date: "not-a-date" }),
    ).toThrow(/start_date must be in YYYY-MM-DD format/);
    expect(() =>
      parseAggregationDateRange({
        start_date: "2026-09-08",
        end_date: "2026-09-07",
      }),
    ).toThrow(/start_date must not be after end_date/);
  });
});
