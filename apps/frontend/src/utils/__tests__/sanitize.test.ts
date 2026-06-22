import { describe, expect, test } from "vitest";
import {
  escapeHtml,
  stripHtml,
  sanitizeFilename,
  sanitizeInput,
  isValidUrl,
  sanitizeNumber,
} from "@/utils/sanitize";

describe("escapeHtml", () => {
  test("escapes all HTML special characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#039;&amp;&#039;&lt;/a&gt;",
    );
  });

  test("leaves plain text untouched", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("stripHtml", () => {
  test("removes simple tags but keeps text", () => {
    expect(stripHtml("<b>bold</b> text")).toBe("bold text");
  });

  test("drops content of nested/adversarial tags", () => {
    // Depth tracking: nothing at depth>0 survives.
    expect(stripHtml("<<a>script>alert</script>")).toBe("alert");
  });

  test("stray closing brackets are dropped without underflowing depth", () => {
    // '>' is never emitted; depth never goes negative, so later text survives.
    expect(stripHtml(">>>kept")).toBe("kept");
    expect(stripHtml("a>b<c>d")).toBe("abd");
  });
});

describe("sanitizeFilename", () => {
  test("replaces unsafe characters with underscores", () => {
    expect(sanitizeFilename("my file/name?.txt")).toBe("my_file_name_.txt");
  });

  test("collapses repeated dots then strips the leading dot", () => {
    // ".." collapses to ".", which as a leading dot becomes "_".
    expect(sanitizeFilename("..hidden")).toBe("_hidden");
  });

  test("keeps an interior collapsed dot", () => {
    expect(sanitizeFilename("a..b")).toBe("a.b");
  });

  test("truncates to 255 characters", () => {
    const long = "a".repeat(300);
    expect(sanitizeFilename(long)).toHaveLength(255);
  });
});

describe("sanitizeInput", () => {
  test("trims, strips html and limits length", () => {
    expect(sanitizeInput("  <b>hi</b>  ")).toBe("hi");
  });

  test("respects custom max length", () => {
    expect(sanitizeInput("abcdef", 3)).toBe("abc");
  });
});

describe("isValidUrl", () => {
  test("accepts http and https", () => {
    expect(isValidUrl("http://example.com")).toBe(true);
    expect(isValidUrl("https://example.com/path")).toBe(true);
  });

  test("rejects other protocols and garbage", () => {
    expect(isValidUrl("javascript:alert(1)")).toBe(false);
    expect(isValidUrl("not a url")).toBe(false);
  });
});

describe("sanitizeNumber", () => {
  test("parses numeric strings", () => {
    expect(sanitizeNumber("42.5")).toBe(42.5);
  });

  test("passes through finite numbers", () => {
    expect(sanitizeNumber(7)).toBe(7);
  });

  test("returns NaN for non-numeric input", () => {
    expect(sanitizeNumber("abc")).toBeNaN();
    expect(sanitizeNumber(Infinity)).toBeNaN();
  });
});
