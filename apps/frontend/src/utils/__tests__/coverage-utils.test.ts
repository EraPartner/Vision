/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { onActivateKeyDown } from "@/utils/a11y";
import { getCategoryColor, getCategoryChartColor } from "@/utils/categoryColors";

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
  });

  it("assigns a deterministic chart-token chip to a non-empty category", () => {
    expect(getCategoryColor("FOOD:GROCERIES")).toMatch(/bg-chart-\d/);
    // Same input → same color on every call (stable identity).
    expect(getCategoryColor("FOOD:GROCERIES")).toBe(getCategoryColor("FOOD:GROCERIES"));
  });

  it("colors by the GENERAL part, so DETAIL variations share one hue", () => {
    expect(getCategoryColor("FOOD:GROCERIES")).toBe(getCategoryColor("FOOD:RESTAURANT"));
    expect(getCategoryChartColor("FOOD:GROCERIES")).toBe(getCategoryChartColor("FOOD:DINING"));
  });
});
