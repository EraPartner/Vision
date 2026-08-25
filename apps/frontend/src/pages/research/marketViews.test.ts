import { describe, expect, it } from "vitest";

import {
  REGION_OPTIONS,
  REGION_VIEWS,
  SECTOR_OPTIONS,
  SECTOR_VIEWS,
} from "./marketViews";

describe("market view configuration", () => {
  it("keeps region and sector option keys aligned with their view data", () => {
    expect(REGION_OPTIONS.map(({ key }) => key)).toEqual(
      REGION_VIEWS.map(({ key }) => key),
    );
    expect(SECTOR_OPTIONS.map(({ key }) => key)).toEqual([
      "overview",
      ...SECTOR_VIEWS.map(({ key }) => key),
    ]);
  });

  it("keeps view keys unique and every view populated", () => {
    for (const views of [REGION_VIEWS, SECTOR_VIEWS]) {
      const keys = views.map(({ key }) => key);
      expect(new Set(keys).size).toBe(keys.length);
      views.forEach(({ groups }) => {
        expect(groups.flatMap(({ entries }) => entries)).not.toHaveLength(0);
      });
    }
  });
});
