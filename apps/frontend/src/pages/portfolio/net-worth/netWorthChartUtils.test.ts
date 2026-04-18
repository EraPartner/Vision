import { describe, expect, test } from "vitest";
import { decimateTicks } from "./netWorthChartUtils";

describe("decimateTicks", () => {
  test("returns all ticks when count fits within chart width", () => {
    // Arrange
    const ticks = ["2025-01-01", "2025-02-01", "2025-03-01"];

    // Act
    const result = decimateTicks(ticks, 600, 60);

    // Assert
    expect(result).toEqual(ticks);
  });

  test("keeps first and last tick when decimating", () => {
    // Arrange
    const ticks = Array.from({ length: 24 }, (_, i) => `2024-${String(i % 12 + 1).padStart(2, "0")}-01`);

    // Act
    const result = decimateTicks(ticks, 300, 60);

    // Assert
    expect(result[0]).toBe(ticks[0]);
    expect(result[result.length - 1]).toBe(ticks[ticks.length - 1]);
  });

  test("reduces tick count so each label has at least minLabelPx of space", () => {
    // Arrange
    const ticks = Array.from({ length: 48 }, (_, i) => `tick-${i}`);

    // Act
    const result = decimateTicks(ticks, 300, 60);

    // Assert — 300 / 60 = 5 max labels, plus potential last-tick append
    expect(result.length).toBeLessThanOrEqual(6);
  });

  test("returns input unchanged when length <= 2", () => {
    expect(decimateTicks([], 100, 60)).toEqual([]);
    expect(decimateTicks(["a"], 100, 60)).toEqual(["a"]);
    expect(decimateTicks(["a", "b"], 100, 60)).toEqual(["a", "b"]);
  });

  test("produces more labels when chart width grows (zoom out increases width)", () => {
    // Arrange
    const ticks = Array.from({ length: 36 }, (_, i) => `m-${i}`);

    // Act
    const narrow = decimateTicks(ticks, 400, 60);
    const wide = decimateTicks(ticks, 1600, 60);

    // Assert
    expect(wide.length).toBeGreaterThan(narrow.length);
  });

  test("handles zero or negative chart width without throwing", () => {
    // Arrange
    const ticks = ["a", "b", "c", "d", "e"];

    // Act
    const result = decimateTicks(ticks, 0, 60);

    // Assert — still includes first and last
    expect(result[0]).toBe("a");
    expect(result[result.length - 1]).toBe("e");
  });

  test("does not mutate input array", () => {
    // Arrange
    const ticks = ["a", "b", "c", "d"];
    const snapshot = [...ticks];

    // Act
    decimateTicks(ticks, 100, 60);

    // Assert
    expect(ticks).toEqual(snapshot);
  });
});
