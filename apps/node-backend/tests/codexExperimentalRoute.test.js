import { describe, expect, it } from "vitest";
import { __experimentalAccessDecision as experimentalAccessDecision } from "../src/routes/codexExperimental.js";

describe("experimental Codex access gate", () => {
  const base = {
    flag: "1",
    binary: "/opt/homebrew/bin/codex",
    token: "synthetic-admin-token",
    peer: "127.0.0.1",
  };

  it("requires explicit enablement and an absolute executable path", () => {
    expect(experimentalAccessDecision({ ...base, flag: "0" })).toBe("disabled");
    expect(experimentalAccessDecision({ ...base, binary: "codex" })).toBe(
      "disabled",
    );
  });

  it("requires both a loopback peer and configured admin bearer protection", () => {
    expect(experimentalAccessDecision({ ...base, peer: "192.168.1.3" })).toBe(
      "forbidden",
    );
    expect(experimentalAccessDecision({ ...base, token: undefined })).toBe(
      "unauthorized",
    );
    expect(experimentalAccessDecision(base)).toBe("allowed");
  });
});
