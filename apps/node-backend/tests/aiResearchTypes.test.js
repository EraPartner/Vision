import { describe, expect, it } from "vitest";
import {
  aiAnswerSchema,
  aiInvestigationRequestSchema,
} from "@vision/types/aiResearch";

describe("AI research contracts", () => {
  it("defaults investigations to local-only", () => {
    const parsed = aiInvestigationRequestSchema.parse({
      question: "What changed?",
      scope: { workspaces: ["research"] },
    });
    expect(parsed.route).toBe("local");
    expect(parsed.researchMode).toBe("local-only");
  });
  it("rejects dangling evidence references", () => {
    const answer = {
      schemaVersion: 1,
      status: "complete",
      depth: "quick",
      language: "en",
      summary: "x",
      facts: [{ text: "fact", evidenceIds: ["missing"] }],
      calculations: [],
      interpretations: [],
      assumptions: [],
      missingInformation: [],
      conflicts: [],
      evidence: [],
      analysisReference: null,
    };
    expect(aiAnswerSchema.safeParse(answer).success).toBe(false);
  });
  it("requires a separately authored query for public web research", () => {
    const base = {
      question: "What does my private history imply?",
      researchMode: "public-web",
      scope: { workspaces: ["research"] },
    };
    expect(aiInvestigationRequestSchema.safeParse(base).success).toBe(false);
    expect(
      aiInvestigationRequestSchema.safeParse({
        ...base,
        publicWebQuery: "Belgian inflation outlook 2026",
      }).success,
    ).toBe(true);
  });
  it("requires a separately authored public question for cloud planning", () => {
    const request = {
      question: "Private SECRET_CANARY_7F3A question",
      route: "openai-api",
      scope: { workspaces: ["research"] },
    };
    expect(aiInvestigationRequestSchema.safeParse(request).success).toBe(false);
    const parsed = aiInvestigationRequestSchema.parse({
      ...request,
      publicQuestion: "Public inflation outlook",
    });
    expect(parsed.publicQuestion).toBe("Public inflation outlook");
    expect(parsed.question).toContain("SECRET_CANARY_7F3A");
  });
  it("accepts one selected-evidence cloud input and rejects mixed modes", () => {
    const base = {
      question: "Private recipient question",
      route: "openai-api",
      scope: { workspaces: ["budgeting"] },
    };
    const parsed = aiInvestigationRequestSchema.parse({
      ...base,
      selectedEvidence:
        "Question: Which recipient cost most? Evidence: Recipient A totalled EUR 1200.",
    });
    expect(parsed.selectedEvidence).toContain("Recipient A");
    expect(
      aiInvestigationRequestSchema.safeParse({
        ...base,
        publicQuestion: "Public recipient analysis",
        selectedEvidence: "Approved evidence",
      }).success,
    ).toBe(false);
  });
  it("binds a reversible reference scope to a selected cloud representation", () => {
    const scopeId = "11111111-1111-4111-8111-111111111111";
    expect(
      aiInvestigationRequestSchema.safeParse({
        question: "Local question",
        scope: { workspaces: ["research"] },
        referenceScopeId: scopeId,
      }).success,
    ).toBe(false);
    expect(
      aiInvestigationRequestSchema.safeParse({
        question: "Private question",
        route: "openai-api",
        selectedSummary: "[[VR1:subject:AAAAAAAAAAAAAAAAAAAAAAAA]]",
        referenceScopeId: scopeId,
        scope: { workspaces: ["research"] },
      }).success,
    ).toBe(true);
  });
  it("rejects impossible and reversed scope dates", () => {
    const base = {
      question: "What changed?",
      scope: { workspaces: ["budgeting"] },
    };
    expect(
      aiInvestigationRequestSchema.safeParse({
        ...base,
        scope: { ...base.scope, dateFrom: "2026-02-30" },
      }).success,
    ).toBe(false);
    expect(
      aiInvestigationRequestSchema.safeParse({
        ...base,
        scope: {
          ...base.scope,
          dateFrom: "2026-12-31",
          dateTo: "2026-01-01",
        },
      }).success,
    ).toBe(false);
  });
});
