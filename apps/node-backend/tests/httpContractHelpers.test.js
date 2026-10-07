import { describe, expect, it } from "vitest";
import {
  optionalQueryString,
  parseBooleanQueryParam,
} from "../src/lib/httpParams.ts";
import { ValidationError } from "../src/middleware/errorHandler.ts";
import { withCreateOutcome } from "../src/lib/createOutcome.ts";

describe("parseBooleanQueryParam", () => {
  it.each([
    ["true", true],
    ["1", true],
    [" TRUE ", true],
    [true, true],
    [1, true],
    ["false", false],
    ["0", false],
    [" FALSE ", false],
    [false, false],
    [0, false],
  ])("normalizes %j to %s", (raw, expected) => {
    expect(parseBooleanQueryParam(raw, !expected)).toBe(expected);
  });

  it.each([undefined, null, "", "yes", "all", ["true", "false"]])(
    "uses the endpoint default for absent or unsupported value %j",
    (raw) => {
      expect(parseBooleanQueryParam(raw, true)).toBe(true);
      expect(parseBooleanQueryParam(raw, false)).toBe(false);
    },
  );
});

describe("withCreateOutcome", () => {
  it.each([true, false])(
    "adds created=%s without losing resource metadata",
    (created) => {
      expect(
        withCreateOutcome({ id: 7 }, created, { reactivated: !created }),
      ).toEqual({
        id: 7,
        reactivated: !created,
        created,
        links: [],
      });
    },
  );
});

describe("optionalQueryString", () => {
  it("returns a single string value and undefined when absent", () => {
    expect(optionalQueryString({ q: "abc" }, "q")).toBe("abc");
    expect(optionalQueryString({ q: "" }, "q")).toBe("");
    expect(optionalQueryString({}, "q")).toBeUndefined();
  });

  it("rejects repeated and bracketed keys with a validation error", () => {
    expect(() => optionalQueryString({ q: ["a", "b"] }, "q")).toThrow(
      ValidationError,
    );
    expect(() => optionalQueryString({ q: { x: "1" } }, "q")).toThrow(
      "q must be a single value",
    );
  });
});
