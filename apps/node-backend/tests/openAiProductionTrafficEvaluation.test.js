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

import { executeBrokerRequest } from "../src/integrations/openai/egress-helper.mjs";
import {
  createInspectionFetch,
  evaluateCloudPrivacyTrace,
} from "../src/services/aiEvaluation/cloudPrivacy.js";
import { CLOUD_PRIVACY_SYNTHETIC_POLICY } from "../src/services/aiEvaluation/cloudPrivacyCases.js";
import { disclosurePayload } from "../src/services/aiProviderAdapters.js";

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

function capture(preview, fetchImpl) {
  const exchanges = [];
  const inspectedFetch = createInspectionFetch({
    fetchImpl,
    onExchange: (exchange) => {
      exchange.sessionId = "synthetic-session";
      exchange.analysisId = "synthetic-analysis";
      exchange.sequence = exchanges.length + 1;
      exchanges.push(exchange);
    },
  });
  return {
    exchanges,
    run: () =>
      executeBrokerRequest(
        { body: preview.serialized, timeoutMs: 100 },
        { fetchImpl: inspectedFetch, apiKey: "synthetic-key" },
      ),
  };
}

describe("production OpenAI adapter traffic, offline", () => {
  it.each([
    ["public", "cloud-plan-public", "Compare public inflation trends"],
    ["summary", "selected-summary", "User approved synthetic summary"],
    [
      "evidence",
      "cloud-synthesis-selected",
      "Selected synthetic evidence supports a monthly trend.",
    ],
  ])(
    "inspects exact %s disclosure bytes through the broker",
    async (selection, mode, allowedText) => {
      const preview = disclosurePayload(requestFor(selection));
      const fetchImpl = vi.fn(async () =>
        Response.json({ id: "resp_synthetic", output_text: "{}" }),
      );
      const { exchanges, run } = capture(preview, fetchImpl);

      await expect(run()).resolves.toMatchObject({
        ok: true,
        requestId: "resp_synthetic",
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      const sent = Buffer.from(exchanges[0].request.bodyBase64, "base64");
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(init.redirect).toBe("error");
      expect(init.body).toBe(preview.serialized);
      expect(sent.equals(Buffer.from(preview.serialized))).toBe(true);
      expect(exchanges[0].request.byteLength).toBe(
        Buffer.byteLength(preview.serialized),
      );
      expect(exchanges[0].request.headers).toEqual({
        authorization: "Bearer synthetic-key",
        "content-type": "application/json",
      });
      expect(JSON.parse(sent.toString()).input).toContain(allowedText);
      expect(sent.toString()).not.toContain(privateQuestion);
      expect(sent.toString()).not.toContain(privateConstraint);
      expect(JSON.parse(sent.toString())).toMatchObject({
        store: false,
        background: false,
        tools: [],
      });

      const result = evaluateCloudPrivacyTrace(
        { mode, exchanges, telemetry: [] },
        CLOUD_PRIVACY_SYNTHETIC_POLICY,
      );
      expect(result).toMatchObject({
        passed: true,
        inspectedRequests: 1,
        inspectedBytes: Buffer.byteLength(preview.serialized),
        violations: [],
      });
    },
  );

  it("times out one synthetic request without retrying or redirecting", async () => {
    vi.useFakeTimers();
    try {
      const preview = disclosurePayload(requestFor("public"));
      const fetchImpl = vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );
      const { exchanges, run } = capture(preview, fetchImpl);
      const pending = run();
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toEqual({ ok: false, code: "TIMEOUT" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][1].redirect).toBe("error");
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0].response).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
