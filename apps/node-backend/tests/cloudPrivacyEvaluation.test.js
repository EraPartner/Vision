import { describe, expect, it, vi } from "vitest";

import {
  CLOUD_PRIVACY_EVALUATION_CASES,
  CLOUD_PRIVACY_SYNTHETIC_POLICY,
} from "../src/services/aiEvaluation/cloudPrivacyCases.js";
import {
  createInspectionFetch,
  evaluateCloudPrivacyTrace,
} from "../src/services/aiEvaluation/cloudPrivacy.js";

describe("cloud-assistance privacy evaluation", () => {
  it.each(CLOUD_PRIVACY_EVALUATION_CASES)(
    "detects the exact adversarial boundary for $id",
    (testCase) => {
      const result = evaluateCloudPrivacyTrace(
        testCase.trace,
        CLOUD_PRIVACY_SYNTHETIC_POLICY,
      );
      expect(
        [...new Set(result.violations.map((entry) => entry.code))].sort(),
      ).toEqual([...testCase.expectedViolationCodes].sort());
    },
  );

  it("records the exact serialized request and refuses redirect following", async () => {
    const exchanges = [];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const inspectedFetch = createInspectionFetch({
      fetchImpl,
      onExchange: (exchange) => exchanges.push(exchange),
    });
    const body = JSON.stringify({ purpose: "synthetic", amount: 12.34 });

    await inspectedFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(
      Buffer.from(exchanges[0].request.bodyBase64, "base64").toString(),
    ).toBe(body);
    expect(exchanges[0].request.byteLength).toBe(Buffer.byteLength(body));
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("fails closed on non-JSON or uninspectable request bodies", () => {
    const body = "binary-private-payload";
    const result = evaluateCloudPrivacyTrace(
      {
        mode: "cloud-plan",
        exchanges: [
          {
            sessionId: "session-a",
            analysisId: "analysis-a",
            sequence: 1,
            request: {
              url: "https://api.openai.com/v1/responses",
              method: "POST",
              headers: { "content-type": "application/json" },
              bodyBase64: Buffer.from(body).toString("base64"),
              byteLength: Buffer.byteLength(body),
            },
          },
        ],
      },
      CLOUD_PRIVACY_SYNTHETIC_POLICY,
    );

    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "UNINSPECTABLE_BODY" }),
    );
  });

  it("rejects malformed destinations and request byte metadata", () => {
    const body = JSON.stringify({ purpose: "synthetic" });
    const result = evaluateCloudPrivacyTrace(
      {
        mode: "cloud-plan",
        exchanges: [
          {
            sessionId: "session-a",
            analysisId: "analysis-a",
            sequence: 1,
            request: {
              url: "http://[invalid",
              method: "POST",
              headers: { "content-type": "application/json" },
              bodyBase64: Buffer.from(body).toString("base64"),
              byteLength: 0,
            },
          },
        ],
      },
      CLOUD_PRIVACY_SYNTHETIC_POLICY,
    );

    expect(result.passed).toBe(false);
    expect(result.inspectedBytes).toBe(Buffer.byteLength(body));
    expect(result.violations.map((entry) => entry.code)).toEqual([
      "UNINSPECTABLE_URL",
      "BYTE_LENGTH_MISMATCH",
      "NONCANONICAL_URL",
      "BROKER_POLICY_VIOLATION",
    ]);
  });

  it("rejects non-canonical request body encoding", () => {
    const result = evaluateCloudPrivacyTrace(
      {
        mode: "cloud-plan",
        exchanges: [
          {
            sessionId: "session-a",
            analysisId: "analysis-a",
            sequence: 1,
            request: {
              url: "https://api.openai.com/v1/responses",
              method: "POST",
              headers: { "content-type": "application/json" },
              bodyBase64: "%%%",
              byteLength: 0,
            },
          },
        ],
      },
      CLOUD_PRIVACY_SYNTHETIC_POLICY,
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "UNINSPECTABLE_BODY" }),
    );
  });

  it("rejects forbidden field names in request headers", () => {
    const body = JSON.stringify({ purpose: "synthetic" });
    const result = evaluateCloudPrivacyTrace(
      {
        mode: "cloud-plan",
        exchanges: [
          {
            sessionId: "session-a",
            analysisId: "analysis-a",
            sequence: 1,
            request: {
              url: "https://api.openai.com/v1/responses",
              method: "POST",
              headers: {
                "content-type": "application/json",
                accountId: "opaque-value",
              },
              bodyBase64: Buffer.from(body).toString("base64"),
              byteLength: Buffer.byteLength(body),
            },
          },
        ],
      },
      CLOUD_PRIVACY_SYNTHETIC_POLICY,
    );

    expect(result.violations).toContainEqual(
      expect.objectContaining({
        code: "FORBIDDEN_FIELD",
        detail: "header.accountId",
      }),
    );
  });
});
