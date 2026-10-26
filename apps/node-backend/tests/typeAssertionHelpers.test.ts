/**
 * Narrowing helpers that replaced `as` assertions on caught and parsed values,
 * plus the one behaviour fix found while replacing them (`normalizeToUppercase`
 * returned falsy non-strings unchanged).
 */
import { describe, expect, it } from "vitest";
import {
  errorCode,
  errorMessage,
  isAbortError,
} from "../src/lib/errors.ts";
import { isRecord, isUnknownArray } from "../src/lib/typeGuards.ts";
import { normalizeToUppercase } from "../src/lib/textNormalization.ts";

describe("errorMessage", () => {
  it("reads the message of an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("reads the message of an error-like object", () => {
    expect(errorMessage({ message: "driver said no" })).toBe("driver said no");
  });

  it("stringifies anything else instead of reading undefined off it", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage({ message: 42 })).toBe("[object Object]");
  });
});

describe("errorCode", () => {
  it("returns the code of an error-like object", () => {
    expect(errorCode(Object.assign(new Error("x"), { code: "23503" }))).toBe(
      "23503",
    );
  });

  it("returns undefined for values without a code", () => {
    expect(errorCode(null)).toBeUndefined();
    expect(errorCode("23503")).toBeUndefined();
    expect(errorCode(new Error("x"))).toBeUndefined();
  });
});

describe("isAbortError", () => {
  it("recognises an AbortError by name", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isAbortError(abort)).toBe(true);
  });

  it("rejects other values, including nullish ones", () => {
    expect(isAbortError(new Error("x"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });
});

describe("type guards", () => {
  it("isRecord accepts objects and arrays, not null or primitives", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });

  it("isUnknownArray accepts only arrays", () => {
    expect(isUnknownArray([1, "a"])).toBe(true);
    expect(isUnknownArray({ length: 0 })).toBe(false);
  });
});

describe("normalizeToUppercase falsy non-strings", () => {
  it("keeps null, undefined and the empty string as they are", () => {
    expect(normalizeToUppercase(null)).toBeNull();
    expect(normalizeToUppercase(undefined)).toBeUndefined();
    expect(normalizeToUppercase("")).toBe("");
  });

  it.each([0, false, Number.NaN])(
    "rejects the non-string %s like any other non-string",
    (value) => {
      // Previously the falsy check returned these unchanged, so a caller typed
      // for `string | null | undefined` could receive a number or boolean.
      expect(() => normalizeToUppercase(value)).toThrow(
        /Name must be a string/,
      );
    },
  );
});
