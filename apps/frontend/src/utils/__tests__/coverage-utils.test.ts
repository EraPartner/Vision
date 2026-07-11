/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { onActivateKeyDown } from "@/utils/a11y";
import { getCategoryColor, getCategoryChartColor, getCategoryColorIndex } from "@/utils/categoryColors";

describe("onActivateKeyDown", () => {
  function evt(key: string, opts: { sameTarget?: boolean } = {}) {
    const sameTarget = opts.sameTarget ?? true;
    const node = {} as HTMLElement;
    return {
      key,
      target: sameTarget ? node : ({} as HTMLElement),
      currentTarget: node,
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent<HTMLElement>;
  }

  it("invokes the handler on Enter and prevents default", () => {
    const handler = vi.fn();
    const e = evt("Enter");
    onActivateKeyDown(handler)(e);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("invokes the handler on Space", () => {
    const handler = vi.fn();
    onActivateKeyDown(handler)(evt(" "));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys", () => {
    const handler = vi.fn();
    const e = evt("a");
    onActivateKeyDown(handler)(e);
    expect(handler).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("ignores events bubbled up from a nested child", () => {
    const handler = vi.fn();
    onActivateKeyDown(handler)(evt("Enter", { sameTarget: false }));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("getCategoryColor", () => {
  it("returns the muted fallback for an empty category", () => {
    expect(getCategoryColor("")).toContain("bg-muted");
    expect(getCategoryColor("   ")).toContain("bg-muted");
  });

  it("assigns a chart-token color to any real category", () => {
    expect(getCategoryColor("FOOD:GROCERIES")).toMatch(/bg-chart-[1-8]\/15/);
    expect(getCategoryColor("anything")).toMatch(/text-chart-[1-8]/);
    // Same input → same color on every call (stable identity).
    expect(getCategoryColor("FOOD:GROCERIES")).toBe(getCategoryColor("FOOD:GROCERIES"));
  });

  it("keys on the GENERAL part — same general, same color, case-insensitive", () => {
    const groceries = getCategoryColor("FOOD:GROCERIES");
    expect(getCategoryColor("FOOD:RESTAURANT")).toBe(groceries);
    expect(getCategoryColor("food : groceries")).toBe(groceries);
    expect(getCategoryColor("FOOD")).toBe(groceries);
    // Chart fills share the hue by GENERAL part too.
    expect(getCategoryChartColor("FOOD:GROCERIES")).toBe(getCategoryChartColor("FOOD:DINING"));
  });

  it("chart fill and badge classes agree on the token index", () => {
    const fill = getCategoryChartColor("FOOD:GROCERIES");
    const index = getCategoryColorIndex("FOOD:GROCERIES");
    expect(fill).toBe(`hsl(var(--chart-${index + 1}))`);
    expect(getCategoryColor("FOOD:GROCERIES")).toContain(`bg-chart-${index + 1}/15`);
  });

  it("chart fill falls back to muted-foreground for empty input", () => {
    expect(getCategoryChartColor("")).toBe("hsl(var(--muted-foreground))");
  });
});
