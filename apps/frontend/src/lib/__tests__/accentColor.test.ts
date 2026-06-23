import { describe, expect, test } from "vitest";
import { hexToHslComponents, accentForegroundComponents } from "@/lib/accentColor";

describe("hexToHslComponents", () => {
  test("converts pure red", () => {
    expect(hexToHslComponents("#ff0000")).toBe("0 100% 50%");
  });

  test("converts pure green", () => {
    expect(hexToHslComponents("00ff00")).toBe("120 100% 50%");
  });

  test("converts pure blue", () => {
    expect(hexToHslComponents("0000ff")).toBe("240 100% 50%");
  });

  test("achromatic grey has 0 saturation", () => {
    expect(hexToHslComponents("#808080")).toBe("0 0% 50%");
  });

  test("ignores trailing alpha bytes", () => {
    expect(hexToHslComponents("ff0000ff")).toBe("0 100% 50%");
  });

  test("returns null for unparseable input", () => {
    expect(hexToHslComponents("xyz")).toBeNull();
    expect(hexToHslComponents("#fff")).toBeNull();
  });
});

describe("accentForegroundComponents", () => {
  test("dark accent gets white foreground", () => {
    expect(accentForegroundComponents("#000000")).toBe("0 0% 100%");
  });

  test("light accent gets dark foreground", () => {
    expect(accentForegroundComponents("#ffff00")).toBe("224 47% 10%");
  });

  test("unparseable input defaults to white", () => {
    expect(accentForegroundComponents("nope")).toBe("0 0% 100%");
  });
});
