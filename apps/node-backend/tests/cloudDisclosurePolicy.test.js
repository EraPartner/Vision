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
          {
            id: "synthetic-model-pro",
            label: "Synthetic model pro",
            inputMicrosPerMillion: 300,
            outputMicrosPerMillion: 600,
          },
        ],
      },
    },
  },
}));
import {
  buildDisclosurePreview,
  __canonicalJson,
  validateDisclosureGrant,
} from "../src/services/cloudDisclosurePolicy.js";
import { disclosurePayload } from "../src/services/aiProviderAdapters.js";
import { createHash } from "node:crypto";

describe("cloud disclosure policy", () => {
  it("creates a stable inspectable digest independent of key order", () => {
    const a = buildDisclosurePreview({
      question: "Public inflation outlook?",
      language: "en",
    });
    const b = buildDisclosurePreview({
      language: "en",
      question: "Public inflation outlook?",
    });
    expect(a.payloadSha256).toBe(b.payloadSha256);
    expect(a.serialized).toBe(__canonicalJson(a.payload));
    expect(a.fieldManifest).toEqual(["language", "question"]);
  });
  it("rejects fields outside the typed allowlist", () => {
    expect(() =>
      buildDisclosurePreview({ transactions: [{ amount: 1 }] }),
    ).toThrow(/not eligible/);
  });
  it("binds consent to the exact final OpenAI request bytes", () => {
    const preview = disclosurePayload({
      question: "Public inflation outlook?",
      route: "openai-api",
      publicQuestion: "Public inflation outlook?",
      model: "synthetic-model",
      depth: "quick",
      language: "en",
      researchMode: "local-only",
      scope: { workspaces: ["research"], constraints: [] },
      publicSymbols: [],
      publicMacroQueries: [],
      selectedSummary: null,
      savedAnalysisId: null,
    });
    expect(preview.payload).toMatchObject({
      model: "synthetic-model",
      store: false,
      background: false,
      tools: [],
    });
    expect(preview.payloadSha256).toBe(
      createHash("sha256").update(preview.serialized).digest("hex"),
    );
    expect(preview.serialized).toBe(__canonicalJson(preview.payload));
    expect(preview.inputCharacters).toBe(preview.serialized.length);
  });
  it("rejects a model outside the configured allowlist", () => {
    expect(() =>
      disclosurePayload({
        question: "Public inflation outlook?",
        route: "openai-api",
        publicQuestion: "Public inflation outlook?",
        model: "unapproved-model",
        depth: "quick",
        language: "en",
        researchMode: "local-only",
        scope: { workspaces: ["research"], constraints: [] },
        publicSymbols: [],
        publicMacroQueries: [],
        selectedSummary: null,
        selectedEvidence: null,
        savedAnalysisId: null,
      }),
    ).toThrow(/allowlist/);
  });
  it("binds a model change to a different consent digest", () => {
    const request = {
      question: "Public inflation outlook?",
      route: "openai-api",
      publicQuestion: "Public inflation outlook?",
      depth: "quick",
      language: "en",
      researchMode: "local-only",
      scope: { workspaces: ["research"], constraints: [] },
      publicSymbols: [],
      publicMacroQueries: [],
      selectedSummary: null,
      selectedEvidence: null,
      savedAnalysisId: null,
    };
    const standard = disclosurePayload({
      ...request,
      model: "synthetic-model",
    });
    const pro = disclosurePayload({
      ...request,
      model: "synthetic-model-pro",
    });
    expect(pro.payload.model).toBe("synthetic-model-pro");
    expect(pro.payloadSha256).not.toBe(standard.payloadSha256);
  });
  it("does not allow a private selected summary under the public-plan mode", () => {
    expect(() =>
      validateDisclosureGrant({
        route: "openai-api",
        mode: "cloud-plan-public",
        purpose: "Synthetic test",
        previewHash: "a".repeat(64),
        allowedFields: ["question", "selectedSummary"],
        maxRequests: 1,
        maxInputCharacters: 100,
        maxOutputTokens: 64,
        maxCostMicros: 0,
        maxDisclosureUnits: 2,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        retainExactPayload: false,
      }),
    ).toThrow(/selected-summary/);
  });
  it("never derives public planning text from the private question", () => {
    const preview = disclosurePayload({
      question: "Private SECRET_CANARY_7F3A account question",
      publicQuestion: "Public inflation outlook",
      route: "openai-api",
      model: "synthetic-model",
      depth: "quick",
      language: "en",
      researchMode: "local-only",
      scope: { workspaces: ["research"], constraints: [] },
      publicSymbols: [],
      publicMacroQueries: [],
      selectedSummary: null,
      savedAnalysisId: null,
    });
    expect(preview.disclosedPayload.question).toBe("Public inflation outlook");
    expect(preview.serialized).not.toContain("SECRET_CANARY_7F3A");
  });
  it("discloses only the selected summary in selected-summary mode", () => {
    const preview = disclosurePayload({
      question: "Private question with account: 123",
      route: "openai-api",
      publicQuestion: null,
      model: "synthetic-model",
      depth: "quick",
      language: "en",
      researchMode: "local-only",
      scope: {
        workspaces: ["research"],
        constraints: ["private constraint"],
      },
      publicSymbols: [],
      publicMacroQueries: [],
      selectedSummary: "User-inspected summary",
      savedAnalysisId: null,
    });
    expect(preview.disclosedPayload).toMatchObject({
      selectedSummary: "User-inspected summary",
    });
    expect(preview.disclosedPayload).not.toHaveProperty("question");
    expect(preview.disclosedPayload).not.toHaveProperty("constraints");
  });
  it("sends a scoped token without its local reference value", () => {
    const token = "[[VR1:recipient:AAAAAAAAAAAAAAAAAAAAAAAA]]";
    const preview = disclosurePayload({
      question: "Private recipient name",
      route: "openai-api",
      publicQuestion: null,
      model: "synthetic-model",
      depth: "quick",
      language: "en",
      researchMode: "local-only",
      scope: { workspaces: ["research"], constraints: [] },
      publicSymbols: [],
      publicMacroQueries: [],
      selectedSummary: `Compare ${token}`,
      selectedEvidence: null,
      referenceScopeId: "11111111-1111-4111-8111-111111111111",
      savedAnalysisId: null,
    });
    expect(preview.serialized).toContain(token);
    expect(preview.serialized).not.toContain("Private recipient name");
    expect(preview.serialized).not.toContain("referenceScopeId");
  });
  it("builds a distinct final-synthesis payload from selected evidence", () => {
    const preview = disclosurePayload({
      question: "Private question with account: 123",
      route: "openai-api",
      publicQuestion: null,
      model: "synthetic-model",
      depth: "detailed",
      language: "en",
      researchMode: "local-only",
      scope: { workspaces: ["research"], constraints: [] },
      publicSymbols: [],
      publicMacroQueries: [],
      selectedSummary: null,
      selectedEvidence:
        "Question: Which recipient cost most? Evidence: Recipient A totalled EUR 1200.",
      savedAnalysisId: null,
    });
    expect(preview.disclosedPayload).toMatchObject({
      selectedEvidence:
        "Question: Which recipient cost most? Evidence: Recipient A totalled EUR 1200.",
      citations: ["selected-evidence"],
    });
    expect(preview.disclosedPayload.publicSchema).toContain(
      "selected-evidence synthesis",
    );
    expect(preview.serialized).not.toContain(
      "Private question with account: 123",
    );
  });

  it("requires the dedicated grant mode for selected evidence", () => {
    expect(() =>
      validateDisclosureGrant({
        route: "openai-api",
        mode: "selected-summary",
        purpose: "Synthetic test",
        previewHash: "a".repeat(64),
        allowedFields: ["selectedEvidence"],
        maxRequests: 1,
        maxInputCharacters: 100,
        maxOutputTokens: 64,
        maxCostMicros: 0,
        maxDisclosureUnits: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        retainExactPayload: false,
      }),
    ).toThrow(/cloud-synthesis-selected/);
  });
});
