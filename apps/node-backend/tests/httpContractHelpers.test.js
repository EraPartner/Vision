import { describe, expect, it } from "vitest";
import { parseBooleanQueryParam } from "../src/lib/httpParams.js";
import { withCreateOutcome } from "../src/lib/createOutcome.js";

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
