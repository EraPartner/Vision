// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveActiveThemeTokens } from "@/lib/themeTokens";

describe("resolveActiveThemeTokens", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
  });

  test("reports light mode by default", () => {
    expect(resolveActiveThemeTokens().mode).toBe("light");
  });

  test("reports dark mode when the dark class is present", () => {
    document.documentElement.classList.add("dark");
    expect(resolveActiveThemeTokens().mode).toBe("dark");
  });

  test("maps CSS custom properties to report token fields", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (name: string) => {
        const map: Record<string, string> = {
          "--primary": "210 100% 50%",
          "--background": " 0 0% 100% ",
          "--foreground": "224 47% 10%",
          "--chart-1": "12 76% 61%",
        };
        return map[name] ?? "";
      },
    } as unknown as CSSStyleDeclaration);

    const tokens = resolveActiveThemeTokens();
    expect(tokens.primary).toBe("210 100% 50%");
    // surface comes from --background and is trimmed.
    expect(tokens.surface).toBe("0 0% 100%");
    expect(tokens.text).toBe("224 47% 10%");
    expect(tokens.chart1).toBe("12 76% 61%");
    // Unset variables become undefined (empty string → undefined).
    expect(tokens.accent).toBeUndefined();
  });
});
