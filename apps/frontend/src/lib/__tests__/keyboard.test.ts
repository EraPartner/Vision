// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { isTypingTarget } from "@/lib/keyboard";

describe("isTypingTarget", () => {
  test("returns false for null", () => {
    expect(isTypingTarget(null)).toBe(false);
  });

  test("returns false for non-HTMLElement", () => {
    expect(isTypingTarget({} as EventTarget)).toBe(false);
  });

  test("returns true for input, textarea and select", () => {
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(document.createElement("select"))).toBe(true);
  });

  test("returns true for contentEditable elements", () => {
    const div = document.createElement("div");
    div.contentEditable = "true";
    Object.defineProperty(div, "isContentEditable", { value: true });
    expect(isTypingTarget(div)).toBe(true);
  });

  test("returns false for a plain div", () => {
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
  });
});
