// @vitest-environment node
import { describe, expect, it } from "vitest";
import { durations, easings, springs } from "@/lib/motion";

describe("motion tokens", () => {
  it("exposes the expected duration + easing + spring tokens", () => {
    expect(durations.fast).toBeLessThan(durations.page);
    expect(easings.outExpo).toHaveLength(4);
    expect(springs.snappy.type).toBe("spring");
    expect(Object.keys(springs)).toEqual(["snappy"]);
  });
});
