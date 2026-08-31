import { describe, expect, it } from "vitest";
import {
  bodyFirstParam,
  parseBooleanQueryParam,
} from "../src/lib/httpParams.js";
import { withCreateOutcome } from "../src/lib/createOutcome.js";

describe("bodyFirstParam", () => {
  it("uses a present body value before a conflicting query value", () => {
    expect(
      bodyFirstParam(
        { bank_name: "body" },
        { bank_name: "query" },
        "bank_name",
      ),
    ).toBe("body");
  });

  it.each([false, "", null])("preserves an explicit body value %j", (value) => {
    expect(bodyFirstParam({ force: value }, { force: "true" }, "force")).toBe(
      value,
    );
  });

  it("falls back to the query when the body key is absent", () => {
    expect(bodyFirstParam({}, { force: "true" }, "force")).toBe("true");
  });
});

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
