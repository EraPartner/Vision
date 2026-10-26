import { describe, expect, it } from "vitest";
import { looseString } from "../src/lib/looseString.ts";

describe("looseString", () => {
  it("matches String() for primitives", () => {
    expect(looseString("abc")).toBe("abc");
    expect(looseString(12.5)).toBe("12.5");
    expect(looseString(true)).toBe("true");
    expect(looseString(10n)).toBe("10");
    expect(looseString(null)).toBe("null");
    expect(looseString(undefined)).toBe("undefined");
  });

  it("joins arrays with commas and reads nullish elements as empty", () => {
    expect(looseString(["true"])).toBe("true");
    expect(looseString(["a", null, 1, ["b", "c"]])).toBe("a,,1,b,c");
  });

  it("reads other objects by their tag without leaking contents", () => {
    expect(looseString({ a: 1 })).toBe("[object Object]");
  });
});
