import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/config.js", () => ({
  default: {
    database: {
      url: "postgresql://synthetic.invalid/vision_test",
      poolSize: 1,
      maxOverflow: 1,
    },
    aiResearch: {
      openai: {
        model: "synthetic-model",
        models: [
          {
            id: "synthetic-model",
            label: "Synthetic model",
            inputMicrosPerMillion: 100,
            outputMicrosPerMillion: 200,
          },
        ],
      },
    },
  },
}));

import { disclosurePayload } from "../src/services/aiProviderAdapters.js";
import { evaluateCloudPrivacyTrace } from "../src/services/aiEvaluation/cloudPrivacy.js";
import { CLOUD_PRIVACY_SYNTHETIC_POLICY } from "../src/services/aiEvaluation/cloudPrivacyCases.js";

const preload = fileURLToPath(
  new URL("./fixtures/openai-egress-inspection.mjs", import.meta.url),
);
const helper = fileURLToPath(
  new URL("../src/integrations/openai/egress-helper.mjs", import.meta.url),
);
const privateQuestion = "PRIVATE_ACCOUNT_441 spent at Rare Clinic 184.73";
const privateConstraint = "Do not disclose PRIVATE_ACCOUNT_441";

function requestFor(selection) {
  return {
    question: privateQuestion,
    route: "openai-api",
    publicQuestion:
      selection === "public" ? "Compare public inflation trends" : null,
    model: "synthetic-model",
    depth: "quick",
    language: "en",
    researchMode: "local-only",
    scope: { workspaces: ["research"], constraints: [privateConstraint] },
    publicSymbols: [],
    publicMacroQueries: [],
    selectedSummary:
      selection === "summary" ? "User approved synthetic summary" : null,
    selectedEvidence:
      selection === "evidence"
        ? "Selected synthetic evidence supports a monthly trend."
        : null,
    savedAnalysisId: null,
  };
}

async function runHelper(serialized, mode) {
  const child = spawn(process.execPath, ["--import", preload, helper], {
    env: {
      OPENAI_API_KEY: "synthetic-key",
      VISION_EGRESS_TEST_MODE: mode,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end(JSON.stringify({ body: serialized, timeoutMs: 100 }));
  const exit = await completed;
  const errorText = Buffer.concat(stderr).toString("utf8");
  const events = errorText
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    exit,
    result: JSON.parse(Buffer.concat(stdout).toString("utf8")),
    events,
  };
}

describe("production OpenAI helper in an offline child process", () => {
  it.each([
    ["public", "cloud-plan-public", "Compare public inflation trends"],
    ["summary", "selected-summary", "User approved synthetic summary"],
    [
      "evidence",
      "cloud-synthesis-selected",
      "Selected synthetic evidence supports a monthly trend.",
    ],
  ])("sends only approved %s bytes", async (selection, mode, allowedText) => {
    const preview = disclosurePayload(requestFor(selection));
    const { exit, result, events } = await runHelper(
      preview.serialized,
      "success",
    );

    expect(exit).toEqual({ code: 0, signal: null });
    expect(result).toMatchObject({
      ok: true,
      requestId: "resp_child_synthetic",
    });
    expect(events).toHaveLength(1);
    const request = events[0];
    const sent = Buffer.from(request.bodyBase64, "base64");
    expect(sent.equals(Buffer.from(preview.serialized))).toBe(true);
    expect(request).toMatchObject({
      type: "request",
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      redirect: "error",
      headers: {
        authorization: "Bearer synthetic-key",
        "content-type": "application/json",
      },
    });
    expect(JSON.parse(sent.toString())).toMatchObject({
      store: false,
      background: false,
      tools: [],
    });
    expect(sent.toString()).toContain(allowedText);
    expect(sent.toString()).not.toContain(privateQuestion);
    expect(sent.toString()).not.toContain(privateConstraint);

    const assessment = evaluateCloudPrivacyTrace(
      {
        mode,
        exchanges: [
          {
            sessionId: "synthetic-session",
            analysisId: "synthetic-analysis",
            sequence: 1,
            request: {
              url: request.url,
              method: request.method,
              headers: request.headers,
              bodyBase64: request.bodyBase64,
              byteLength: sent.length,
            },
          },
        ],
        telemetry: [],
      },
      CLOUD_PRIVACY_SYNTHETIC_POLICY,
    );
    expect(assessment).toMatchObject({
      passed: true,
      inspectedRequests: 1,
      inspectedBytes: sent.length,
      violations: [],
    });
  });

  it("aborts one timed-out request without retrying", async () => {
    const preview = disclosurePayload(requestFor("public"));
    const { exit, result, events } = await runHelper(
      preview.serialized,
      "timeout",
    );
    expect(exit).toEqual({ code: 0, signal: null });
    expect(result).toEqual({ ok: false, code: "TIMEOUT" });
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.type)).toEqual(["request", "abort"]);
    expect(events[0].redirect).toBe("error");
  });
});
